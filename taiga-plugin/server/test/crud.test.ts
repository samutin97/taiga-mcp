import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCrudTools } from "../src/tools/crud.js";
import { EPIC, ISSUE, TASK, USER_STORY } from "../src/resources.js";
import { resetAttributeCache } from "../src/custom-attributes.js";
import { startClient } from "./helpers/mcp-client.js";

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
    // can share this fakeCtx. `valueMap` backs userstory's `points_by_role`
    // the same way — buildLabels calls it unconditionally for userstory.
    labelMap: vi.fn(async () => new Map()),
    valueMap: vi.fn(async () => new Map()),
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

  it("читает «Оценка», записанную строкой (Taiga не проверяет типы кастомных полей)", async () => {
    const ctx = fakeCtx({
      "/tasks/10": { id: 10, ref: 5, subject: "Задача", blocked_note: "" },
      "/task-custom-attributes?project=1&page_size=1000": [{ id: 9, name: "Оценка", type: "number" }],
      "/tasks/custom-attributes-values/10": { attributes_values: { "9": "5" }, version: 1 },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const get = server.handlers.get("taiga_task_get")!;

    const result = await get({ id: 10, fields: "full" });
    const json = JSON.parse(result.content[0].text);
    expect(json.estimate).toBe(5);
  });

  it("estimate: null (не 0, не NaN), когда значение не число ни в каком виде", async () => {
    const ctx = fakeCtx({
      "/tasks/10": { id: 10, ref: 5, subject: "Задача", blocked_note: "" },
      "/task-custom-attributes?project=1&page_size=1000": [{ id: 9, name: "Оценка", type: "number" }],
      "/tasks/custom-attributes-values/10": { attributes_values: { "9": "abc" }, version: 1 },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const get = server.handlers.get("taiga_task_get")!;

    const result = await get({ id: 10, fields: "full" });
    const json = JSON.parse(result.content[0].text);
    expect(json.estimate).toBeNull();
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

describe("taiga_userstory_update/taiga_task_update: подсказка при снятии блокировки руками", () => {
  beforeEach(() => {
    resetAttributeCache();
  });

  it("возвращает hint, когда флаг снимают руками, а note ещё называет #12", async () => {
    const ctx = fakeCtx({
      "/userstories/20": {
        id: 20,
        ref: 8,
        subject: "История",
        is_blocked: true,
        blocked_note: "Блокируется #12 «Блокер»",
      },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, USER_STORY);
    const update = server.handlers.get("taiga_userstory_update")!;

    const result = await update({ id: 20, is_blocked: false, blocked_note: "" });

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json.hint).toMatch(/taiga_link/);
    expect(json.hint).toMatch(/remove/);
  });

  it("не возвращает hint, если note уже была пустой", async () => {
    const ctx = fakeCtx({
      "/userstories/20": { id: 20, ref: 8, subject: "История", is_blocked: true, blocked_note: "" },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, USER_STORY);
    const update = server.handlers.get("taiga_userstory_update")!;

    const result = await update({ id: 20, is_blocked: false });

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json).not.toHaveProperty("hint");
  });

  it("не возвращает hint для обновления, не связанного с блокировкой", async () => {
    const ctx = fakeCtx({});
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, USER_STORY);
    const update = server.handlers.get("taiga_userstory_update")!;

    const result = await update({ id: 20, subject: "Новое имя" });

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json).not.toHaveProperty("hint");
    expect(ctx.client.get).not.toHaveBeenCalled();
  });

  it("то же самое поведение для задачи: hint приходит, когда note называет #3", async () => {
    const ctx = fakeCtx({
      "/tasks/30": {
        id: 30,
        ref: 7,
        subject: "Задача",
        is_blocked: true,
        blocked_note: "Блокируется #3 «Блокер»",
      },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const update = server.handlers.get("taiga_task_update")!;

    const result = await update({ id: 30, is_blocked: false, blocked_note: "" });

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json.hint).toMatch(/taiga_link/);
  });
});

const MILESTONES_ROUTE = "/milestones?project=1&page_size=1000";

/**
 * fakeCtx plus what a plain create/update touches: `post`/`patch` answer
 * with the row Taiga would send back (`response`, so a test can say which
 * milestone Taiga actually kept), the project's two sprints are listed for
 * resolveSprint, and `resolveRef` turns the story #ref 8 into id 20.
 */
function fakeWriteCtx(response: Record<string, unknown> = {}) {
  const base = fakeCtx({
    [MILESTONES_ROUTE]: [
      { id: 5, name: "Sprint 1" },
      { id: 6, name: "Sprint 2" },
    ],
  });
  const client = {
    ...base.client,
    post: vi.fn(async (_path: string, _body: Record<string, unknown>) => ({ id: 999, ...response })),
    patch: vi.fn(async (_path: string, id: number, _changes: Record<string, unknown>) => ({
      id,
      ...response,
    })),
  };
  const cache = {
    ...base.cache,
    resolveRef: vi.fn(async (_projectId: number, kind: string, ref: number) => {
      if (kind !== "us" || ref !== 8) throw new Error(`unexpected resolveRef ${kind} #${ref}`);
      return 20;
    }),
  };
  return { ...base, client, cache };
}

/** `properties` of one tool's input schema, as tools/list gives it to the model. */
async function schemaProperties(name: string): Promise<Record<string, unknown>> {
  const { tools } = await (await startClient()).listTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
}

describe("client_requirement/team_requirement у историй и эпиков", () => {
  it.each([
    "taiga_userstory_create", "taiga_userstory_update", "taiga_epic_create", "taiga_epic_update",
  ])("%s объявляет оба флага булевыми", async (name) => {
    const props = await schemaProperties(name);
    expect(props.client_requirement).toEqual({ type: "boolean" });
    expect(props.team_requirement).toEqual({ type: "boolean" });
  });

  it.each([USER_STORY, EPIC])("taiga_$name_create передаёт оба флага в Taiga, false тоже", async (def) => {
    const ctx = fakeWriteCtx();
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, def);
    const create = server.handlers.get(`taiga_${def.name}_create`)!;

    const result = await create({ subject: "Вход по SSO", client_requirement: true, team_requirement: false });

    expect(result.isError).toBeUndefined();
    expect(ctx.client.post).toHaveBeenCalledTimes(1);
    const [path, payload] = ctx.client.post.mock.calls[0];
    expect(path).toBe(def.path);
    expect(payload).toMatchObject({ client_requirement: true, team_requirement: false });
  });

  it.each([USER_STORY, EPIC])("taiga_$name_update меняет только переданные флаги", async (def) => {
    const ctx = fakeWriteCtx();
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, def);
    const update = server.handlers.get(`taiga_${def.name}_update`)!;

    const result = await update({ id: 20, client_requirement: false, team_requirement: true });

    expect(result.isError).toBeUndefined();
    expect(ctx.client.patch).toHaveBeenCalledWith(def.path, 20, {
      client_requirement: false,
      team_requirement: true,
    });
  });
});

describe("sprint у задач и issue", () => {
  it.each([
    "taiga_task_create", "taiga_task_update", "taiga_issue_create", "taiga_issue_update",
  ])("%s объявляет sprint строкой", async (name) => {
    const props = await schemaProperties(name);
    expect(props.sprint).toMatchObject({ type: "string" });
  });

  it.each([TASK, ISSUE])("taiga_$name_create резолвит имя спринта в milestone", async (def) => {
    const ctx = fakeWriteCtx();
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, def);
    const create = server.handlers.get(`taiga_${def.name}_create`)!;

    const result = await create({ subject: "Починить вход", sprint: " sprint 2 " });

    expect(result.isError).toBeUndefined();
    const [, payload] = ctx.client.post.mock.calls[0];
    expect(payload.milestone).toBe(6);
    // Taiga's serializer does not know `sprint` and would drop it silently.
    expect(payload).not.toHaveProperty("sprint");
  });

  it.each([TASK, ISSUE])("taiga_$name_update: имя спринта → milestone", async (def) => {
    const ctx = fakeWriteCtx();
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, def);
    const update = server.handlers.get(`taiga_${def.name}_update`)!;

    const result = await update({ id: 30, sprint: "Sprint 1" });

    expect(result.isError).toBeUndefined();
    expect(ctx.client.patch).toHaveBeenCalledWith(def.path, 30, { milestone: 5 });
  });

  it.each([TASK, ISSUE])('taiga_$name_update: sprint "" снимает спринт, не читая список', async (def) => {
    const ctx = fakeWriteCtx();
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, def);
    const update = server.handlers.get(`taiga_${def.name}_update`)!;

    const result = await update({ id: 30, sprint: "" });

    expect(result.isError).toBeUndefined();
    expect(ctx.client.patch).toHaveBeenCalledWith(def.path, 30, { milestone: null });
    expect(ctx.client.list).not.toHaveBeenCalled();
  });

  it.each([TASK, ISSUE])("taiga_$name_create с неизвестным спринтом ничего не создаёт", async (def) => {
    const ctx = fakeWriteCtx();
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, def);
    const create = server.handlers.get(`taiga_${def.name}_create`)!;

    const result = await create({ subject: "Починить вход", sprint: "Sprint 9" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Sprint 1, Sprint 2/);
    expect(ctx.client.post).not.toHaveBeenCalled();
  });
});

// Taiga's TaskViewSet.pre_save copies the story's milestone onto its task
// on every create and update, overriding whatever milestone was sent. The
// tool relies on that for `user_story` alone and only speaks up when a
// requested sprint lost to it.
describe("taiga_task_create/taiga_task_update: спринт задачи истории", () => {
  it("с одним user_story не шлёт milestone и не читает историю — спринт ставит Taiga", async () => {
    const ctx = fakeWriteCtx({ user_story: 20, milestone: 5 });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const create = server.handlers.get("taiga_task_create")!;

    const result = await create({ subject: "Вёрстка формы", user_story: 8 });

    expect(result.isError).toBeUndefined();
    const [, payload] = ctx.client.post.mock.calls[0];
    expect(payload.user_story).toBe(20);
    expect(payload).not.toHaveProperty("milestone");
    expect(ctx.client.get).not.toHaveBeenCalled();
    expect(ctx.client.list).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).not.toHaveProperty("hint");
  });

  it("возвращает hint, когда Taiga оставила задаче спринт истории вместо запрошенного", async () => {
    const ctx = fakeWriteCtx({ user_story: 20, milestone: 5 });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const create = server.handlers.get("taiga_task_create")!;

    const result = await create({ subject: "Вёрстка формы", user_story: 8, sprint: "Sprint 2" });

    expect(result.isError).toBeUndefined();
    expect(ctx.client.post.mock.calls[0][1].milestone).toBe(6);
    expect(JSON.parse(result.content[0].text).hint).toMatch(/taiga_userstory_update/);
  });

  it("не возвращает hint, когда запрошенный спринт совпал со спринтом истории", async () => {
    const ctx = fakeWriteCtx({ user_story: 20, milestone: 5 });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const create = server.handlers.get("taiga_task_create")!;

    const result = await create({ subject: "Вёрстка формы", user_story: 8, sprint: "Sprint 1" });

    expect(JSON.parse(result.content[0].text)).not.toHaveProperty("hint");
  });

  it("update: hint, когда задача истории осталась в спринте истории", async () => {
    const ctx = fakeWriteCtx({ user_story: 20, milestone: 5 });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const update = server.handlers.get("taiga_task_update")!;

    const result = await update({ id: 30, sprint: "" });

    expect(result.isError).toBeUndefined();
    expect(ctx.client.patch).toHaveBeenCalledWith("/tasks", 30, { milestone: null });
    expect(JSON.parse(result.content[0].text).hint).toMatch(/taiga_userstory_update/);
  });

  it("update: у задачи без истории спринт меняется без подсказок", async () => {
    const ctx = fakeWriteCtx({ user_story: null, milestone: 6 });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const update = server.handlers.get("taiga_task_update")!;

    const result = await update({ id: 30, sprint: "Sprint 2" });

    expect(JSON.parse(result.content[0].text)).not.toHaveProperty("hint");
  });
});

// Fix round (final review), Critical 1: a role change, a story move or a
// delete used to recompute only the pair the task ends up in (or, for
// delete, nothing at all), leaving the pair it *left* stale — still
// counting an estimate for a task that no longer belongs there. These tests
// build a fuller fakeCtx (roles, points scale, userstory read/patch,
// cache.resolveLookup/resolveRef) than the one above, since they exercise
// recalcStoryPoints end to end, not just the tag/hint bookkeeping.
describe("taiga_task_update/taiga_task_delete: пересчёт поинтов по обеим сторонам", () => {
  const ROLES_ROUTE = "/roles?project=1&page_size=1000";
  const roles = [
    { id: 1, name: "UX", order: 10, computable: true },
    { id: 3, name: "Front", order: 30, computable: true },
    { id: 4, name: "Back", order: 40, computable: true },
  ];
  const POINTS_ROUTE = "/points?project=1&page_size=1000";
  const pointsList = [
    { id: 1, name: "?", value: null },
    { id: 2, name: "0", value: 0 },
    { id: 7, name: "5", value: 5 },
  ];
  const pointsIds = { "0": 2, "5": 7 };
  const ATTRS_ROUTE = "/task-custom-attributes?project=1&page_size=1000";
  const attrs = [{ id: 9, name: "Оценка", type: "number" }];

  function fakeRoleCtx(
    routes: Record<string, unknown>,
    resolveRef: (kind: string, ref: number) => number = () => {
      throw new Error("resolveRef not configured for this test");
    },
  ) {
    const patched: { path: string; id: number; changes: Record<string, unknown> }[] = [];
    const client = {
      get: vi.fn(async (path: string) => {
        // Stateful only for /userstories/<id>: recalcStoryPoints re-reads the
        // same story once per (story, role) pair it recomputes, and a
        // role-change-within-one-story test patches that same story twice —
        // the second read must see the first patch's `points`, or the test
        // would have to assert on a stale merge that no real Taiga ever
        // produces.
        const usMatch = /^\/userstories\/(\d+)$/.exec(path);
        if (usMatch && path in routes) {
          const id = Number(usMatch[1]);
          const base = routes[path] as Record<string, unknown>;
          const priorPoints = patched
            .filter((p) => p.path === "/userstories" && p.id === id)
            .reduce(
              (acc, p) => ({ ...acc, ...(p.changes.points as Record<string, number>) }),
              (base.points as Record<string, number>) ?? {},
            );
          return { ...base, points: priorPoints };
        }
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
        // taiga_task_update reads the PATCH response back as "updated" — a
        // different, post-write snapshot than the plain GET of the same
        // path/id (used by loadCurrent for the *before* state), so callers
        // key it separately: `RESPONSE ${path}/${id}`.
        const key = `RESPONSE ${path}/${id}`;
        return key in routes ? routes[key] : {};
      }),
      remove: vi.fn(async () => {}),
    };
    const cache = {
      resolveProject: vi.fn(async () => 1),
      labelMap: vi.fn(async () => new Map()),
      resolveRef: vi.fn(async (_projectId: number, kind: string, ref: number) => resolveRef(kind, ref)),
      resolveLookup: vi.fn(async (_projectId: number, _kind: string, value: string | number) => {
        const key = String(value);
        if (!(key in pointsIds)) throw new Error(`no /points entry for "${key}"`);
        return (pointsIds as Record<string, number>)[key];
      }),
    };
    return { client, cache, patched, options: { readOnly: false, voiceGuard: "off" as const } };
  }

  beforeEach(() => {
    resetAttributeCache();
  });

  it("смена роли front → back пересчитывает и старую, и новую роль", async () => {
    const ctx = fakeRoleCtx({
      [ATTRS_ROUTE]: attrs,
      [ROLES_ROUTE]: roles,
      [POINTS_ROUTE]: pointsList,
      "/tasks/30": {
        id: 30, ref: 7, subject: "Задача", tags: [["front", null]],
        user_story: 20, user_story_extra_info: { ref: 8 },
      },
      "RESPONSE /tasks/30": {
        id: 30, ref: 7, subject: "Задача", tags: [["back", null]],
        user_story: 20, user_story_extra_info: { ref: 8 },
      },
      // Post-write reality recalcStoryPoints re-queries fresh: task 30 now
      // carries "back", is the only task on the story, and has an estimate.
      "/tasks?project=1&user_story=20&page_size=1000": [
        { id: 30, tags: [["back", null]] },
      ],
      "/tasks/custom-attributes-values/30": { attributes_values: { "9": 5 } },
      "/userstories/20": { id: 20, total_points: 5, points: { "3": 7 } },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const update = server.handlers.get("taiga_task_update")!;

    const result = await update({ id: 30, role: "back" });

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json.story_points).toEqual([
      { user_story: 8, role: "Front", from: 5, to: 0 },
      // `from` reads the story's overall total_points (not per-role — a
      // pre-existing quirk out of this fix's scope), so it still shows 5
      // here even though Back's own points entry was never set before.
      { user_story: 8, role: "Back", from: 5, to: 5 },
    ]);
    const storyPatches = ctx.patched.filter((p) => p.path === "/userstories");
    expect(storyPatches).toEqual([
      { path: "/userstories", id: 20, changes: { points: { "3": 2 } } },
      { path: "/userstories", id: 20, changes: { points: { "3": 2, "4": 7 } } },
    ]);
  });

  it("перенос задачи в другую историю пересчитывает поинты обеих историй", async () => {
    const ctx = fakeRoleCtx(
      {
        [ATTRS_ROUTE]: attrs,
        [ROLES_ROUTE]: roles,
        [POINTS_ROUTE]: pointsList,
        "/tasks/40": {
          id: 40, ref: 12, subject: "Задача", tags: [["back", null]],
          user_story: 20, user_story_extra_info: { ref: 8 },
        },
        "RESPONSE /tasks/40": {
          id: 40, ref: 12, subject: "Задача", tags: [["back", null]],
          user_story: 21, user_story_extra_info: { ref: 9 },
        },
        "/tasks?project=1&user_story=20&page_size=1000": [],
        "/tasks?project=1&user_story=21&page_size=1000": [
          { id: 40, tags: [["back", null]] },
        ],
        "/tasks/custom-attributes-values/40": { attributes_values: { "9": 5 } },
        "/userstories/20": { id: 20, total_points: 5, points: { "4": 7 } },
        "/userstories/21": { id: 21, total_points: null, points: {} },
      },
      (kind, ref) => {
        expect(kind).toBe("us");
        expect(ref).toBe(9);
        return 21;
      },
    );
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const update = server.handlers.get("taiga_task_update")!;

    const result = await update({ id: 40, user_story: 9 });

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json.story_points).toEqual([
      { user_story: 8, role: "Back", from: 5, to: 0 },
      { user_story: 9, role: "Back", from: null, to: 5 },
    ]);
  });

  it("удаление задачи пересчитывает поинты роли у оставшейся истории", async () => {
    const ctx = fakeRoleCtx({
      [ATTRS_ROUTE]: attrs,
      [ROLES_ROUTE]: roles,
      [POINTS_ROUTE]: pointsList,
      "/tasks/50": { id: 50, tags: [["ux", null]], user_story: 20 },
      "/tasks?project=1&user_story=20&page_size=1000": [],
      "/userstories/20": { id: 20, total_points: 5, points: { "1": 7 } },
    });
    const server = fakeServer();
    registerCrudTools(server as never, ctx as never, TASK);
    const del = server.handlers.get("taiga_task_delete")!;

    const result = await del({ id: 50, confirm: true });

    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json.deleted).toBe(true);
    expect(json.story_points).toEqual({ role: "UX", from: 5, to: 0 });
    expect(ctx.patched).toEqual([
      { path: "/userstories", id: 20, changes: { points: { "1": 2 } } },
    ]);
  });
});
