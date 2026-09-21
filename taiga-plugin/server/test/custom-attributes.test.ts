import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  attributeIds,
  attributeSummaries,
  requireAttribute,
  writeAttributes,
  resetAttributeCache,
} from "../src/custom-attributes.js";

// Same shape as fakeClient in schema-cache.test.ts, wrapped as a ToolContext
// (only `.client` matters here) and extended to remember PATCH calls.
function fakeCtx(routes: Record<string, unknown>) {
  const patched: Array<{ path: string; id: number; changes: Record<string, unknown> }> = [];
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
    patch: vi.fn(async (path: string, id: number, changes: Record<string, unknown>) => {
      patched.push({ path, id, changes });
      return {};
    }),
  };
  return { client, patched };
}

const routes = {
  "/task-custom-attributes?project=1&page_size=1000": [
    { id: 9, name: "Оценка", type: "number" },
    { id: 11, name: "Блокируется", type: "text" },
  ],
  "/tasks/custom-attributes-values/50": { attributes_values: { "9": 5 }, version: 3 },
};

describe("кастомные атрибуты", () => {
  beforeEach(() => {
    // Definitions are cached per project/resource across calls — a stale
    // entry from an earlier test must not leak into the next one.
    resetAttributeCache();
  });

  it("находит атрибут по имени", async () => {
    const ctx = fakeCtx(routes);
    const map = await attributeIds(ctx as never, 1, "task");
    expect(map.get("Оценка")).toBe(9);
  });

  it("кеширует определения атрибутов на проект и ресурс", async () => {
    const ctx = fakeCtx(routes);
    await attributeIds(ctx as never, 1, "task");
    await attributeIds(ctx as never, 1, "task");
    const definitionCalls = ctx.client.list.mock.calls.filter(
      ([path]) => path === "/task-custom-attributes",
    );
    expect(definitionCalls).toHaveLength(1);
  });

  it("отдаёт имя и тип поля", async () => {
    const ctx = fakeCtx(routes);
    const summaries = await attributeSummaries(ctx as never, 1, "task");
    expect(summaries).toEqual([
      { name: "Оценка", type: "number" },
      { name: "Блокируется", type: "text" },
    ]);
  });

  it("attributeSummaries переиспользует кеш, заполненный attributeIds — без второго запроса", async () => {
    const ctx = fakeCtx(routes);
    await attributeIds(ctx as never, 1, "task");
    await attributeSummaries(ctx as never, 1, "task");
    const definitionCalls = ctx.client.list.mock.calls.filter(
      ([path]) => path === "/task-custom-attributes",
    );
    expect(definitionCalls).toHaveLength(1);
  });

  it("объясняет, как завести недостающий атрибут", () => {
    const map = new Map<string, number>();
    expect(() => requireAttribute(map, "Оценка")).toThrow(/Оценка/);
  });

  it("пишет значения с текущей версией", async () => {
    const ctx = fakeCtx(routes);
    await writeAttributes(ctx as never, "task", 50, { 9: 8 });
    expect(ctx.patched).toEqual([
      { path: "/tasks/custom-attributes-values", id: 50, changes: { attributes_values: { "9": 8 } } },
    ]);
  });

  it("удаляет поле, когда значение null, но остаётся другое поле", async () => {
    const ctx = fakeCtx({
      "/tasks/custom-attributes-values/50": {
        attributes_values: { "9": 5, "11": "blocked" },
        version: 3,
      },
    });
    await writeAttributes(ctx as never, "task", 50, { 11: null });
    expect(ctx.patched).toEqual([
      { path: "/tasks/custom-attributes-values", id: 50, changes: { attributes_values: { "9": 5 } } },
    ]);
  });

  // Taiga rejects `attributes_values: {}` outright ("This field cannot be
  // blank."). Deleting the only remaining key — e.g. taiga_link removing the
  // last #ref from «Блокируется» — must not send an empty payload: the
  // touched key stays in the map, blanked, instead of being dropped.
  it("не отправляет пустой attributes_values, когда удаление снимает последнее поле", async () => {
    const ctx = fakeCtx({
      "/tasks/custom-attributes-values/50": {
        attributes_values: { "11": "#5" },
        version: 3,
      },
    });
    await expect(writeAttributes(ctx as never, "task", 50, { 11: null })).resolves.toBeUndefined();
    expect(ctx.patched).toEqual([
      { path: "/tasks/custom-attributes-values", id: 50, changes: { attributes_values: { "11": "" } } },
    ]);
  });

  it("блокирует пустой payload даже при удалении сразу нескольких последних полей", async () => {
    const ctx = fakeCtx({
      "/tasks/custom-attributes-values/50": {
        attributes_values: { "9": "#1", "11": "#2" },
        version: 3,
      },
    });
    await writeAttributes(ctx as never, "task", 50, { 9: null, 11: null });
    expect(ctx.patched).toEqual([
      {
        path: "/tasks/custom-attributes-values",
        id: 50,
        changes: { attributes_values: { "9": "", "11": "" } },
      },
    ]);
  });
});
