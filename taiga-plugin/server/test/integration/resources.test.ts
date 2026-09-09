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
