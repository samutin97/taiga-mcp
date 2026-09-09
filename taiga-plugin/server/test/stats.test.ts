import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStatsTool } from "../src/tools/stats.js";
import type { ToolContext } from "../src/context.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function captureHandler(): { server: McpServer; handlerFor: (name: string) => ToolHandler } {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
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
