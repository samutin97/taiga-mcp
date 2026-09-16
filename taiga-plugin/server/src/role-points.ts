import type { ToolContext } from "./context.js";
import { attributeIds, readAttributes } from "./custom-attributes.js";
import { computableRoles, pointScale, roundUpToScale } from "./points.js";

export const ROLE_TAGS = ["front", "back", "ux", "design"] as const;
export type RoleTag = (typeof ROLE_TAGS)[number];

/** Заменяет прежний тег роли новым, не трогая остальные теги. */
export function withRoleTag(tags: string[], role: string): string[] {
  const kept = tags.filter((tag) => !ROLE_TAGS.includes(tag.toLowerCase() as RoleTag));
  return [...kept, role.toLowerCase()];
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
