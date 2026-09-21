import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRoleTag, recalcStoryPoints } from "../src/role-points.js";
import { resetAttributeCache } from "../src/custom-attributes.js";

describe("тег роли", () => {
  it("снимает прежнюю роль и ставит новую", () => {
    expect(withRoleTag(["front", "оплата"], "back")).toEqual(["оплата", "back"]);
  });

  it("не плодит дубликаты", () => {
    expect(withRoleTag(["back"], "back")).toEqual(["back"]);
  });

  it("не трогает прочие теги", () => {
    expect(withRoleTag(["оплата"], "ux")).toEqual(["оплата", "ux"]);
  });
});

// Same fakeCtx shape as custom-attributes.test.ts, extended with the pieces
// recalcStoryPoints itself touches: a roles/points lookup and a
// cache.resolveLookup stub that maps a points *value* (as a string, e.g.
// "0", "8") to its /points entry id — the same table a live project's
// /points list actually holds (see the sandbox check in the final-fixes
// report: id 1 is "?" with value null, id 2 is "0", etc).
function fakeCtx(routes: Record<string, unknown>, pointsIds: Record<string, number>) {
  const patched: { path: string; id: number; changes: Record<string, unknown> }[] = [];
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
  const cache = {
    resolveLookup: vi.fn(async (_projectId: number, _kind: string, value: string | number) => {
      const key = String(value);
      if (!(key in pointsIds)) throw new Error(`no /points entry for "${key}"`);
      return pointsIds[key];
    }),
  };
  return { client, cache, patched };
}

const ROLES_ROUTE = "/roles?project=1&page_size=1000";
const roles = [
  { id: 3, name: "Front", order: 30, computable: true },
  { id: 4, name: "Back", order: 40, computable: true },
];

const POINTS_ROUTE = "/points?project=1&page_size=1000";
const pointsList = [
  { id: 1, name: "?", value: null },
  { id: 2, name: "0", value: 0 },
  { id: 5, name: "2", value: 2 },
  { id: 6, name: "3", value: 3 },
  { id: 7, name: "5", value: 5 },
  { id: 8, name: "8", value: 8 },
];
const pointsIds = { "0": 2, "2": 5, "3": 6, "5": 7, "8": 8 };

const ATTRS_ROUTE = "/task-custom-attributes?project=1&page_size=1000";
const attrs = [{ id: 9, name: "Оценка", type: "number" }];

describe("recalcStoryPoints: emptyMeansZero различает «ещё не» и «уже нет»", () => {
  beforeEach(() => {
    resetAttributeCache();
  });

  it("без задач роли и без emptyMeansZero — null, story не трогаем (ещё не оценено)", async () => {
    const ctx = fakeCtx(
      {
        [ATTRS_ROUTE]: attrs,
        "/tasks?project=1&user_story=20&page_size=1000": [],
      },
      pointsIds,
    );

    const result = await recalcStoryPoints(ctx as never, 1, 20, "front");

    expect(result).toBeNull();
    expect(ctx.patched).toEqual([]);
  });

  it("без задач роли, но emptyMeansZero — обнуляет прежнее значение (роль потеряла последнюю задачу)", async () => {
    const ctx = fakeCtx(
      {
        [ATTRS_ROUTE]: attrs,
        "/tasks?project=1&user_story=20&page_size=1000": [],
        [ROLES_ROUTE]: roles,
        [POINTS_ROUTE]: pointsList,
        "/userstories/20": { id: 20, total_points: 3, points: { "3": 6 } },
      },
      pointsIds,
    );

    const result = await recalcStoryPoints(ctx as never, 1, 20, "front", true);

    expect(result).toEqual({ role: "Front", from: 3, to: 0 });
    expect(ctx.patched).toEqual([
      { path: "/userstories", id: 20, changes: { points: { "3": 2 } } },
    ]);
  });

  it("роль без задач, но computable в проекте — тоже 0, а не отказ", async () => {
    // Same as above but the story never had a points entry for this role at
    // all (a task carried the role once, was reassigned before any recalc
    // ever ran) — `from` reads whatever total_points says, `to` is still 0.
    const ctx = fakeCtx(
      {
        [ATTRS_ROUTE]: attrs,
        "/tasks?project=1&user_story=21&page_size=1000": [],
        [ROLES_ROUTE]: roles,
        [POINTS_ROUTE]: pointsList,
        "/userstories/21": { id: 21, total_points: null, points: {} },
      },
      pointsIds,
    );

    const result = await recalcStoryPoints(ctx as never, 1, 21, "back", true);

    expect(result).toEqual({ role: "Back", from: null, to: 0 });
    expect(ctx.patched).toEqual([{ path: "/userstories", id: 21, changes: { points: { "4": 2 } } }]);
  });
});

describe("recalcStoryPoints: предупреждение при превышении максимума шкалы", () => {
  beforeEach(() => {
    resetAttributeCache();
  });

  it("сумма выше максимума — поинты стоят на максимуме, и есть warning", async () => {
    const ctx = fakeCtx(
      {
        [ATTRS_ROUTE]: attrs,
        "/tasks?project=1&user_story=20&page_size=1000": [
          { id: 101, tags: [["front", null]] },
          { id: 102, tags: [["front", null]] },
        ],
        "/tasks/custom-attributes-values/101": { attributes_values: { "9": 5 } },
        "/tasks/custom-attributes-values/102": { attributes_values: { "9": 8 } },
        [ROLES_ROUTE]: roles,
        [POINTS_ROUTE]: pointsList,
        "/userstories/20": { id: 20, total_points: null, points: {} },
      },
      pointsIds,
    );

    const result = await recalcStoryPoints(ctx as never, 1, 20, "front");

    expect(result?.to).toBe(8); // scale maxes out at 8; the spec keeps the max
    expect(result?.warning).toMatch(/13/); // the real sum, not silently lost
    expect(result?.warning).toMatch(/8/); // the scale's max, named in the warning
    expect(ctx.patched).toEqual([
      { path: "/userstories", id: 20, changes: { points: { "3": 8 } } },
    ]);
  });

  it("сумма в пределах шкалы — без warning", async () => {
    const ctx = fakeCtx(
      {
        [ATTRS_ROUTE]: attrs,
        "/tasks?project=1&user_story=20&page_size=1000": [{ id: 101, tags: [["front", null]] }],
        "/tasks/custom-attributes-values/101": { attributes_values: { "9": 3 } },
        [ROLES_ROUTE]: roles,
        [POINTS_ROUTE]: pointsList,
        "/userstories/20": { id: 20, total_points: null, points: {} },
      },
      pointsIds,
    );

    const result = await recalcStoryPoints(ctx as never, 1, 20, "front");

    expect(result).toEqual({ role: "Front", from: null, to: 3 });
    expect(result).not.toHaveProperty("warning");
  });
});
