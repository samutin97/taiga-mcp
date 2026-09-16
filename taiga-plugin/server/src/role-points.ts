import type { ToolContext } from "./context.js";
import { attributeIds, readAttributes, requireAttribute, writeAttributes } from "./custom-attributes.js";
import { computableRoles, pointScale, roundUpToScale } from "./points.js";

export const ROLE_TAGS = ["front", "back", "ux", "design"] as const;
export type RoleTag = (typeof ROLE_TAGS)[number];

/** Заменяет прежний тег роли новым, не трогая остальные теги. */
export function withRoleTag(tags: string[], role: string): string[] {
  const kept = tags.filter((tag) => !ROLE_TAGS.includes(tag.toLowerCase() as RoleTag));
  return [...kept, role.toLowerCase()];
}

/**
 * Which role `recalcStoryPoints` should recompute after a task write: the
 * role this call just set, or — when only `estimate` changed — the role tag
 * the task already carries, read straight from the write's own response so
 * no extra request is needed.
 */
export function effectiveRole(role: string | undefined, tags: unknown): RoleTag | undefined {
  if (role !== undefined) return role as RoleTag;
  if (!Array.isArray(tags)) return undefined;
  for (const tag of tags) {
    const name = String(Array.isArray(tag) ? tag[0] : tag).toLowerCase();
    if ((ROLE_TAGS as readonly string[]).includes(name)) return name as RoleTag;
  }
  return undefined;
}

export interface CreateWithRoleEstimateResult {
  row: Record<string, unknown>;
  /** Set only when this create owes a points recalculation; left to the caller to run — immediately for a single create, batched by pair for a bulk one. */
  recalcTarget?: { storyId: number; role: RoleTag };
}

/**
 * POST a new item, applying `role`/`estimate` the same way at every entry
 * point that offers them (today only tasks — `role`/`estimate` are simply
 * undefined for every other resource, making every step here a no-op, so
 * this is safe to call from a resource-generic create handler too): check
 * the «Оценка» custom field exists before creating anything if `estimate`
 * is given (an orphaned task with no ref to clean up is worse than an
 * error with nothing created), fold the role tag into `payload.tags` if
 * `role` is given, create, write the estimate, and work out which
 * (story, role) pair — if any — owes a points recalculation.
 *
 * Shared by `taiga_<resource>_create` and `taiga_bulk_create` instead of
 * each duplicating the sequence.
 */
export async function createWithRoleEstimate(
  ctx: ToolContext,
  projectId: number,
  path: string,
  payload: Record<string, unknown>,
  role: string | undefined,
  estimate: number | undefined,
): Promise<CreateWithRoleEstimateResult> {
  let estimateAttrId: number | undefined;
  if (typeof estimate === "number") {
    const ids = await attributeIds(ctx, projectId, "task");
    estimateAttrId = requireAttribute(ids, "Оценка");
  }
  if (role !== undefined) {
    payload.tags = withRoleTag((payload.tags as string[] | undefined) ?? [], role);
  }

  const row = await ctx.client.post<Record<string, unknown>>(path, payload);

  if (estimateAttrId !== undefined) {
    await writeAttributes(ctx, "task", row.id as number, { [estimateAttrId]: estimate });
  }

  let recalcTarget: { storyId: number; role: RoleTag } | undefined;
  if (estimate !== undefined || role !== undefined) {
    const forRole = effectiveRole(role, row.tags);
    if (forRole && typeof row.user_story === "number") {
      recalcTarget = { storyId: row.user_story, role: forRole };
    }
  }

  return { row, recalcTarget };
}

/** Поинты роли = сумма оценок её задач, округлённая вверх до шкалы проекта. */
export async function recalcStoryPoints(
  ctx: ToolContext,
  projectId: number,
  storyId: number,
  role: RoleTag,
): Promise<{ role: string; from: number | null; to: number } | null> {
  const ids = await attributeIds(ctx, projectId, "task");
  const estimateId = ids.get("Оценка");
  if (estimateId === undefined) return null;

  const { items } = await ctx.client.list<Record<string, unknown>>("/tasks", {
    project: projectId,
    user_story: storyId,
    page_size: 1000,
  });
  const ofRole = items.filter((task) =>
    (task.tags as [string, string | null][] | undefined)?.some(
      (tag) => String(tag[0]).toLowerCase() === role,
    ),
  );

  let sum = 0;
  let estimated = 0;
  for (const task of ofRole) {
    const values = await readAttributes(ctx, "task", task.id as number);
    const value = Number(values[String(estimateId)]);
    if (Number.isFinite(value)) {
      sum += value;
      estimated += 1;
    }
  }
  if (estimated === 0) return null;

  const roles = await computableRoles(ctx, projectId);
  const target = roles.find((row) => row.name.toLowerCase() === role);
  if (!target) return null;

  const scale = await pointScale(ctx, projectId);
  const rounded = roundUpToScale(sum, scale);
  const story = await ctx.client.get<Record<string, unknown>>(`/userstories/${storyId}`);
  const before = (story.total_points as number | null) ?? null;
  const pointsId = await ctx.cache.resolveLookup(projectId, "points", String(rounded));
  await ctx.client.patch("/userstories", storyId, {
    points: { ...((story.points as Record<string, number>) ?? {}), [target.id]: pointsId },
  });
  return { role: target.name, from: before, to: rounded };
}
