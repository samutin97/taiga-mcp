import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { startClient } from "../helpers/mcp-client.js";

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

function track(ref: number): number {
  createdRefs.push(ref);
  return ref;
}

afterEach(async () => {
  while (createdRefs.length > 0) {
    const ref = createdRefs.pop()!;
    try {
      await call("taiga_userstory_delete", { ref, confirm: true });
    } catch {
      // Best effort: a test may already have deleted it deliberately.
    }
  }
});

describe("user story CRUD", () => {
  it("lists stories in slim form", async () => {
    const { json } = await call("taiga_userstory_list");
    expect(json.total).toBeGreaterThanOrEqual(9);
    const first = json.items[0];
    expect(Object.keys(first).sort()).toEqual(
      [
        "assigned_to", "is_blocked", "is_closed", "points", "ref",
        "sprint", "status", "subject", "tags", "total_comments",
      ].sort(),
    );
  });

  it("keeps a nine-story listing under the spec's 500-token target", async () => {
    // The spec (§7) targets 500 tokens for this listing. The shipped
    // assertion was 800 only to accommodate pretty-printing the response
    // with an indent, which cost 44% of every payload the plugin returns.
    const { raw } = await call("taiga_userstory_list", { limit: 9 });
    expect(raw.length / 4).toBeLessThan(500);
  });

  it("filters by status name", async () => {
    const { json } = await call("taiga_userstory_list", { status: "In progress" });
    expect(json.items.length).toBeGreaterThan(0);
    for (const item of json.items) expect(item.status).toBe("In progress");
  });

  it("lists valid statuses when the filter name is wrong", async () => {
    const { raw, isError } = await call("taiga_userstory_list", { status: "Nope" });
    expect(isError).toBe(true);
    expect(raw).toMatch(/Valid values:.*In progress/);
  });

  it("in_backlog returns only sprint-less stories, strictly fewer than everything", async () => {
    const all = await call("taiga_userstory_list", { limit: 200 });
    const backlog = await call("taiga_userstory_list", { in_backlog: true, limit: 200 });

    expect(backlog.isError).toBe(false);
    // Not hardcoded to the sandbox's current numbers: just that filtering
    // narrows the result, and every item it keeps genuinely has no sprint.
    expect(backlog.json.items.length).toBeGreaterThan(0);
    expect(backlog.json.items.length).toBeLessThan(all.json.items.length);
    for (const item of backlog.json.items) {
      expect(item.sprint).toBeNull();
    }
  });

  it("says what was looked for when a #ref does not exist", async () => {
    // Taiga's /resolver answers a miss with HTTP 404 and an EMPTY
    // `_error_message`, which used to arrive as an empty tool result: an
    // error with no text at all, on the addressing mode the skills teach.
    const { raw, isError } = await call("taiga_userstory_get", { ref: 99999 });
    expect(isError).toBe(true);
    expect(raw.trim()).not.toBe("");
    expect(raw).toContain("99999");
    expect(raw).toContain("mcp-sandbox");
  });

  it("refuses `sprint` and `in_backlog: true` together instead of honouring one", async () => {
    // Both write params.milestone; whichever the filter loop reached last
    // won, and the caller was never told the other had been discarded.
    const sprints = await call("taiga_sprint_list");
    const sprintName = sprints.json.items[0].name;
    const { raw, isError } = await call("taiga_userstory_list", {
      sprint: sprintName,
      in_backlog: true,
    });
    expect(isError).toBe(true);
    expect(raw).toMatch(/in_backlog/);
  });

  it("moves a story into a sprint and back to the backlog with an empty string", async () => {
    const sprints = await call("taiga_sprint_list");
    const sprintName = sprints.json.items[0].name;

    const created = await call("taiga_userstory_create", {
      subject: "Sprint clear test",
      sprint: sprintName,
    });
    const ref = track(created.json.ref);

    expect(created.json.sprint).toBe(sprintName);

    const cleared = await call("taiga_userstory_update", { ref, sprint: "" });
    expect(cleared.isError).toBe(false);

    // Read it back rather than trusting the update response.
    const after = await call("taiga_userstory_get", { ref });
    expect(after.json.sprint).toBeNull();
  });

  it("unassigns a story with an empty assigned_to", async () => {
    const schema = await call("taiga_project_schema");
    const member = schema.json.lookups.member[0].name;

    const created = await call("taiga_userstory_create", {
      subject: "Unassign test",
      assigned_to: member,
    });
    const ref = track(created.json.ref);

    expect(created.json.assigned_to).toBe(member);

    const cleared = await call("taiga_userstory_update", { ref, assigned_to: "" });
    expect(cleared.isError).toBe(false);

    const after = await call("taiga_userstory_get", { ref });
    expect(after.json.assigned_to).toBeNull();
  });

  it("clears a due date with an empty string", async () => {
    const created = await call("taiga_userstory_create", {
      subject: "Due date clear test",
      due_date: "2026-12-31",
    });
    const ref = track(created.json.ref);

    const withDate = await call("taiga_userstory_get", { ref, fields: "full" });
    expect(withDate.json.due_date).toBe("2026-12-31");

    const cleared = await call("taiga_userstory_update", { ref, due_date: "" });
    expect(cleared.isError).toBe(false);

    const after = await call("taiga_userstory_get", { ref, fields: "full" });
    expect(after.json.due_date).toBeNull();
  });

  it("returns names, not bare ids, for an explicit fields list", async () => {
    const { json, isError } = await call("taiga_issue_list", {
      fields: ["ref", "priority", "status"],
      limit: 1,
    });
    expect(isError).toBe(false);
    const first = json.items[0];
    expect(typeof first.priority).toBe("string");
    expect(typeof first.status).toBe("string");
    expect(typeof first.ref).toBe("number");
  });

  it("creates, reads by ref, updates and deletes a story", async () => {
    const created = await call("taiga_userstory_create", {
      subject: "Temp story from integration test",
      status: "New",
      tags: ["temp"],
    });
    expect(created.json.ref).toBeGreaterThan(0);
    const ref = track(created.json.ref);

    const fetched = await call("taiga_userstory_get", { ref });
    expect(fetched.json.subject).toBe("Temp story from integration test");

    const updated = await call("taiga_userstory_update", {
      ref,
      status: "In progress",
    });
    expect(updated.json.status).toBe("In progress");

    const refused = await call("taiga_userstory_delete", { ref });
    expect(refused.isError).toBe(true);
    expect(refused.raw).toMatch(/confirm/i);

    const deleted = await call("taiga_userstory_delete", { ref, confirm: true });
    expect(deleted.isError).toBe(false);

    const gone = await call("taiga_userstory_get", { ref });
    expect(gone.isError).toBe(true);
  });

  it("appends to the description instead of overwriting", async () => {
    const created = await call("taiga_userstory_create", {
      subject: "Append test",
      description: "First line.",
    });
    const ref = track(created.json.ref);

    await call("taiga_userstory_update", { ref, append_description: "Second line." });
    const after = await call("taiga_userstory_get", { ref, fields: "full" });
    expect(after.json.description).toContain("First line.");
    expect(after.json.description).toContain("Second line.");
  });

  it("uses a same-call description as the append base, not the old server value", async () => {
    const created = await call("taiga_userstory_create", {
      subject: "Update+append precedence test",
      description: "First line.",
    });
    const ref = track(created.json.ref);

    await call("taiga_userstory_update", {
      ref,
      description: "Replaced.",
      append_description: "Added.",
    });

    const after = await call("taiga_userstory_get", { ref, fields: "full" });
    expect(after.json.description).toContain("Replaced.");
    expect(after.json.description).toContain("Added.");
    expect(after.json.description).not.toContain("First line.");
  });

  it("uses a same-call tags value as the base when adding tags, not the old server value", async () => {
    const created = await call("taiga_userstory_create", {
      subject: "Update+add_tags precedence test",
      tags: ["old"],
    });
    const ref = track(created.json.ref);

    const updated = await call("taiga_userstory_update", {
      ref,
      tags: ["replaced"],
      add_tags: ["added"],
    });

    expect(updated.json.tags.sort()).toEqual(["added", "replaced"]);
    expect(updated.json.tags).not.toContain("old");
  });

  // The next two tests cover real Taiga API behavior the brief did not anticipate
  // (verified live against the sandbox before implementing — see task-7-report.md):
  //
  // - Sending `epic` as a subject string straight through to Taiga's list filter
  //   returns an HTTP 500 (Taiga expects a numeric epic id).
  // - Sending `points` as a bare string or number to create/update also returns
  //   an HTTP 500 (Taiga stores points as a per-role map, not a scalar).

  it("filters by epic subject", async () => {
    const { json, isError } = await call("taiga_userstory_list", {
      epic: "MCP integration layer",
    });
    expect(isError).toBe(false);
    expect(json.items.length).toBeGreaterThan(0);
  });

  it("sets story points without crashing Taiga", async () => {
    const created = await call("taiga_userstory_create", {
      subject: "Points test",
      points: "5",
    });
    expect(created.isError).toBe(false);
    const ref = track(created.json.ref);
    expect(created.json.points).toBe(5);

    const updated = await call("taiga_userstory_update", { ref, points: "8" });
    expect(updated.isError).toBe(false);
    expect(updated.json.points).toBe(8);
  });
});

// Taiga models story-to-epic linking as its own many-to-many resource
// (POST/DELETE /epics/{epicId}/related_userstories), not a field on the
// story — confirmed live against this stand before writing the tool code
// (see task-13-report.md). The `epic` field on taiga_userstory_create and
// taiga_userstory_update hides that behind the same human-name convention
// as every other field. Epic subjects are read from taiga_epic_list rather
// than hardcoded, since the sandbox's two epics are project fixtures.
describe("epic linking", () => {
  it("links a newly created story to an epic via the `epic` field", async () => {
    const epics = await call("taiga_epic_list");
    expect(epics.json.items.length).toBeGreaterThanOrEqual(1);
    const epicSubject = epics.json.items[0].subject;

    const created = await call("taiga_userstory_create", {
      subject: "Epic-link-on-create test",
      epic: epicSubject,
    });
    expect(created.isError).toBe(false);
    const ref = track(created.json.ref);

    const filtered = await call("taiga_userstory_list", { epic: epicSubject });
    expect(filtered.isError).toBe(false);
    expect(filtered.json.items.map((item: { ref: number }) => item.ref)).toContain(ref);
  });

  it("links an existing story to an epic via `epic` on update", async () => {
    const epics = await call("taiga_epic_list");
    expect(epics.json.items.length).toBeGreaterThanOrEqual(2);
    const epicSubject = epics.json.items[1].subject;

    const created = await call("taiga_userstory_create", {
      subject: "Epic-link-on-update test",
    });
    const ref = track(created.json.ref);

    const before = await call("taiga_userstory_list", { epic: epicSubject });
    expect(before.json.items.map((item: { ref: number }) => item.ref)).not.toContain(ref);

    const updated = await call("taiga_userstory_update", { ref, epic: epicSubject });
    expect(updated.isError).toBe(false);

    const after = await call("taiga_userstory_list", { epic: epicSubject });
    expect(after.json.items.map((item: { ref: number }) => item.ref)).toContain(ref);
  });

  it("unlinks a story from its epic when `epic` is set to an empty string", async () => {
    const epics = await call("taiga_epic_list");
    const epicSubject = epics.json.items[0].subject;

    const created = await call("taiga_userstory_create", {
      subject: "Epic-unlink test",
      epic: epicSubject,
    });
    const ref = track(created.json.ref);

    const linked = await call("taiga_userstory_list", { epic: epicSubject });
    expect(linked.json.items.map((item: { ref: number }) => item.ref)).toContain(ref);

    const unlinked = await call("taiga_userstory_update", { ref, epic: "" });
    expect(unlinked.isError).toBe(false);

    const after = await call("taiga_userstory_list", { epic: epicSubject });
    expect(after.json.items.map((item: { ref: number }) => item.ref)).not.toContain(ref);
  });
});
