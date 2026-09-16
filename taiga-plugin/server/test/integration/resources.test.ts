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

/** Refs/ids created by a test, deleted after it whether it passed or failed. */
const createdRefs: { resource: string; ref: number }[] = [];

function track(resource: string, ref: number): number {
  createdRefs.push({ resource, ref });
  return ref;
}

afterEach(async () => {
  while (createdRefs.length > 0) {
    const { resource, ref } = createdRefs.pop()!;
    try {
      await call(`taiga_${resource}_delete`, { ref, confirm: true });
    } catch {
      // Best effort: a test may already have deleted it deliberately.
    }
  }
});

describe("all six resources", () => {
  it("registers thirty CRUD tools", async () => {
    const client = await startClient();
    const { tools } = await client.listTools();
    for (const resource of ["userstory", "task", "issue", "epic", "sprint", "wiki"]) {
      for (const action of ["list", "get", "create", "update", "delete"]) {
        expect(tools.map((t) => t.name)).toContain(`taiga_${resource}_${action}`);
      }
    }
  });

  it("lists tasks from the sandbox", async () => {
    const { json } = await call("taiga_task_list");
    expect(json.total).toBeGreaterThanOrEqual(6);
    expect(json.items[0]).toHaveProperty("user_story");
  });

  it("lists issues with priority and severity resolved to names", async () => {
    const { json } = await call("taiga_issue_list");
    expect(json.total).toBeGreaterThanOrEqual(4);
    const names = json.items.map((i: { priority: string }) => i.priority);
    expect(names).toContain("High");
  });

  it("filters issues by severity name", async () => {
    const { json } = await call("taiga_issue_list", { severity: "Important" });
    expect(json.items.length).toBeGreaterThan(0);
  });

  it("lists epics with progress", async () => {
    const { json } = await call("taiga_epic_list");
    expect(json.total).toBe(2);
    expect(json.items[0]).toHaveProperty("stories_total");
  });

  it("lists sprints", async () => {
    const { json } = await call("taiga_sprint_list");
    const names = json.items.map((s: { name: string }) => s.name);
    expect(names).toEqual(expect.arrayContaining(["Sprint 1", "Sprint 2"]));
  });

  it("reads a wiki page by slug", async () => {
    const { json } = await call("taiga_wiki_get", { slug: "home", fields: "full" });
    expect(json.content).toContain("MCP sandbox");
  });

  it("creates and deletes a task under a story", async () => {
    const stories = await call("taiga_userstory_list", { limit: 1 });
    const storyRef = stories.json.items[0].ref;

    const created = await call("taiga_task_create", {
      subject: "Temp task from integration test",
      user_story: storyRef,
    });
    expect(created.json.ref).toBeGreaterThan(0);
    track("task", created.json.ref);

    const deleted = await call("taiga_task_delete", { ref: created.json.ref, confirm: true });
    expect(deleted.isError).toBe(false);
    createdRefs.pop(); // already deleted above
  });

  // Controller Addition 1: issue and wiki must declare label maps so their
  // numeric-id fields (priority/severity/type, last_modifier) reach the model
  // as names, not bare numbers. The issue/priority test above already covers
  // "priority"; this covers wiki's "last_modifier".
  it("resolves a wiki page's last_modifier to a name, not a number", async () => {
    const { json } = await call("taiga_wiki_list");
    const page = json.items.find((p: { slug: string }) => p.slug === "home");
    expect(page).toBeDefined();
    expect(typeof page.last_modifier).toBe("string");
    expect(page.last_modifier.length).toBeGreaterThan(0);
  });

  // Controller Finding 1: taiga_task_list's `user_story` filter must resolve
  // the caller's #ref to the internal id Taiga's own filter actually keys
  // on — otherwise the filter silently returns another story's tasks.
  it("filters tasks by parent story #ref", async () => {
    const all = await call("taiga_task_list");
    const ref = all.json.items[0].user_story;
    expect(typeof ref).toBe("number");

    const filtered = await call("taiga_task_list", { user_story: ref });
    expect(filtered.json.items.length).toBeGreaterThan(0);
    for (const item of filtered.json.items) {
      expect(item.user_story).toBe(ref);
    }
  });

  // Controller Addition 2: a task's parent story is given by #ref in both
  // create and update. This verifies the update path actually moves the
  // task, not just accepts the field silently.
  it("moves a task to a different parent story by #ref", async () => {
    const stories = await call("taiga_userstory_list", { limit: 2 });
    const refs = stories.json.items.map((s: { ref: number }) => s.ref);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    const [firstRef, secondRef] = refs;

    const created = await call("taiga_task_create", {
      subject: "Move test task",
      user_story: firstRef,
    });
    expect(created.isError).toBe(false);
    const ref = track("task", created.json.ref);
    expect(created.json.user_story).toBe(firstRef);

    const updated = await call("taiga_task_update", {
      ref,
      user_story: secondRef,
    });
    expect(updated.isError).toBe(false);
    expect(updated.json.user_story).toBe(secondRef);
  });
});

function adminClient(): TaigaClient {
  const config: TaigaConfig = { url: STAND, username: "admin", password: "TaigaLocal2026!" };
  return new TaigaClient(config, new TaigaAuth(config));
}

// The stand's `mcp-sandbox` project has no «Оценка» task custom field yet.
// This suite creates it through the raw Taiga API before the test runs and
// deletes it afterwards — the plugin itself never creates custom attributes;
// this is test setup only, standing in for Admin → Attributes → Custom
// fields → number.
describe("оценка и роль задачи", () => {
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

  it("оценка задачи поднимает поинты роли у истории", async () => {
    const story = await call("taiga_userstory_create", { subject: "История с задачами" });
    const ref = track("userstory", story.json.ref);

    const first = await call("taiga_task_create", {
      subject: "Вёрстка", user_story: ref, role: "front", estimate: 3,
    });
    track("task", first.json.ref);
    expect(first.json.story_points).toEqual({ role: "Front", from: null, to: 3 });

    const second = await call("taiga_task_create", {
      subject: "Состояния", user_story: ref, role: "front", estimate: 4,
    });
    track("task", second.json.ref);
    // taiga_task_create still returns object (unchanged)
    expect(second.json.story_points).toEqual({ role: "Front", from: 3, to: 8 });

    const detail = await call("taiga_userstory_get", { ref, fields: "full" });
    expect(detail.json.total_points).toBe(8);
  });

  // Fix round 1, item 1: `taiga_task_update({ ref, estimate })` alone used to
  // trip the "Nothing to change" guard, since `estimate` never lands in
  // `changes` — it is written separately via writeAttributes. This proves
  // the primary "I estimated a task" flow works with no other field touched.
  it("оценка задачи через update (без других полей) пересчитывает поинты роли", async () => {
    const story = await call("taiga_userstory_create", { subject: "История: оценка отдельным вызовом" });
    const ref = track("userstory", story.json.ref);

    const created = await call("taiga_task_create", {
      subject: "Бэкенд", user_story: ref, role: "back",
    });
    const taskRef = track("task", created.json.ref);
    expect(created.json.story_points).toBeUndefined();

    const updated = await call("taiga_task_update", { ref: taskRef, estimate: 5 });
    expect(updated.isError).toBe(false);
    // taiga_task_update now always returns an array, even for a single pair
    expect(updated.json.story_points).toEqual([
      { user_story: ref, role: "Back", from: null, to: 5 },
    ]);

    const detail = await call("taiga_userstory_get", { ref, fields: "full" });
    expect(detail.json.total_points).toBe(5);
  });

  // Task 23: taiga_task_get couldn't show what taiga_task_update wrote —
  // a model planning a sprint had no way to see a task's cost. Verifies the
  // full round trip (write via update, read back via get) and that the
  // story-level card never grows an `estimate` key of its own.
  it("оценка, записанная через update, видна в full-карточке задачи", async () => {
    const story = await call("taiga_userstory_create", { subject: "История: оценка видна в get" });
    const ref = track("userstory", story.json.ref);

    const created = await call("taiga_task_create", { subject: "Задача без оценки", user_story: ref });
    const taskRef = track("task", created.json.ref);

    const before = await call("taiga_task_get", { ref: taskRef, fields: "full" });
    expect(before.isError).toBe(false);
    expect(before.json.estimate).toBeNull();

    const updated = await call("taiga_task_update", { ref: taskRef, estimate: 5 });
    expect(updated.isError).toBe(false);

    const after = await call("taiga_task_get", { ref: taskRef, fields: "full" });
    expect(after.json.estimate).toBe(5);

    // «Оценка» is a task-only convention — the parent story's full card must
    // not report an `estimate` key at all.
    const storyDetail = await call("taiga_userstory_get", { ref, fields: "full" });
    expect(storyDetail.json).not.toHaveProperty("estimate");
  });

  // Fix round (final review), Critical 1: taiga_task_update({ role }) used to
  // recompute only the new role, leaving the story's old role at its stale
  // sum — a story could show 5 points for "Front" forever after every front
  // task moved to back. End-to-end version of the crud.test.ts orchestration
  // tests: one task, one story, flip front → back, check both roles.
  it("смена роли задачи front → back пересчитывает поинты обеих ролей у истории", async () => {
    const story = await call("taiga_userstory_create", { subject: "История: смена роли задачи" });
    const ref = track("userstory", story.json.ref);

    const created = await call("taiga_task_create", {
      subject: "Форма заявки", user_story: ref, role: "front", estimate: 5,
    });
    const taskRef = track("task", created.json.ref);
    expect(created.json.story_points).toEqual({ role: "Front", from: null, to: 5 });

    const flipped = await call("taiga_task_update", { ref: taskRef, role: "back" });
    expect(flipped.isError).toBe(false);
    // Both sides of the flip, not just the one the task landed in: Front
    // goes back to 0 (no front tasks left), Back picks up the estimate.
    // taiga_task_update returns an array for all cases (two pairs affected here)
    expect(flipped.json.story_points).toEqual([
      { user_story: ref, role: "Front", from: 5, to: 0 },
      { user_story: ref, role: "Back", from: 0, to: 5 },
    ]);

    const detail = await call("taiga_userstory_get", { ref, fields: "full" });
    expect(detail.json.total_points).toBe(5);
  });
});

describe("taiga_link: блокировка", () => {
  it("блокировка видна с обеих сторон и снимается", async () => {
    const blocker = await call("taiga_userstory_create", { subject: "Готовим API" });
    const from = track("userstory", blocker.json.ref);
    const blocked = await call("taiga_userstory_create", { subject: "Рисуем экран" });
    const to = track("userstory", blocked.json.ref);

    const linked = await call("taiga_link", { from, to, type: "blocks" });
    expect(linked.isError).toBe(false);
    expect(linked.json.from).toEqual({ ref: from, kind: "userstory", subject: "Готовим API" });
    expect(linked.json.to).toEqual({ ref: to, kind: "userstory", subject: "Рисуем экран" });

    const target = await call("taiga_userstory_get", { ref: to, fields: "full" });
    expect(target.json.is_blocked).toBe(true);
    expect(target.json.blocked_note).toContain(`#${from}`);

    const comments = await call("taiga_comment_list", { resource: "userstory", ref: from });
    expect(JSON.stringify(comments.json)).toContain(`#${to}`);

    const removed = await call("taiga_link", { from, to, type: "blocks", remove: true });
    expect(removed.isError).toBe(false);
    const after = await call("taiga_userstory_get", { ref: to, fields: "full" });
    expect(after.json.is_blocked).toBe(false);

    const comments2 = await call("taiga_comment_list", { resource: "userstory", ref: from });
    expect(JSON.stringify(comments2.json)).toContain("Разблокировал");
  });

  it("карточка показывает, что её блокирует", async () => {
    const blocker = await call("taiga_userstory_create", { subject: "Сначала API" });
    const from = track("userstory", blocker.json.ref);
    const blocked = await call("taiga_userstory_create", { subject: "Потом экран" });
    const to = track("userstory", blocked.json.ref);
    await call("taiga_link", { from, to, type: "blocks" });

    const target = await call("taiga_userstory_get", { ref: to, fields: "full" });
    expect(target.json.blocked_by).toContain(from);

    // No «Блокирует» field in this project yet: `blocks` is an honest empty
    // list, not a guess derived from something else.
    const source = await call("taiga_userstory_get", { ref: from, fields: "full" });
    expect(source.json.blocks).toEqual([]);
  });

  it("резолвит любую комбинацию истории и задачи", async () => {
    const story = await call("taiga_userstory_create", { subject: "История-блокер" });
    const from = track("userstory", story.json.ref);
    const task = await call("taiga_task_create", { subject: "Задача-получатель" });
    const to = track("task", task.json.ref);

    const linked = await call("taiga_link", { from, to, type: "blocks" });
    expect(linked.json.from.kind).toBe("userstory");
    expect(linked.json.to.kind).toBe("task");

    const target = await call("taiga_task_get", { ref: to, fields: "full" });
    expect(target.json.is_blocked).toBe(true);
    expect(target.json.blocked_note).toContain(`#${from}`);

    const comments = await call("taiga_comment_list", { resource: "userstory", ref: from });
    expect(JSON.stringify(comments.json)).toContain(`#${to}`);
  });
});

// The stand's `mcp-sandbox` project has no link custom fields yet. This
// suite creates «Блокируется»/«Блокирует»/«Связано с» through the raw Taiga
// API before the test runs and deletes them afterwards — the same pattern
// «Оценка» uses above — so taiga_link's custom-field path (not just the
// flag/note/comment fallback) gets exercised on the live stand too.
describe("taiga_link с полями «Блокируется»/«Блокирует»/«Связано с»", () => {
  let blockedAttrId: number | undefined;
  let blockerAttrId: number | undefined;
  let relatedAttrId: number | undefined;

  beforeAll(async () => {
    const client = adminClient();
    const project = await client.get<{ id: number }>("/projects/by_slug", { slug: "mcp-sandbox" });
    blockedAttrId = (await client.post<{ id: number }>("/userstory-custom-attributes", {
      name: "Блокируется", project: project.id, type: "text",
    })).id;
    blockerAttrId = (await client.post<{ id: number }>("/userstory-custom-attributes", {
      name: "Блокирует", project: project.id, type: "text",
    })).id;
    relatedAttrId = (await client.post<{ id: number }>("/userstory-custom-attributes", {
      name: "Связано с", project: project.id, type: "text",
    })).id;
    // attributeIds() caches project+resource attribute lists for a minute;
    // earlier tests in this file already primed an empty userstory list.
    resetAttributeCache();
  });

  afterAll(async () => {
    const client = adminClient();
    for (const id of [blockedAttrId, blockerAttrId, relatedAttrId]) {
      if (id !== undefined) await client.remove("/userstory-custom-attributes", id).catch(() => {});
    }
    resetAttributeCache();
  });

  it("дописывает ссылки в «Блокируется» и «Блокирует»", async () => {
    const blocker = await call("taiga_userstory_create", { subject: "Блокер с полями" });
    const from = track("userstory", blocker.json.ref);
    const blocked = await call("taiga_userstory_create", { subject: "Заблокированный с полями" });
    const to = track("userstory", blocked.json.ref);

    const linked = await call("taiga_link", { from, to, type: "blocks" });
    expect(linked.json.changed).toEqual(expect.arrayContaining(["to:Блокируется", "from:Блокирует"]));

    const client = adminClient();
    const toDetail = await call("taiga_userstory_get", { ref: to, fields: "full" });
    const toValues = await client.get<{ attributes_values: Record<string, unknown> }>(
      `/userstories/custom-attributes-values/${toDetail.json.id}`,
    );
    expect(toValues.attributes_values[String(blockedAttrId)]).toBe(`#${from}`);
    expect(toDetail.json.blocked_by).toEqual([from]);

    const fromDetail = await call("taiga_userstory_get", { ref: from, fields: "full" });
    const fromValues = await client.get<{ attributes_values: Record<string, unknown> }>(
      `/userstories/custom-attributes-values/${fromDetail.json.id}`,
    );
    expect(fromValues.attributes_values[String(blockerAttrId)]).toBe(`#${to}`);
    expect(fromDetail.json.blocks).toEqual([to]);
  });

  // The note is the source of truth even when «Блокируется» exists (task
  // 10's rule, binding here too): a ref that only ever landed in the field —
  // say, someone hand-edited it in Taiga's UI — must not resurrect a link
  // the note never recorded.
  it("примечание решает: посторонняя ссылка в поле не попадает в blocked_by", async () => {
    const blocker = await call("taiga_userstory_create", { subject: "Блокер (нота решает)" });
    const from = track("userstory", blocker.json.ref);
    const blocked = await call("taiga_userstory_create", { subject: "Заблокированный (нота решает)" });
    const to = track("userstory", blocked.json.ref);
    const stray = await call("taiga_userstory_create", { subject: "Посторонняя история" });
    const strayRef = track("userstory", stray.json.ref);

    const linked = await call("taiga_link", { from, to, type: "blocks" });
    expect(linked.isError).toBe(false);

    const client = adminClient();
    const toDetail = await call("taiga_userstory_get", { ref: to, fields: "full" });
    const current = await client.get<{ attributes_values: Record<string, unknown> }>(
      `/userstories/custom-attributes-values/${toDetail.json.id}`,
    );
    await client.patch("/userstories/custom-attributes-values", toDetail.json.id, {
      attributes_values: {
        ...current.attributes_values,
        [String(blockedAttrId)]: `#${from}, #${strayRef}`,
      },
    });

    const after = await call("taiga_userstory_get", { ref: to, fields: "full" });
    expect(after.json.blocked_by).toEqual([from]);
  });

  it("пишет ссылки в «Связано с» обеим сторонам", async () => {
    const first = await call("taiga_userstory_create", { subject: "Первая связанная" });
    const from = track("userstory", first.json.ref);
    const second = await call("taiga_userstory_create", { subject: "Вторая связанная" });
    const to = track("userstory", second.json.ref);

    const linked = await call("taiga_link", { from, to, type: "relates" });
    expect(linked.json.hint).toBeUndefined();
    expect(linked.json.changed.sort()).toEqual(["from:Связано с", "to:Связано с"]);

    const client = adminClient();
    const fromDetail = await call("taiga_userstory_get", { ref: from, fields: "full" });
    const fromValues = await client.get<{ attributes_values: Record<string, unknown> }>(
      `/userstories/custom-attributes-values/${fromDetail.json.id}`,
    );
    expect(fromValues.attributes_values[String(relatedAttrId)]).toBe(`#${to}`);
  });
});
