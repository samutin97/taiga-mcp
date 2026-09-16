import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStatsTool } from "../src/tools/stats.js";
import type { ToolContext } from "../src/context.js";
import { resetAttributeCache } from "../src/custom-attributes.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function captureHandler(): { server: McpServer; handlerFor: (name: string) => ToolHandler } {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  return {
    server: server as unknown as McpServer,
    handlerFor: (name: string) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`tool ${name} was not registered`);
      return handler;
    },
  };
}

function fakeContext(
  milestonesResponse: { items: { id: number; name: string }[] },
  milestoneStatsResponse: Record<string, unknown>,
): ToolContext {
  return {
    options: { readOnly: false, voiceGuard: "off" },
    cache: {
      resolveProject: vi.fn(async () => 1),
    },
    client: {
      list: vi.fn(async () => milestonesResponse),
      get: vi.fn(async () => milestoneStatsResponse),
    },
  } as unknown as ToolContext;
}

async function callHandler(handler: ToolHandler, args: Record<string, unknown>) {
  const result = await handler(args);
  return { result, json: JSON.parse(result.content[0].text) };
}

describe("taiga_stats multi-role totals", () => {
  it("sums total_points across all roles, not just the first", async () => {
    const { server, handlerFor } = captureHandler();
    const ctx = fakeContext(
      {
        items: [{ id: 42, name: "Sprint Fixture" }],
      },
      {
        name: "Sprint Fixture",
        estimated_start: "2026-09-07",
        estimated_finish: "2026-09-20",
        total_points: { "1": 10, "2": 5, "3": 2.5 },
        completed_points: [4, 1],
        completed_userstories: 2,
        completed_tasks: 1,
        days: [],
      },
    );

    registerStatsTool(server, ctx);
    const { json } = await callHandler(handlerFor("taiga_stats"), { sprint: "Sprint Fixture" });

    expect(json.total_points).toBe(17.5);
    expect(json.completed_points).toBe(5);
  });
});

// Task shape as raw Taiga's /tasks returns it: `tags` is [name, color] pairs,
// `assigned_to` a bare member id or null. A fake `client` dispatches on path
// instead of returning one fixed response, so attributeIds, the sprint's
// task list and per-task readAttributes each see the right fixture.
interface FakeTask {
  id: number;
  assigned_to: number | null;
  tags?: [string, string | null][];
  /** Left out entirely to simulate a task nobody ever put an estimate on. */
  estimate?: number | null;
}

function fakeLoadContext(opts: {
  hasEstimateAttribute: boolean;
  tasks: FakeTask[];
  members: Map<number, string>;
}): ToolContext {
  const milestoneStats = {
    name: "Sprint Fixture",
    estimated_start: "2026-09-07",
    estimated_finish: "2026-09-20",
    total_points: { "1": 10 },
    completed_points: [4],
    completed_userstories: 1,
    completed_tasks: 1,
    days: [],
  };

  return {
    options: { readOnly: false, voiceGuard: "off" },
    cache: {
      resolveProject: vi.fn(async () => 1),
      labelMap: vi.fn(async () => opts.members),
    },
    client: {
      list: vi.fn(async (path: string) => {
        if (path === "/milestones") return { items: [{ id: 42, name: "Sprint Fixture" }] };
        if (path === "/task-custom-attributes") {
          return { items: opts.hasEstimateAttribute ? [{ id: 9, name: "Оценка" }] : [] };
        }
        if (path === "/tasks") return { items: opts.tasks };
        throw new Error(`unexpected LIST ${path}`);
      }),
      get: vi.fn(async (path: string) => {
        if (path === "/milestones/42/stats") return milestoneStats;
        if (path === "/projects/1/stats") return { name: "Project Fixture" };
        const match = path.match(/^\/tasks\/custom-attributes-values\/(\d+)$/);
        if (match) {
          const task = opts.tasks.find((t) => t.id === Number(match[1]));
          const values = task && "estimate" in task ? { "9": task.estimate } : {};
          return { attributes_values: values };
        }
        throw new Error(`unexpected GET ${path}`);
      }),
    },
  } as unknown as ToolContext;
}

describe("taiga_stats: sprint load", () => {
  // attributeIds() caches project+resource lookups for a minute across
  // calls, including across tests in this file — a stale "no Оценка" (or
  // stale "has Оценка") entry from one test must not leak into the next.
  beforeEach(() => {
    resetAttributeCache();
  });

  it("skips the task list entirely when the project has no «Оценка» field", async () => {
    const { server, handlerFor } = captureHandler();
    const ctx = fakeLoadContext({ hasEstimateAttribute: false, tasks: [], members: new Map() });

    registerStatsTool(server, ctx);
    const { json } = await callHandler(handlerFor("taiga_stats"), { sprint: "Sprint Fixture" });

    expect(json.load).toEqual([]);
    expect(json.load_note).toBe("Оценок задач в проекте нет: заведите поле «Оценка» у задач.");
    expect(ctx.client.list).not.toHaveBeenCalledWith("/tasks", expect.anything());
  });

  it("never touches attributes in the project-wide branch", async () => {
    const { server, handlerFor } = captureHandler();
    const ctx = fakeLoadContext({ hasEstimateAttribute: true, tasks: [], members: new Map() });

    registerStatsTool(server, ctx);
    const { json } = await callHandler(handlerFor("taiga_stats"), {});

    expect(json.load).toBeUndefined();
    expect(ctx.client.list).not.toHaveBeenCalledWith("/task-custom-attributes", expect.anything());
  });

  it("groups by assignee and role, splits out the unassigned, hides no points for unestimated tasks", async () => {
    const { server, handlerFor } = captureHandler();
    const members = new Map([[1, "Ada"]]);
    const tasks: FakeTask[] = [
      { id: 101, assigned_to: 1, tags: [["front", null]], estimate: 3 },
      { id: 102, assigned_to: 1, tags: [["front", null]], estimate: 4 },
      { id: 103, assigned_to: 1, tags: [["front", null]] }, // no estimate at all
      { id: 104, assigned_to: 1, tags: [["back", null]], estimate: 5 },
      { id: 105, assigned_to: 1, estimate: 1 }, // no role tag
      { id: 106, assigned_to: null, tags: [["ux", null]], estimate: 2 },
      { id: 107, assigned_to: null }, // unassigned, no role, no estimate
    ];
    const ctx = fakeLoadContext({ hasEstimateAttribute: true, tasks, members });

    registerStatsTool(server, ctx);
    const { json } = await callHandler(handlerFor("taiga_stats"), { sprint: "Sprint Fixture" });

    expect(json.load_note).toBeUndefined();
    expect(json.load).toEqual([
      { member: "Ada", role: null, points: 1, of_capacity: 0.03, unestimated_tasks: 0 },
      { member: "Ada", role: "back", points: 5, of_capacity: 0.13, unestimated_tasks: 0 },
      { member: "Ada", role: "front", points: 7, of_capacity: 0.18, unestimated_tasks: 1 },
      { member: "Без исполнителя", role: null, points: 0, of_capacity: 0, unestimated_tasks: 1 },
      { member: "Без исполнителя", role: "ux", points: 2, of_capacity: 0.05, unestimated_tasks: 0 },
    ]);
    // 7 tasks in the sprint, one readAttributes call each — not one per role or member.
    expect(ctx.client.get).toHaveBeenCalledTimes(tasks.length + 1); // + the milestone stats call
  });
});
