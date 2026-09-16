import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCrudTools } from "../src/tools/crud.js";
import { TASK, USER_STORY } from "../src/resources.js";
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
  const cache = {
    resolveProject: vi.fn(async () => 1),
    // Only userstory's SLIM shape declares a label map (`member`); task
    // needs none. Present unconditionally so either resource's `_get` test
    // can share this fakeCtx.
    labelMap: vi.fn(async () => new Map()),
  };
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

describe("taiga_task_get: «Оценка» в fields: \"full\"", () => {
  beforeEach(() => {
    resetAttributeCache();
  });

  it("возвращает числовое значение, читая тот же ответ, что и «Блокирует»", async () => {
    const ctx = fakeCtx({
      "/tasks/10": { id: 10, ref: 5, subject: "Задача", blocked_note: "" },
      "/task-custom-attributes?project=1&page_size=1000": [
        { id: 9, name: "Оценка", type: "number" },
        { id: 11, name: "Блокирует", type: "text" },
      ],
      "/tasks/custom-attributes-values/10": { attributes_values: { "9": 5, "11": "#3" }, version: 1 },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const get = server.handlers.get("taiga_task_get")!;

    const result = await get({ id: 10, fields: "full" });

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json.estimate).toBe(5);
    expect(json.blocks).toEqual([3]);

    // «Блокирует» and «Оценка» both live in attributes_values — one GET of
    // the values row must serve both, not one each.
    const valueReads = ctx.client.get.mock.calls.filter(
      ([path]) => path === "/tasks/custom-attributes-values/10",
    );
    expect(valueReads).toHaveLength(1);
  });

  it("estimate: null, когда в проекте нет поля «Оценка», и значения вовсе не читаются", async () => {
    const ctx = fakeCtx({
      "/tasks/10": { id: 10, ref: 5, subject: "Задача", blocked_note: "" },
      "/task-custom-attributes?project=1&page_size=1000": [],
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const get = server.handlers.get("taiga_task_get")!;

    const result = await get({ id: 10, fields: "full" });
    const json = JSON.parse(result.content[0].text);
    expect(json.estimate).toBeNull();
    expect(ctx.client.get.mock.calls.map(([path]) => path)).not.toContain(
      "/tasks/custom-attributes-values/10",
    );
  });

  it("estimate: null, когда поле есть, но у задачи не заполнено", async () => {
    const ctx = fakeCtx({
      "/tasks/10": { id: 10, ref: 5, subject: "Задача", blocked_note: "" },
      "/task-custom-attributes?project=1&page_size=1000": [{ id: 9, name: "Оценка", type: "number" }],
      "/tasks/custom-attributes-values/10": { attributes_values: {}, version: 1 },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const get = server.handlers.get("taiga_task_get")!;

    const result = await get({ id: 10, fields: "full" });
    const json = JSON.parse(result.content[0].text);
    expect(json.estimate).toBeNull();
  });

  it("слим-ответ не читает атрибуты вовсе", async () => {
    const ctx = fakeCtx({
      "/tasks/10": { id: 10, ref: 5, subject: "Задача", blocked_note: "" },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const get = server.handlers.get("taiga_task_get")!;

    const result = await get({ id: 10 }); // fields по умолчанию — slim
    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json).not.toHaveProperty("estimate");
    expect(ctx.client.list).not.toHaveBeenCalled();
    expect(ctx.client.get).toHaveBeenCalledTimes(1); // только карточка задачи
  });
});

describe("taiga_userstory_get: «Оценка» — задачное поле, не историй", () => {
  beforeEach(() => {
    resetAttributeCache();
  });

  it("full-карточка истории не содержит ключ estimate, даже если поле заведено у историй", async () => {
    const ctx = fakeCtx({
      "/userstories/20": { id: 20, ref: 8, subject: "История", blocked_note: "" },
      "/userstory-custom-attributes?project=1&page_size=1000": [
        { id: 9, name: "Оценка", type: "number" },
      ],
      "/userstories/custom-attributes-values/20": { attributes_values: { "9": 5 }, version: 1 },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, USER_STORY);
    const get = server.handlers.get("taiga_userstory_get")!;

    const result = await get({ id: 20, fields: "full" });
    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json).not.toHaveProperty("estimate");
    expect(json.blocked_by).toEqual([]);
    expect(json.blocks).toEqual([]);
  });
});
