import { describe, it, expect, vi, beforeEach } from "vitest";
import { blockedNote, blockerComment, refsFromLinks, registerLinkTool } from "../src/tools/link.js";
import { resetAttributeCache } from "../src/custom-attributes.js";
import { TaigaError } from "../src/errors.js";

describe("тексты и разбор связей", () => {
  it("примечание называет блокирующую сторону", () => {
    expect(blockedNote(12, "Эндпоинт списка заказов")).toBe("Блокируется #12 «Эндпоинт списка заказов»");
  });

  it("комментарий у блокирующего называет заблокированную сторону", () => {
    expect(blockerComment(34, "Список заказов на экране")).toBe("Блокирует #34 «Список заказов на экране»");
  });

  it("собирает ссылки из примечания и атрибута без дублей", () => {
    expect(refsFromLinks("Блокируется #12 «Эндпоинт»", "#12, #15")).toEqual([12, 15]);
  });

  it("на пустых входах возвращает пустой список", () => {
    expect(refsFromLinks(null, undefined)).toEqual([]);
  });
});

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

/**
 * Same shape as fakeCtx in crud.test.ts/custom-attributes.test.ts, extended
 * with a resolver map (#ref -> {kind, id}) since taiga_link resolves both
 * ends itself, trying the story before the task.
 */
function fakeCtx(options: {
  items: Record<string, Record<number, Record<string, unknown>>>; // path -> id -> object
  refs: Record<number, { kind: "us" | "task"; id: number }>;
  attributeDefs?: Record<string, { id: number; name: string }[]>; // "1:userstory" -> defs
}) {
  const patched: Array<{ path: string; id: number; changes: Record<string, unknown> }> = [];

  const client = {
    get: vi.fn(async (path: string) => {
      const attrValuesMatch = path.match(/^\/(userstories|tasks)\/custom-attributes-values\/(\d+)$/);
      if (attrValuesMatch) {
        const kind = attrValuesMatch[1] === "userstories" ? "userstory" : "task";
        const id = Number(attrValuesMatch[2]);
        const object = options.items[kind === "userstory" ? "/userstories" : "/tasks"]?.[id];
        return { attributes_values: (object?.__attrs as Record<string, unknown>) ?? {}, version: 1 };
      }
      const m = path.match(/^(\/userstories|\/tasks)\/(\d+)$/);
      if (m) {
        const object = options.items[m[1]]?.[Number(m[2])];
        if (!object) throw new Error(`unexpected GET ${path}`);
        return object;
      }
      throw new Error(`unexpected GET ${path}`);
    }),
    list: vi.fn(async (path: string, params?: Record<string, unknown>) => {
      const defsMatch = path.match(/^\/(userstory|task)-custom-attributes$/);
      if (defsMatch) {
        const kind = defsMatch[1];
        const key = `${params?.project}:${kind}`;
        return { items: options.attributeDefs?.[key] ?? [], total: 0, page: 1, hasMore: false };
      }
      throw new Error(`unexpected LIST ${path}`);
    }),
    patch: vi.fn(async (path: string, id: number, changes: Record<string, unknown>) => {
      patched.push({ path, id, changes });
      if (path === "/userstories/custom-attributes-values" || path === "/tasks/custom-attributes-values") {
        const kind = path.startsWith("/userstories") ? "/userstories" : "/tasks";
        const object = options.items[kind]?.[id];
        if (object) object.__attrs = (changes.attributes_values as Record<string, unknown>) ?? {};
        return {};
      }
      const kind = path.startsWith("/userstories") ? "/userstories" : "/tasks";
      const object = options.items[kind]?.[id];
      if (object) Object.assign(object, changes);
      return object ?? {};
    }),
  };

  const cache = {
    resolveProject: vi.fn(async () => 1),
    resolveRef: vi.fn(async (_projectId: number, resolverKey: "us" | "task", ref: number) => {
      const entry = options.refs[ref];
      if (!entry || entry.kind !== resolverKey) {
        throw new TaigaError(`No item #${ref}`, { status: 404 });
      }
      return entry.id;
    }),
  };

  return {
    client,
    cache,
    options: { readOnly: false, voiceGuard: "off" as const },
    patched,
  };
}

describe("taiga_link: разрешение сторон", () => {
  beforeEach(() => {
    resetAttributeCache();
  });

  it("пробует историю раньше задачи и определяет вид записи", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": { 100: { id: 100, subject: "Готовим API", is_blocked: false, blocked_note: "" } },
        "/tasks": { 200: { id: 200, subject: "Рисуем экран", is_blocked: false, blocked_note: "" } },
      },
      refs: { 5: { kind: "us", id: 100 }, 7: { kind: "task", id: 200 } },
      attributeDefs: {},
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    const result = await link({ from: 5, to: 7, type: "blocks" });
    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json.from).toEqual({ ref: 5, kind: "userstory", subject: "Готовим API" });
    expect(json.to).toEqual({ ref: 7, kind: "task", subject: "Рисуем экран" });
  });
});

describe("taiga_link: blocks", () => {
  beforeEach(() => {
    resetAttributeCache();
  });

  it("ставит флаг и примечание на заблокированной стороне, пишет комментарий блокирующей", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "" },
          2: { id: 2, subject: "Рисуем экран", is_blocked: false, blocked_note: "" },
        },
        "/tasks": {},
      },
      refs: { 10: { kind: "us", id: 1 }, 20: { kind: "us", id: 2 } },
      attributeDefs: {},
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    const result = await link({ from: 10, to: 20, type: "blocks" });
    expect(result.isError).toBeUndefined();

    const flagPatch = ctx.patched.find((p) => p.path === "/userstories" && p.id === 2);
    expect(flagPatch?.changes.is_blocked).toBe(true);
    expect(flagPatch?.changes.blocked_note).toBe("Блокируется #10 «Готовим API»");

    const commentPatch = ctx.patched.find((p) => p.path === "/userstories" && p.id === 1);
    expect(commentPatch?.changes.comment).toBe("Блокирует #20 «Рисуем экран»");
  });

  it("дописывает вторую блокирующую ссылку, не затирая первую", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "" },
          2: { id: 2, subject: "Рисуем экран", is_blocked: true, blocked_note: "Блокируется #1 «Готовим API»" },
          3: { id: 3, subject: "Дизайн готов", is_blocked: false, blocked_note: "" },
        },
        "/tasks": {},
      },
      refs: { 1: { kind: "us", id: 1 }, 2: { kind: "us", id: 2 }, 3: { kind: "us", id: 3 } },
      attributeDefs: {},
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    await link({ from: 3, to: 2, type: "blocks" });

    const flagPatch = ctx.patched.find((p) => p.path === "/userstories" && p.id === 2);
    expect(flagPatch?.changes.blocked_note).toBe(
      "Блокируется #1 «Готовим API»\nБлокируется #3 «Дизайн готов»",
    );
  });

  it("remove снимает флаг, если других ссылок не осталось, и пишет о разблокировке", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "" },
          2: { id: 2, subject: "Рисуем экран", is_blocked: true, blocked_note: "Блокируется #1 «Готовим API»" },
        },
        "/tasks": {},
      },
      refs: { 1: { kind: "us", id: 1 }, 2: { kind: "us", id: 2 } },
      attributeDefs: {},
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    await link({ from: 1, to: 2, type: "blocks", remove: true });

    const flagPatch = ctx.patched.find((p) => p.path === "/userstories" && p.id === 2);
    expect(flagPatch?.changes.is_blocked).toBe(false);
    expect(flagPatch?.changes.blocked_note).toBe("");

    const commentPatch = ctx.patched.find((p) => p.path === "/userstories" && p.id === 1);
    expect(commentPatch?.changes.comment).toBe("Разблокировал #2");
  });

  it("remove не трогает флаг, если осталась другая блокирующая ссылка", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "" },
          2: {
            id: 2,
            subject: "Рисуем экран",
            is_blocked: true,
            blocked_note: "Блокируется #1 «Готовим API»\nБлокируется #3 «Дизайн готов»",
          },
          3: { id: 3, subject: "Дизайн готов", is_blocked: false, blocked_note: "" },
        },
        "/tasks": {},
      },
      refs: { 1: { kind: "us", id: 1 }, 2: { kind: "us", id: 2 }, 3: { kind: "us", id: 3 } },
      attributeDefs: {},
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    await link({ from: 1, to: 2, type: "blocks", remove: true });

    const flagPatch = ctx.patched.find((p) => p.path === "/userstories" && p.id === 2);
    expect(flagPatch?.changes.is_blocked).toBe(true);
    expect(flagPatch?.changes.blocked_note).toBe("Блокируется #3 «Дизайн готов»");
  });

  // Acceptance defect (scenarios 6 and 9): removing the LAST #ref from a
  // link attribute used to send `attributes_values: {}` — Taiga rejects that
  // outright with "This field cannot be blank." The custom-attribute value
  // must survive as an empty string, not disappear as a deleted key.
  it("remove последней ссылки оставляет атрибут пустым, а не удаляет ключ", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "", __attrs: { "51": "#2" } },
          2: {
            id: 2,
            subject: "Рисуем экран",
            is_blocked: true,
            blocked_note: "Блокируется #1 «Готовим API»",
            __attrs: { "50": "#1" },
          },
        },
        "/tasks": {},
      },
      refs: { 1: { kind: "us", id: 1 }, 2: { kind: "us", id: 2 } },
      attributeDefs: {
        "1:userstory": [
          { id: 50, name: "Блокируется" },
          { id: 51, name: "Блокирует" },
        ],
      },
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    const result = await link({ from: 1, to: 2, type: "blocks", remove: true });
    expect(result.isError).toBeUndefined();

    const toAttrs = ctx.client.patch.mock.calls
      .filter(([path, id]) => path === "/userstories/custom-attributes-values" && id === 2)
      .map(([, , changes]) => changes)
      .at(-1);
    expect(toAttrs).toEqual({ attributes_values: { "50": "" } });

    const fromAttrs = ctx.client.patch.mock.calls
      .filter(([path, id]) => path === "/userstories/custom-attributes-values" && id === 1)
      .map(([, , changes]) => changes)
      .at(-1);
    expect(fromAttrs).toEqual({ attributes_values: { "51": "" } });
  });

  it("remove одной из двух ссылок в атрибуте оставляет вторую", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "" },
          2: {
            id: 2,
            subject: "Рисуем экран",
            is_blocked: true,
            blocked_note: "Блокируется #1 «Готовим API»\nБлокируется #3 «Дизайн готов»",
            __attrs: { "50": "#1, #3" },
          },
          3: { id: 3, subject: "Дизайн готов", is_blocked: false, blocked_note: "", __attrs: { "51": "#2" } },
        },
        "/tasks": {},
      },
      refs: { 1: { kind: "us", id: 1 }, 2: { kind: "us", id: 2 }, 3: { kind: "us", id: 3 } },
      attributeDefs: {
        "1:userstory": [
          { id: 50, name: "Блокируется" },
          { id: 51, name: "Блокирует" },
        ],
      },
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    const result = await link({ from: 1, to: 2, type: "blocks", remove: true });
    expect(result.isError).toBeUndefined();

    const toAttrs = ctx.client.patch.mock.calls
      .filter(([path, id]) => path === "/userstories/custom-attributes-values" && id === 2)
      .map(([, , changes]) => changes)
      .at(-1);
    expect(toAttrs).toEqual({ attributes_values: { "50": "#3" } });
  });

  it("пишет и снимает ссылки в атрибутах «Блокируется»/«Блокирует», когда они заведены", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "", __attrs: {} },
          2: { id: 2, subject: "Рисуем экран", is_blocked: false, blocked_note: "", __attrs: {} },
        },
        "/tasks": {},
      },
      refs: { 1: { kind: "us", id: 1 }, 2: { kind: "us", id: 2 } },
      attributeDefs: {
        "1:userstory": [
          { id: 50, name: "Блокируется" },
          { id: 51, name: "Блокирует" },
        ],
      },
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    await link({ from: 1, to: 2, type: "blocks" });

    const toAttrs = ctx.client.patch.mock.calls
      .filter(([path, id]) => path === "/userstories/custom-attributes-values" && id === 2)
      .map(([, , changes]) => changes);
    expect(toAttrs.at(-1)).toEqual({ attributes_values: { "50": "#1" } });

    const fromAttrs = ctx.client.patch.mock.calls
      .filter(([path, id]) => path === "/userstories/custom-attributes-values" && id === 1)
      .map(([, , changes]) => changes);
    expect(fromAttrs.at(-1)).toEqual({ attributes_values: { "51": "#2" } });
  });

  // Fix round 1, item 1: поле «Блокируется» — только витрина. Значение "#77"
  // уже лежит в поле (например, кто-то вписал его руками в Тайге), но в
  // примечании ссылки нет — примечание и флаг обязаны считаться по
  // примечанию и всё равно записать блокировку, а не решить, что она уже
  // учтена, потому что поле её "знает".
  it("новая блокировка пишется в примечание, даже если поле «Блокируется» уже называет тот же #ref", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "", __attrs: {} },
          2: { id: 2, subject: "Рисуем экран", is_blocked: false, blocked_note: "", __attrs: { "50": "#77" } },
        },
        "/tasks": {},
      },
      refs: { 77: { kind: "us", id: 1 }, 99: { kind: "us", id: 2 } },
      attributeDefs: {
        "1:userstory": [{ id: 50, name: "Блокируется" }],
      },
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    const result = await link({ from: 77, to: 99, type: "blocks" });
    expect(result.isError).toBeUndefined();

    const flagPatch = ctx.patched.find((p) => p.path === "/userstories" && p.id === 2);
    expect(flagPatch?.changes.is_blocked).toBe(true);
    expect(flagPatch?.changes.blocked_note).toBe("Блокируется #77 «Готовим API»");

    const attrPatch = ctx.client.patch.mock.calls
      .filter(([path, id]) => path === "/userstories/custom-attributes-values" && id === 2)
      .map(([, , changes]) => changes)
      .at(-1);
    expect(attrPatch).toEqual({ attributes_values: { "50": "#77" } });
  });

  // Fix round 1, item 2: комментарий "Блокирует #N" — следствие изменения,
  // не безусловное действие. Второй идентичный вызов не должен ни задвоить
  // строку в примечании, ни написать комментарий снова.
  it("повторный одинаковый вызов не дублирует примечание и не пишет комментарий второй раз", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "" },
          2: { id: 2, subject: "Рисуем экран", is_blocked: false, blocked_note: "" },
        },
        "/tasks": {},
      },
      refs: { 10: { kind: "us", id: 1 }, 20: { kind: "us", id: 2 } },
      attributeDefs: {},
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    await link({ from: 10, to: 20, type: "blocks" });
    const second = await link({ from: 10, to: 20, type: "blocks" });
    expect(second.isError).toBeUndefined();
    expect(JSON.parse(second.content[0].text).changed).toEqual([]);

    const blockedNotePatches = ctx.patched.filter(
      (p) => p.path === "/userstories" && p.id === 2 && "blocked_note" in p.changes,
    );
    expect(blockedNotePatches).toHaveLength(1);
    expect(blockedNotePatches[0].changes.blocked_note).toBe("Блокируется #10 «Готовим API»");

    const commentPatches = ctx.patched.filter(
      (p) => p.path === "/userstories" && p.id === 1 && "comment" in p.changes,
    );
    expect(commentPatches).toHaveLength(1);
  });

  // Fix round 1, item 3: remove без существующей блокировки — ничего не
  // патчится и не комментируется, ответ прямо говорит, что менять нечего.
  it("remove без существующей блокировки ничего не пишет и сообщает, что менять нечего", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "" },
          2: { id: 2, subject: "Рисуем экран", is_blocked: false, blocked_note: "" },
        },
        "/tasks": {},
      },
      refs: { 1: { kind: "us", id: 1 }, 2: { kind: "us", id: 2 } },
      attributeDefs: {},
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    const result = await link({ from: 1, to: 2, type: "blocks", remove: true });
    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0].text);
    expect(json.changed).toEqual([]);
    expect(json.hint).toMatch(/менять нечего/);
    expect(ctx.patched).toHaveLength(0);
  });
});

describe("taiga_link: relates", () => {
  beforeEach(() => {
    resetAttributeCache();
  });

  it("без атрибута «Связано с» ничего не пишет и возвращает подсказку", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "" },
          2: { id: 2, subject: "Рисуем экран", is_blocked: false, blocked_note: "" },
        },
        "/tasks": {},
      },
      refs: { 1: { kind: "us", id: 1 }, 2: { kind: "us", id: 2 } },
      attributeDefs: {},
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    const result = await link({ from: 1, to: 2, type: "relates" });
    const json = JSON.parse(result.content[0].text);
    expect(json.changed).toEqual([]);
    expect(json.hint).toMatch(/Связано с/);
    expect(ctx.patched).toHaveLength(0);
  });

  it("пишет ссылки обеим сторонам, когда атрибут заведён", async () => {
    const ctx = fakeCtx({
      items: {
        "/userstories": {
          1: { id: 1, subject: "Готовим API", is_blocked: false, blocked_note: "", __attrs: {} },
          2: { id: 2, subject: "Рисуем экран", is_blocked: false, blocked_note: "", __attrs: {} },
        },
        "/tasks": {},
      },
      refs: { 1: { kind: "us", id: 1 }, 2: { kind: "us", id: 2 } },
      attributeDefs: { "1:userstory": [{ id: 60, name: "Связано с" }] },
    });
    const server = fakeServer();
    registerLinkTool(server as never, ctx as never);
    const link = server.handlers.get("taiga_link")!;

    const result = await link({ from: 1, to: 2, type: "relates" });
    const json = JSON.parse(result.content[0].text);
    expect(json.changed.sort()).toEqual(["from:Связано с", "to:Связано с"]);

    const calls = ctx.client.patch.mock.calls
      .filter(([path]) => path === "/userstories/custom-attributes-values");
    expect(calls).toHaveLength(2);
  });
});
