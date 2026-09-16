import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard, PROJECT_SCHEMA } from "../context.js";
import { TaigaError } from "../errors.js";
import { defineTool } from "../registry.js";
import {
  type AttrResource,
  attributeIds,
  readAttributes,
  writeAttributes,
} from "../custom-attributes.js";
import { addComment } from "./comment.js";

/** Taiga has no native "A blocks B" relation — this tool writes both sides at once. */
const PATH: Record<AttrResource, string> = {
  userstory: "/userstories",
  task: "/tasks",
};

/** Key /resolver expects for each kind. */
const RESOLVER_KEY: Record<AttrResource, string> = {
  userstory: "us",
  task: "task",
};

interface Endpoint {
  ref: number;
  kind: AttrResource;
  id: number;
  subject: string;
  raw: Record<string, unknown>;
}

/** The note written on the blocked side: names the blocker. */
export function blockedNote(ref: number, subject: string): string {
  return `Блокируется #${ref} «${subject}»`;
}

/** The comment posted on the blocker side: names what it blocks. */
export function blockerComment(ref: number, subject: string): string {
  return `Блокирует #${ref} «${subject}»`;
}

/**
 * Shown by taiga_userstory_update/taiga_task_update when a caller clears
 * is_blocked or blanks blocked_note by hand instead of calling this tool
 * with remove: true. That write only ever lands on this side: the other
 * endpoint's «Блокирует» field and the "Разблокировал" line this tool
 * itself would post stay exactly as they were.
 */
export const MANUAL_UNBLOCK_HINT =
  "Флаг снят только здесь: «Блокирует» на другой стороне и запись «Разблокировал» не " +
  'появятся. Снимайте связь целиком через taiga_link (type: "blocks", remove: true).';

/** Every `#ref` mentioned in a note and/or a custom-attribute value, deduped and sorted. */
export function refsFromLinks(note: string | null | undefined, attribute: unknown): number[] {
  const source = `${note ?? ""} ${typeof attribute === "string" ? attribute : ""}`;
  const found = source.match(/#(\d+)/g) ?? [];
  return [...new Set(found.map((token) => Number(token.slice(1))))].sort((a, b) => a - b);
}

/** Drop every line of `note` that mentions `ref`; keeps the rest, in order. */
function withoutRef(note: string, ref: number): string {
  return note
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      const match = line.match(/#(\d+)/);
      return match ? Number(match[1]) !== ref : true;
    })
    .join("\n");
}

/** The custom attribute's plain shop-window format: "#12, #15". */
function formatRefs(refs: number[]): string {
  return refs.map((ref) => `#${ref}`).join(", ");
}

/**
 * Resolve a #ref to a story or a task. A ref is unique within a project, so
 * trying the story first and falling back to the task on a resolver miss is
 * unambiguous.
 */
async function resolveEndpoint(ctx: ToolContext, projectId: number, ref: number): Promise<Endpoint> {
  for (const kind of ["userstory", "task"] as const) {
    try {
      const id = await ctx.cache.resolveRef(projectId, RESOLVER_KEY[kind], ref);
      const raw = await ctx.client.get<Record<string, unknown>>(`${PATH[kind]}/${id}`);
      return { ref, kind, id, subject: String(raw.subject ?? ""), raw };
    } catch (error) {
      if (!(error instanceof TaigaError && error.status === 404)) throw error;
    }
  }
  throw new TaigaError(`No story or task #${ref} in this project.`, { status: 404 });
}

/** Current value of a named custom attribute on an item, plus its id (undefined if not defined in the project). */
async function currentAttr(
  ctx: ToolContext,
  projectId: number,
  point: Endpoint,
  name: string,
): Promise<{ id: number | undefined; value: unknown }> {
  const ids = await attributeIds(ctx, projectId, point.kind);
  const id = ids.get(name);
  if (id === undefined) return { id: undefined, value: undefined };
  const values = await readAttributes(ctx, point.kind, point.id);
  return { id, value: values[String(id)] };
}

/** Add `ref` to the attribute's ref list (a no-op write if already present); returns whether the attribute exists. */
async function addRefToAttribute(
  ctx: ToolContext,
  point: Endpoint,
  attr: { id: number | undefined; value: unknown },
  ref: number,
): Promise<boolean> {
  if (attr.id === undefined) return false;
  const refs = refsFromLinks(null, attr.value);
  const next = refs.includes(ref) ? refs : [...refs, ref].sort((a, b) => a - b);
  await writeAttributes(ctx, point.kind, point.id, { [attr.id]: formatRefs(next) });
  return true;
}

/** Remove `ref` from the attribute's ref list, deleting the field once empty; returns whether the attribute exists. */
async function removeRefFromAttribute(
  ctx: ToolContext,
  point: Endpoint,
  attr: { id: number | undefined; value: unknown },
  ref: number,
): Promise<boolean> {
  if (attr.id === undefined) return false;
  const refs = refsFromLinks(null, attr.value).filter((r) => r !== ref);
  await writeAttributes(ctx, point.kind, point.id, { [attr.id]: refs.length > 0 ? formatRefs(refs) : null });
  return true;
}

async function applyBlocks(
  ctx: ToolContext,
  projectId: number,
  from: Endpoint,
  to: Endpoint,
  remove: boolean,
): Promise<{ changed: string[]; hint?: string }> {
  const currentNote = typeof to.raw.blocked_note === "string" ? to.raw.blocked_note : "";
  // Source of truth is the note (and the flag it travels with) — never the
  // custom attribute. The attribute is a write destination only: someone can
  // edit it by hand in Taiga's UI, and if that value fed back into this
  // decision, a stale attribute ref could either keep is_blocked stuck true
  // on an empty note, or make a genuinely new block look already-recorded
  // and get silently skipped.
  const noteRefs = refsFromLinks(currentNote, null);
  const changed: string[] = [];

  if (!remove) {
    // Nothing to do: the note already names this blocker. Also keeps a
    // repeated identical call from posting "Блокирует #N" again.
    if (noteRefs.includes(from.ref)) return { changed };

    const sentence = blockedNote(from.ref, from.subject);
    const newNote = currentNote.trim() ? `${currentNote}\n${sentence}` : sentence;
    await ctx.client.patch(PATH[to.kind], to.id, { is_blocked: true, blocked_note: newNote });
    changed.push("to:is_blocked", "to:blocked_note");

    const blockedAttr = await currentAttr(ctx, projectId, to, "Блокируется");
    if (await addRefToAttribute(ctx, to, blockedAttr, from.ref)) changed.push("to:Блокируется");

    await addComment(ctx, from.kind, from.id, blockerComment(to.ref, to.subject));
    changed.push("from:comment");

    const blockerAttr = await currentAttr(ctx, projectId, from, "Блокирует");
    if (await addRefToAttribute(ctx, from, blockerAttr, to.ref)) changed.push("from:Блокирует");

    return { changed };
  }

  // Nothing to do: this blocker isn't named in the note, so there is no
  // link to remove.
  if (!noteRefs.includes(from.ref)) {
    return { changed, hint: `Блокировки #${from.ref} не было — менять нечего.` };
  }

  const remainingRefs = noteRefs.filter((ref) => ref !== from.ref);
  const newNote = withoutRef(currentNote, from.ref);
  await ctx.client.patch(PATH[to.kind], to.id, {
    is_blocked: remainingRefs.length > 0,
    blocked_note: newNote,
  });
  changed.push("to:is_blocked", "to:blocked_note");

  const blockedAttr = await currentAttr(ctx, projectId, to, "Блокируется");
  if (await removeRefFromAttribute(ctx, to, blockedAttr, from.ref)) changed.push("to:Блокируется");

  await addComment(ctx, from.kind, from.id, `Разблокировал #${to.ref}`);
  changed.push("from:comment");

  const blockerAttr = await currentAttr(ctx, projectId, from, "Блокирует");
  if (await removeRefFromAttribute(ctx, from, blockerAttr, to.ref)) changed.push("from:Блокирует");

  return { changed };
}

async function applyRelates(
  ctx: ToolContext,
  projectId: number,
  from: Endpoint,
  to: Endpoint,
  remove: boolean,
): Promise<{ changed: string[]; hint?: string }> {
  const fromAttr = await currentAttr(ctx, projectId, from, "Связано с");
  const toAttr = await currentAttr(ctx, projectId, to, "Связано с");

  if (fromAttr.id === undefined || toAttr.id === undefined) {
    return {
      changed: [],
      hint: "В проекте нет поля «Связано с»: поставьте ссылку #ref в описании.",
    };
  }

  const changed: string[] = [];
  if (!remove) {
    if (await addRefToAttribute(ctx, from, fromAttr, to.ref)) changed.push("from:Связано с");
    if (await addRefToAttribute(ctx, to, toAttr, from.ref)) changed.push("to:Связано с");
  } else {
    if (await removeRefFromAttribute(ctx, from, fromAttr, to.ref)) changed.push("from:Связано с");
    if (await removeRefFromAttribute(ctx, to, toAttr, from.ref)) changed.push("to:Связано с");
  }
  return { changed };
}

function shapeEndpoint(point: Endpoint) {
  return { ref: point.ref, kind: point.kind, subject: point.subject };
}

export function registerLinkTool(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    {
      name: "taiga_link",
      description:
        "Связать две записи: blocks — первая блокирует вторую, relates — просто связаны; remove снимает связь.",
      kind: "update",
      input: {
        project: PROJECT_SCHEMA,
        from: z.number().describe("#ref блокирующей (или первой) записи."),
        to: z.number().describe("#ref заблокированной (или второй) записи."),
        type: z.enum(["blocks", "relates"]),
        remove: z.boolean().optional().describe("Снять связь."),
      },
    },
    guard(async (args) => {
      const a = args as Record<string, unknown>;
      const projectId = await ctx.cache.resolveProject(a.project as string | undefined);
      const type = a.type as "blocks" | "relates";
      const remove = a.remove === true;

      const from = await resolveEndpoint(ctx, projectId, a.from as number);
      const to = await resolveEndpoint(ctx, projectId, a.to as number);

      const result =
        type === "blocks"
          ? await applyBlocks(ctx, projectId, from, to, remove)
          : await applyRelates(ctx, projectId, from, to, remove);

      return ok({
        from: shapeEndpoint(from),
        to: shapeEndpoint(to),
        changed: result.changed,
        ...(result.hint ? { hint: result.hint } : {}),
      });
    }),
  );
}
