import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTool } from "../src/tools/search.js";
import type { ToolContext } from "../src/context.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

/**
 * Captures the handler `registerSearchTool` passes to `server.tool(...)`
 * without needing a real MCP transport — the live Taiga stand's /search
 * endpoint never actually populates the fields this test cares about (see
 * test/integration/search-bulk.test.ts), so the label-resolution wiring in
 * search.ts can only be verified against a controlled fixture like this one.
 */
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
  searchResponse: Record<string, unknown>,
  labelMaps: Record<string, Map<number, string>>,
): ToolContext {
  return {
    cache: {
      resolveProject: vi.fn(async () => 1),
      labelMap: vi.fn(async (_projectId: number, kind: string) => labelMaps[kind] ?? new Map()),
    },
    client: {
      get: vi.fn(async (path: string) => {
        if (path === "/search") return searchResponse;
        throw new Error(`unexpected GET ${path}`);
      }),
    },
  } as unknown as ToolContext;
}

async function callHandler(handler: ToolHandler, args: Record<string, unknown>) {
  const result = await handler(args);
  return { result, json: JSON.parse(result.content[0].text) };
}

describe("taiga_search label resolution", () => {
  it("resolves issue priority, severity and type to names, not bare ids", async () => {
    const { server, handlerFor } = captureHandler();
    const ctx = fakeContext(
      {
        count: 1,
        userstories: [],
        tasks: [],
        epics: [],
        wikipages: [],
        issues: [
          {
            id: 1,
            ref: 42,
            subject: "Bug in login",
            status: 3,
            priority: 41,
            severity: 51,
            type: 61,
            assigned_to: null,
            tags: [],
            is_closed: false,
          },
        ],
      },
      {
        priority: new Map([[41, "High"]]),
        severity: new Map([[51, "Important"]]),
        "issue-type": new Map([[61, "Bug"]]),
      },
    );

    registerSearchTool(server, ctx);
    const { json } = await callHandler(handlerFor("taiga_search"), { text: "bug" });

    expect(json.issues).toHaveLength(1);
    expect(json.issues[0].priority).toBe("High");
    expect(json.issues[0].severity).toBe("Important");
    expect(json.issues[0].type).toBe("Bug");
  });

  it("resolves a wiki page's last_modifier to a member name, not a bare id", async () => {
    const { server, handlerFor } = captureHandler();
    const ctx = fakeContext(
      {
        count: 1,
        userstories: [],
        tasks: [],
        epics: [],
        issues: [],
        wikipages: [{ id: 1, slug: "home", last_modifier: 91 }],
      },
      { member: new Map([[91, "Ivan Petrov"]]) },
    );

    registerSearchTool(server, ctx);
    const { json } = await callHandler(handlerFor("taiga_search"), { text: "home" });

    expect(json.wikipages).toHaveLength(1);
    expect(json.wikipages[0].last_modifier).toBe("Ivan Petrov");
  });
});
