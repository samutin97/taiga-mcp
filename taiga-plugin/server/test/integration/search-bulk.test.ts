import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { startClient } from "../helpers/mcp-client.js";
import { TaigaAuth } from "../../src/auth.js";
import { TaigaClient } from "../../src/client.js";
import type { TaigaConfig } from "../../src/config.js";
import { resetAttributeCache } from "../../src/custom-attributes.js";

const STAND = "http://localhost:9000";

beforeAll(async () => {
  process.env.TAIGA_URL = STAND;
  process.env.TAIGA_USERNAME = "admin";
  process.env.TAIGA_PASSWORD = "TaigaLocal2026!";
  process.env.TAIGA_PROJECT = "mcp-sandbox";
  const reachable = await fetch(`${STAND}/api/v1/`).then((r) => r.ok).catch(() => false);
  if (!reachable) throw new Error("Local Taiga stand is not running — see infra/README.md");
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const client = await startClient();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  return {
    raw: text,
    json: result.isError ? undefined : JSON.parse(text),
    isError: result.isError === true,
  };
}

/** Refs created by a test, deleted after it whether it passed or failed. */
const createdRefs: number[] = [];
/** Task refs, deleted separately (and first) since tasks reference a story. */
const createdTaskRefs: number[] = [];

function track(ref: number): number {
  createdRefs.push(ref);
  return ref;
}

function trackTask(ref: number): number {
  createdTaskRefs.push(ref);
  return ref;
}

afterEach(async () => {
  while (createdTaskRefs.length > 0) {
    const ref = createdTaskRefs.pop()!;
    try {
      await call("taiga_task_delete", { ref, confirm: true });
    } catch {
      // Best effort: a test may already have deleted it deliberately.
    }
  }
  while (createdRefs.length > 0) {
    const ref = createdRefs.pop()!;
    try {
      await call("taiga_userstory_delete", { ref, confirm: true });
    } catch {
      // Best effort: a test may already have deleted it deliberately.
    }
  }
});

describe("search", () => {
  it("finds seeded items across resource kinds", async () => {
    const { json } = await call("taiga_search", { text: "authenticate" });
    expect(json.count).toBeGreaterThan(0);
    expect(json.userstories.length).toBeGreaterThan(0);
  });

  it("returns an empty result rather than failing", async () => {
    const { json, isError } = await call("taiga_search", { text: "zzzznotfound" });
    expect(isError).toBe(false);
    expect(json.count).toBe(0);
  });

  it("resolves a user story hit's status to a name, not a bare id", async () => {
    // Verified live: /search sends a bare numeric `status` on userstory hits
    // with no status_extra_info companion. The seeded stories all carry a
    // real status, so this is directly exercisable against the stand.
    const { json } = await call("taiga_search", { text: "authenticate" });
    expect(json.userstories.length).toBeGreaterThan(0);
    const hit = json.userstories[0];
    expect(typeof hit.status).toBe("string");
    expect(hit.status.length).toBeGreaterThan(0);
  });

  it("resolves an epic hit's status to a name, not a bare id", async () => {
    // "integration layer" matches only the "MCP integration layer" epic's
    // subject, so this is unambiguous even though other buckets are empty.
    const { json } = await call("taiga_search", { text: "integration layer" });
    expect(json.epics.length).toBeGreaterThan(0);
    const hit = json.epics[0];
    expect(typeof hit.status).toBe("string");
    expect(hit.status.length).toBeGreaterThan(0);
  });

  // Correction 1 (resolving issue priority/severity/type and wikipages'
  // last_modifier to names) is verified at the unit level in
  // test/search.test.ts, not here. Verified live: Taiga 6.9.0's /search
  // endpoint uses a stripped-down per-bucket serializer that never includes
  // those fields at all (issues: id, ref, subject, status, assigned_to only;
  // wikipages: id, slug only) — confirmed by creating an issue with a known
  // priority and searching for it by subject. An integration assertion on
  // those fields here would be vacuous: the fields are always absent, so it
  // would pass whether or not the label-resolution code exists.
});

describe("epic status by name", () => {
  it("accepts and returns a status by name via taiga_epic_update, then restores it", async () => {
    const EPIC_REF = 1; // "MCP integration layer" — seeded, not created by this test.
    const before = await call("taiga_epic_get", { ref: EPIC_REF });
    expect(before.isError).toBe(false);
    const originalStatus = before.json.status as string;

    try {
      const updated = await call("taiga_epic_update", {
        ref: EPIC_REF,
        status: "In progress",
      });
      expect(updated.isError).toBe(false);
      expect(updated.json.status).toBe("In progress");

      const fetched = await call("taiga_epic_get", { ref: EPIC_REF });
      expect(fetched.json.status).toBe("In progress");
    } finally {
      const restored = await call("taiga_epic_update", {
        ref: EPIC_REF,
        status: originalStatus,
      });
      expect(restored.isError).toBe(false);
      expect(restored.json.status).toBe(originalStatus);
    }
  });
});

describe("bulk create", () => {
  it("creates several stories and reports each one", async () => {
    const { json } = await call("taiga_bulk_create", {
      resource: "userstory",
      items: [
        { subject: "Bulk story A" },
        { subject: "Bulk story B", status: "In progress" },
      ],
    });
    for (const item of json.created) track(item.ref as number);

    expect(json.created).toHaveLength(2);
    expect(json.failed).toHaveLength(0);
  });

  it("reports a partial failure without aborting the rest", async () => {
    const { json } = await call("taiga_bulk_create", {
      resource: "userstory",
      items: [
        { subject: "Bulk good" },
        { subject: "Bulk bad", status: "NoSuchStatus" },
      ],
    });
    for (const item of json.created) track(item.ref as number);

    expect(json.created).toHaveLength(1);
    expect(json.failed).toHaveLength(1);
    expect(json.failed[0].error).toMatch(/Valid values/);
  });

  it("still creates items after a failure in the middle of the batch", async () => {
    // The bad item is second of three: if a naive implementation aborted the
    // loop on the first error, the third item would never be created.
    const { json } = await call("taiga_bulk_create", {
      resource: "userstory",
      items: [
        { subject: "Bulk middle-failure first" },
        { subject: "Bulk middle-failure bad", status: "NoSuchStatus" },
        { subject: "Bulk middle-failure third" },
      ],
    });
    for (const item of json.created) track(item.ref as number);

    expect(json.created).toHaveLength(2);
    expect(json.failed).toHaveLength(1);

    const subjects = json.created.map((c: { subject?: string }) => c.subject);
    // Confirm each created item's ref actually resolves in Taiga, not just
    // that the handler reported it as created.
    for (const item of json.created) {
      const fetched = await call("taiga_userstory_get", { ref: item.ref });
      expect(fetched.isError).toBe(false);
    }
    expect(json.failed[0].item.subject).toBe("Bulk middle-failure bad");
    expect(subjects).toEqual(
      expect.arrayContaining(["Bulk middle-failure first", "Bulk middle-failure third"]),
    );
  });

  it("resolves a task's user_story ref the same way a single create does", async () => {
    const parent = await call("taiga_userstory_create", { subject: "Bulk task parent" });
    const parentRef = track(parent.json.ref as number);

    const { json } = await call("taiga_bulk_create", {
      resource: "task",
      items: [{ subject: "Bulk child task", user_story: parentRef }],
    });
    for (const item of json.created) trackTask(item.ref as number);

    expect(json.failed).toHaveLength(0);
    expect(json.created).toHaveLength(1);
    expect(json.created[0].user_story).toBe(parentRef);
  });

  it("refuses more than fifty items", async () => {
    const { raw, isError } = await call("taiga_bulk_create", {
      resource: "userstory",
      items: Array.from({ length: 51 }, (_, i) => ({ subject: `Too many ${i}` })),
    });
    expect(isError).toBe(true);
    expect(raw).toMatch(/50/);
  });

  it("shows issue priority as a name, not a bare id, same as a single create", async () => {
    const { json } = await call("taiga_bulk_create", {
      resource: "issue",
      items: [{ subject: "Bulk issue label check", priority: "High" }],
    });
    try {
      expect(json.failed).toHaveLength(0);
      expect(json.created).toHaveLength(1);
      expect(json.created[0].priority).toBe("High");
    } finally {
      if (json.created[0]?.ref) {
        await call("taiga_issue_delete", { ref: json.created[0].ref, confirm: true });
      }
    }
  });

  // The tool's own description promises parity with taiga_<resource>_create,
  // and taiga-stories-from-spec tells the model that estimates are resolved
  // automatically. Before this fix `points: "5"` was sent as a bare string
  // (an opaque HTTP 500 from Taiga) and `sprint` was an unknown field on the
  // serializer: silently dropped, with the story still reported in `created`.
  describe("sprint and points parity with the single create tool", () => {
    it("lands sprint and points on the created stories, read back from Taiga", async () => {
      const sprints = await call("taiga_sprint_list");
      const sprintName = sprints.json.items[0].name;

      const { json } = await call("taiga_bulk_create", {
        resource: "userstory",
        items: [
          { subject: "Bulk sprint+points A", sprint: sprintName, points: "5" },
          { subject: "Bulk sprint+points B", sprint: sprintName, points: "8" },
        ],
      });
      for (const item of json.created) track(item.ref as number);

      expect(json.failed).toHaveLength(0);
      expect(json.created).toHaveLength(2);

      // Read each story back: the handler's own report is not evidence.
      const first = await call("taiga_userstory_get", { ref: json.created[0].ref });
      expect(first.json.sprint).toBe(sprintName);
      expect(first.json.points).toBe(5);

      const second = await call("taiga_userstory_get", { ref: json.created[1].ref });
      expect(second.json.sprint).toBe(sprintName);
      expect(second.json.points).toBe(8);
    });

    // Regression: taiga_bulk_create built its own, narrower label maps than
    // taiga_userstory_create/_get — missing the `role`/`points` maps a
    // userstory's projection needs for `points_by_role` — so a bulk-created
    // story with per-role points always reported `points_by_role: {}` even
    // though the points landed in Taiga (visible only via a separate
    // taiga_userstory_get). Verified live: bulk-creating with
    // `points: {"Front":"5","Back":"3"}` used to return
    // `{"points": 8, "points_by_role": {}}`.
    it("fills in points_by_role on the create response, matching taiga_userstory_get", async () => {
      const { json } = await call("taiga_bulk_create", {
        resource: "userstory",
        items: [
          { subject: "Bulk points_by_role", points: { Front: "5", Back: "3" } },
        ],
      });
      for (const item of json.created) track(item.ref as number);

      expect(json.failed).toHaveLength(0);
      expect(json.created).toHaveLength(1);
      expect(json.created[0].points).toBe(8);
      expect(json.created[0].points_by_role).toEqual({ Front: 5, Back: 3 });

      const fetched = await call("taiga_userstory_get", { ref: json.created[0].ref });
      expect(fetched.json.points_by_role).toEqual(json.created[0].points_by_role);
    });

    it("isolates a bad sprint name to its own item", async () => {
      const sprints = await call("taiga_sprint_list");
      const sprintName = sprints.json.items[0].name;

      const { json } = await call("taiga_bulk_create", {
        resource: "userstory",
        items: [
          { subject: "Bulk sprint bad", sprint: "No Such Sprint At All" },
          { subject: "Bulk sprint good", sprint: sprintName },
        ],
      });
      for (const item of json.created) track(item.ref as number);

      expect(json.failed).toHaveLength(1);
      expect(json.failed[0].item.subject).toBe("Bulk sprint bad");
      expect(json.created).toHaveLength(1);

      const good = await call("taiga_userstory_get", { ref: json.created[0].ref });
      expect(good.json.sprint).toBe(sprintName);
    });

    it("rejects `points` on an issue item instead of dropping it silently", async () => {
      const { json } = await call("taiga_bulk_create", {
        resource: "issue",
        items: [{ subject: "Bulk issue with points", points: "5" }],
      });
      try {
        expect(json.created).toHaveLength(0);
        expect(json.failed).toHaveLength(1);
        expect(json.failed[0].error).toMatch(/points/i);
      } finally {
        for (const item of json.created) {
          await call("taiga_issue_delete", { ref: item.ref, confirm: true });
        }
      }
    });
  });

  // Decision: taiga_bulk_create silently dropping `epic` (created
  // the story, said nothing, never linked it) was worse than an error, so
  // it now reuses the same link mechanism as taiga_userstory_create. Epic
  // subjects are read from taiga_epic_list rather than hardcoded.
  describe("epic linking", () => {
    it("links every item naming the same epic, resolving it once", async () => {
      const epics = await call("taiga_epic_list");
      const epicSubject = epics.json.items[0].subject;

      const { json } = await call("taiga_bulk_create", {
        resource: "userstory",
        items: [
          { subject: "Bulk epic-link A", epic: epicSubject },
          { subject: "Bulk epic-link B", epic: epicSubject },
        ],
      });
      for (const item of json.created) track(item.ref as number);

      expect(json.failed).toHaveLength(0);
      expect(json.created).toHaveLength(2);

      const filtered = await call("taiga_userstory_list", { epic: epicSubject });
      const linkedRefs = filtered.json.items.map((item: { ref: number }) => item.ref);
      for (const item of json.created) expect(linkedRefs).toContain(item.ref);
    });

    it("isolates a bad epic name to its own item while a good one still links", async () => {
      const epics = await call("taiga_epic_list");
      const epicSubject = epics.json.items[0].subject;

      const { json } = await call("taiga_bulk_create", {
        resource: "userstory",
        items: [
          { subject: "Bulk epic-link bad", epic: "No Such Epic At All" },
          { subject: "Bulk epic-link good", epic: epicSubject },
        ],
      });
      for (const item of json.created) track(item.ref as number);

      expect(json.failed).toHaveLength(1);
      expect(json.failed[0].item.subject).toBe("Bulk epic-link bad");
      expect(json.failed[0].error).toMatch(/No Such Epic At All/);

      expect(json.created).toHaveLength(1);
      expect(json.created[0].subject).toBe("Bulk epic-link good");

      const filtered = await call("taiga_userstory_list", { epic: epicSubject });
      const linkedRefs = filtered.json.items.map((item: { ref: number }) => item.ref);
      expect(linkedRefs).toContain(json.created[0].ref);
    });

    it("rejects an `epic` field on a task item instead of ignoring it", async () => {
      const epics = await call("taiga_epic_list");
      const epicSubject = epics.json.items[0].subject;
      const parent = await call("taiga_userstory_create", { subject: "Bulk task-epic parent" });
      const parentRef = track(parent.json.ref as number);

      const { json } = await call("taiga_bulk_create", {
        resource: "task",
        items: [{ subject: "Bulk task with epic", user_story: parentRef, epic: epicSubject }],
      });
      for (const item of json.created) trackTask(item.ref as number);

      expect(json.created).toHaveLength(0);
      expect(json.failed).toHaveLength(1);
      expect(json.failed[0].error).toMatch(/epic/i);
    });

    it("rejects a non-string `epic` instead of silently treating it as absent", async () => {
      const epics = await call("taiga_epic_list");
      const epicSubject = epics.json.items[0].subject;

      const { json } = await call("taiga_bulk_create", {
        resource: "userstory",
        items: [
          { subject: "Bulk epic-link bad type", epic: 42 },
          { subject: "Bulk epic-link good sibling", epic: epicSubject },
        ],
      });
      for (const item of json.created) track(item.ref as number);

      expect(json.failed).toHaveLength(1);
      expect(json.failed[0].item.subject).toBe("Bulk epic-link bad type");
      expect(json.failed[0].error).toMatch(/epic/i);

      expect(json.created).toHaveLength(1);
      expect(json.created[0].subject).toBe("Bulk epic-link good sibling");

      const filtered = await call("taiga_userstory_list", { epic: epicSubject });
      const linkedRefs = filtered.json.items.map((item: { ref: number }) => item.ref);
      expect(linkedRefs).toContain(json.created[0].ref);
    });
  });
});

// The stand's `mcp-sandbox` project has no «Оценка» task custom field yet.
// This suite creates it through the raw Taiga API before the test runs and
// deletes it afterwards, copying the setup resources.test.ts's "оценка и
// роль задачи" suite already uses rather than writing a second variant.
function adminClient(): TaigaClient {
  const config: TaigaConfig = { url: STAND, username: "admin", password: "TaigaLocal2026!" };
  return new TaigaClient(config, new TaigaAuth(config));
}

describe("bulk create: оценка и роль задач", () => {
  let attributeId: number | undefined;

  beforeAll(async () => {
    const client = adminClient();
    const project = await client.get<{ id: number }>("/projects/by_slug", { slug: "mcp-sandbox" });
    const attribute = await client.post<{ id: number }>("/task-custom-attributes", {
      name: "Оценка",
      project: project.id,
      type: "number",
    });
    attributeId = attribute.id;
  });

  afterAll(async () => {
    if (attributeId === undefined) return;
    await adminClient().remove("/task-custom-attributes", attributeId).catch(() => {});
  });

  it("создаёт задачи с ролью и оценкой за один вызов", async () => {
    const story = await call("taiga_userstory_create", { subject: "Массовые задачи" });
    const ref = track(story.json.ref);
    const result = await call("taiga_bulk_create", {
      resource: "task",
      items: [
        { subject: "Форма", user_story: ref, role: "front", estimate: 2 },
        { subject: "Эндпоинт", user_story: ref, role: "back", estimate: 5 },
      ],
    });
    for (const item of result.json.created) trackTask(item.ref as number);
    expect(result.json.created).toHaveLength(2);
    const detail = await call("taiga_userstory_get", { ref, fields: "full" });
    expect(detail.json.total_points).toBe(7);
  });

  it("не роняет остальные элементы, если запись оценки падает", async () => {
    const story = await call("taiga_userstory_create", { subject: "Массовые задачи без поля" });
    const ref = track(story.json.ref);

    // Delete the attribute for the duration of this one test so the estimate
    // check fails via requireAttribute before the task with `estimate` is
    // created, same as a single taiga_task_create would. attributeIds caches
    // for 60s, so the earlier test's lookup must be evicted or this call
    // would still see the now-deleted field.
    await adminClient().remove("/task-custom-attributes", attributeId!);
    resetAttributeCache();
    try {
      const result = await call("taiga_bulk_create", {
        resource: "task",
        items: [
          { subject: "Без оценки", user_story: ref },
          { subject: "С оценкой", user_story: ref, role: "front", estimate: 2 },
        ],
      });
      for (const item of result.json.created) trackTask(item.ref as number);

      expect(result.json.created).toHaveLength(1);
      expect(result.json.created[0].subject).toBe("Без оценки");
      expect(result.json.failed).toHaveLength(1);
      expect(result.json.failed[0].item.subject).toBe("С оценкой");
      expect(result.json.failed[0].error).toMatch(/Оценка/);
    } finally {
      const client = adminClient();
      const project = await client.get<{ id: number }>("/projects/by_slug", { slug: "mcp-sandbox" });
      const attribute = await client.post<{ id: number }>("/task-custom-attributes", {
        name: "Оценка",
        project: project.id,
        type: "number",
      });
      attributeId = attribute.id;
      // Otherwise the "field is missing" state fetched right after the
      // delete above stays cached for up to 60s, poisoning any later test
      // in this same process even though the field exists again now.
      resetAttributeCache();
    }
  });

  it("нормализует регистр role и пересчёт поинтов всё равно срабатывает", async () => {
    const story = await call("taiga_userstory_create", { subject: "Массовые задачи: регистр роли" });
    const ref = track(story.json.ref);
    const result = await call("taiga_bulk_create", {
      resource: "task",
      items: [{ subject: "Капс роль", user_story: ref, role: "Front", estimate: 2 }],
    });
    for (const item of result.json.created) trackTask(item.ref as number);

    expect(result.json.created).toHaveLength(1);
    expect(result.json.created[0].tags).toContain("front");
    expect(result.json.story_points).toEqual([{ user_story: ref, role: "Front", from: null, to: 2 }]);
  });

  it("отклоняет неизвестную роль со списком допустимых значений", async () => {
    const story = await call("taiga_userstory_create", { subject: "Массовые задачи: неизвестная роль" });
    const ref = track(story.json.ref);
    const result = await call("taiga_bulk_create", {
      resource: "task",
      items: [{ subject: "Плохая роль", user_story: ref, role: "manager" }],
    });
    expect(result.json.created).toHaveLength(0);
    expect(result.json.failed).toHaveLength(1);
    expect(result.json.failed[0].error).toMatch(/front, back, ux, design/);
  });

  it("отклоняет role/estimate у истории и issue, как остальные незнакомые поля", async () => {
    const story = await call("taiga_bulk_create", {
      resource: "userstory",
      items: [{ subject: "Bulk story with role", role: "front" }],
    });
    for (const item of story.json.created) track(item.ref as number);
    expect(story.json.created).toHaveLength(0);
    expect(story.json.failed).toHaveLength(1);
    expect(story.json.failed[0].error).toMatch(/role/i);

    const issue = await call("taiga_bulk_create", {
      resource: "issue",
      items: [{ subject: "Bulk issue with estimate", estimate: 3 }],
    });
    try {
      expect(issue.json.created).toHaveLength(0);
      expect(issue.json.failed).toHaveLength(1);
      expect(issue.json.failed[0].error).toMatch(/estimate/i);
    } finally {
      for (const item of issue.json.created) {
        await call("taiga_issue_delete", { ref: item.ref, confirm: true });
      }
    }
  });
});
