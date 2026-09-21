import { describe, it, expect, vi } from "vitest";
import { registerBulkTool } from "../src/tools/bulk.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { type: string; text: string }[];
}>;

/** Same fake server as crud.test.ts: captures registerTool calls so a test can invoke a handler directly. */
function fakeServer() {
  const handlers = new Map<string, ToolHandler>();
  return {
    handlers,
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
}

// Regression for the defect found on live review: taiga_bulk_create built its
// own, narrower id->name maps than taiga_userstory_create/_get (crud.ts's
// buildLabels), missing the `role`/`points` maps a userstory's projection
// needs for `points_by_role` — so a bulk-created story with per-role points
// always reported `points_by_role: {}` even though the points were written.
// bulk.ts now imports crud.ts's `buildLabels` instead of keeping its own copy.
describe("taiga_bulk_create: points_by_role на истории с поинтами по ролям", () => {
  it("заполняет points_by_role так же, как одиночное создание", async () => {
    const ROLES_ROUTE = "/roles?project=1&page_size=1000";
    const roles = [
      { id: 3, name: "Front", order: 30, computable: true },
      { id: 4, name: "Back", order: 40, computable: true },
    ];
    // "5" -> points entry 7 (value 5), "3" -> points entry 6 (value 3) —
    // same id/value pairing as the live sandbox project.
    const pointsIds: Record<string, number> = { "3": 6, "5": 7 };
    const pointValues = new Map<number, number | null>([
      [6, 3],
      [7, 5],
    ]);

    const client = {
      get: vi.fn(async (path: string) => {
        throw new Error(`unexpected GET ${path}`);
      }),
      list: vi.fn(async (path: string, params?: Record<string, unknown>) => {
        let key = path;
        if (params) {
          const query = new URLSearchParams();
          for (const [k, v] of Object.entries(params)) {
            if (v !== undefined) query.set(k, String(v));
          }
          const qs = query.toString();
          if (qs) key = `${path}?${qs}`;
        }
        if (key === ROLES_ROUTE) return { items: roles, total: 0, page: 1, hasMore: false };
        throw new Error(`unexpected LIST ${key}`);
      }),
      post: vi.fn(async (_path: string, body: Record<string, unknown>) => ({
        id: 999,
        ref: 42,
        subject: body.subject,
        points: body.points,
      })),
      patch: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
    };
    const cache = {
      resolveProject: vi.fn(async () => 1),
      labelMap: vi.fn(async (_projectId: number, kind: string) => {
        if (kind === "role") return new Map([[3, "Front"], [4, "Back"]]);
        return new Map(); // "member" — unused by this test
      }),
      valueMap: vi.fn(async () => pointValues),
      resolveLookup: vi.fn(async (_projectId: number, kind: string, value: string | number) => {
        if (kind !== "points") throw new Error(`unexpected lookup kind ${kind}`);
        const key = String(value);
        if (!(key in pointsIds)) throw new Error(`no /points entry for "${key}"`);
        return pointsIds[key];
      }),
    };
    const ctx = { client, cache, options: { readOnly: false, voiceGuard: "off" as const } };

    const server = fakeServer();
    registerBulkTool(server as never, ctx as never);
    const create = server.handlers.get("taiga_bulk_create")!;

    const result = await create({
      resource: "userstory",
      items: [{ subject: "Bulk story with role points", points: { Front: "5", Back: "3" } }],
    });

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json.failed).toEqual([]);
    expect(json.created).toHaveLength(1);
    expect(json.created[0].points_by_role).toEqual({ Front: 5, Back: 3 });
  });
});
