import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCrudTools } from "../src/tools/crud.js";
import { TASK } from "../src/resources.js";
import { resetAttributeCache } from "../src/custom-attributes.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { type: string; text: string }[];
}>;

/** Captures every `server.registerTool` call so a test can invoke one handler directly. */
function fakeServer() {
  const handlers = new Map<string, ToolHandler>();
  return {
    handlers,
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
}

// Same shape as fakeCtx in custom-attributes.test.ts, extended with the
// pieces registerCrudTools' create handler touches: a project resolver and
// a `post` spy to prove it was never called.
function fakeCtx(routes: Record<string, unknown>) {
  const client = {
    get: vi.fn(async (path: string) => {
      if (!(path in routes)) throw new Error(`unexpected GET ${path}`);
      return routes[path];
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
      if (!(key in routes)) throw new Error(`unexpected LIST ${key}`);
      return { items: routes[key] as unknown[], total: 0, page: 1, hasMore: false };
    }),
    post: vi.fn(async () => ({ id: 999 })),
    patch: vi.fn(async () => ({})),
    remove: vi.fn(async () => {}),
  };
  const cache = { resolveProject: vi.fn(async () => 1) };
  return { client, cache, options: { readOnly: false, voiceGuard: "off" as const } };
}

describe("taiga_task_create: порядок проверки «Оценка»", () => {
  beforeEach(() => {
    resetAttributeCache();
  });

  it("не создаёт задачу, если в проекте нет поля «Оценка»", async () => {
    const ctx = fakeCtx({
      "/task-custom-attributes?project=1&page_size=1000": [], // no «Оценка» field
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const create = server.handlers.get("taiga_task_create")!;

    const result = await create({ project: "sandbox", subject: "Задача", estimate: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Оценка/);
    expect(ctx.client.post).not.toHaveBeenCalled();
  });

  it("создаёт задачу, когда поле есть", async () => {
    const ctx = fakeCtx({
      "/task-custom-attributes?project=1&page_size=1000": [{ id: 9, name: "Оценка", type: "number" }],
      "/tasks/custom-attributes-values/999": { attributes_values: {}, version: 1 },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const create = server.handlers.get("taiga_task_create")!;

    const result = await create({ project: "sandbox", subject: "Задача", estimate: 5 });

    expect(result.isError).toBeUndefined();
    expect(ctx.client.post).toHaveBeenCalledTimes(1);
  });
});
