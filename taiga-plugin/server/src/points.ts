import type { ToolContext } from "./context.js";
import { TaigaError } from "./errors.js";

export interface RoleRow {
  id: number;
  name: string;
  order: number;
}

/** Роли, по которым Taiga считает поинты, в порядке доски (по `order`). */
export async function computableRoles(ctx: ToolContext, projectId: number): Promise<RoleRow[]> {
  // page_size explicit: Taiga's default page (30) would silently hide a
  // computable role on a project with more roles than that, and the
  // "primary" role picked below would then be the wrong one.
  const { items } = await ctx.client.list<Record<string, unknown>>("/roles", {
    project: projectId,
    page_size: 1000,
  });
  return items
    .filter((row) => row.computable === true)
    .map((row) => ({ id: row.id as number, name: String(row.name), order: Number(row.order ?? 0) }))
    .sort((a, b) => a.order - b.order);
}

/** Шкала поинтов проекта, по возрастанию, без «?» (её значение — null). */
export async function pointScale(ctx: ToolContext, projectId: number): Promise<number[]> {
  const { items } = await ctx.client.list<Record<string, unknown>>("/points", {
    project: projectId,
    page_size: 1000,
  });
  return items
    .map((row) => row.value)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
}

/** Наименьшее значение шкалы, не меньшее суммы; сумма выше максимума — максимум шкалы. */
export function roundUpToScale(sum: number, scale: number[]): number {
  const fits = scale.filter((value) => value >= sum);
  if (fits.length > 0) return fits[0];
  return scale.length > 0 ? scale[scale.length - 1] : sum;
}

/**
 * Resolve the caller's points value into the per-role map Taiga's
 * userstory.points field actually requires.
 *
 * Verified live: Taiga stores points as `{ roleId: pointsEntryId }`, one
 * entry per computable role. Sending a bare string or number straight
 * through crashes the server with an opaque HTTP 500 instead of a
 * validation error.
 *
 * A bare string/number is written to the project's primary role (lowest
 * `order` among computable roles) — Taiga defaults any other computable
 * role to "unestimated" on create and leaves it untouched on update, so a
 * single human value maps onto the per-role model without the caller ever
 * seeing roles. An object keyed by role name (e.g. `{ Front: "5", Back: "3"
 * }`) estimates each named role separately; role names are matched
 * case-insensitively and trimmed, and an unknown role name is an error
 * listing the project's computable roles.
 */
export async function pointsPayload(
  ctx: ToolContext,
  projectId: number,
  value: string | number | Record<string, string | number>,
): Promise<Record<string, number>> {
  const roles = await computableRoles(ctx, projectId);
  if (typeof value !== "object") {
    const primary = roles[0];
    if (!primary) {
      throw new TaigaError("В проекте нет ролей, по которым считаются поинты.");
    }
    return { [primary.id]: await ctx.cache.resolveLookup(projectId, "points", value) };
  }
  const payload: Record<string, number> = {};
  for (const [roleName, points] of Object.entries(value)) {
    const role = roles.find((row) => row.name.toLowerCase() === roleName.trim().toLowerCase());
    if (!role) {
      throw new TaigaError(
        `Роль «${roleName}» в проекте не считается: ${roles.map((r) => r.name).join(", ")}.`,
      );
    }
    payload[role.id] = await ctx.cache.resolveLookup(projectId, "points", points);
  }
  return payload;
}
