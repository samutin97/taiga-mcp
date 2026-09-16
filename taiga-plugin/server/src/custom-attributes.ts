import type { ToolContext } from "./context.js";
import type { TaigaClient } from "./client.js";
import { TaigaError } from "./errors.js";

export type AttrResource = "task" | "userstory";

/** A field's definition as it comes back from the same list request as its id — type included for free. */
export interface AttrDef {
  id: number;
  type: string;
}

const DEFINITION_PATH: Record<AttrResource, string> = {
  task: "/task-custom-attributes",
  userstory: "/userstory-custom-attributes",
};

const VALUES_PATH: Record<AttrResource, string> = {
  task: "/tasks/custom-attributes-values",
  userstory: "/userstories/custom-attributes-values",
};

// Keyed `${projectId}:${resource}`, same shape as SchemaCache's lookup cache.
const cache = new Map<string, { at: number; defs: Map<string, AttrDef> }>();
const TTL_MS = 60_000;

/** Test-only: a stale entry must not leak from one test into the next. */
export function resetAttributeCache(): void {
  cache.clear();
}

/**
 * Fetches and caches a resource's custom-attribute definitions once per
 * project — `attributeIds` (ids only, for reading/writing values) and
 * `attributeSummaries` (names and types, for `taiga_project_schema`) both
 * read this same cache entry instead of each issuing their own request.
 */
async function definitions(
  ctx: { client: TaigaClient },
  projectId: number,
  resource: AttrResource,
): Promise<Map<string, AttrDef>> {
  const key = `${projectId}:${resource}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.defs;
  const { items } = await ctx.client.list<Record<string, unknown>>(DEFINITION_PATH[resource], {
    project: projectId,
    page_size: 1000,
  });
  const defs = new Map(
    items.map((row) => [String(row.name), { id: row.id as number, type: String(row.type) }]),
  );
  cache.set(key, { at: Date.now(), defs });
  return defs;
}

export async function attributeIds(
  ctx: ToolContext,
  projectId: number,
  resource: AttrResource,
): Promise<Map<string, number>> {
  const defs = await definitions(ctx, projectId, resource);
  return new Map([...defs].map(([name, def]) => [name, def.id]));
}

/** Names and types only — no ids — for showing what fields exist, e.g. in `taiga_project_schema`. */
export async function attributeSummaries(
  ctx: { client: TaigaClient },
  projectId: number,
  resource: AttrResource,
): Promise<{ name: string; type: string }[]> {
  const defs = await definitions(ctx, projectId, resource);
  return [...defs].map(([name, def]) => ({ name, type: def.type }));
}

/** Значения приходят отдельным объектом со своей версией — в списках их нет. */
export async function readAttributes(
  ctx: ToolContext,
  resource: AttrResource,
  itemId: number,
): Promise<Record<string, unknown>> {
  const row = await ctx.client.get<{ attributes_values?: Record<string, unknown> }>(
    `${VALUES_PATH[resource]}/${itemId}`,
  );
  return row.attributes_values ?? {};
}

// Merges into a snapshot read before the PATCH, while the version that
// guards the write is fetched later, inside `client.patch` itself — so a
// change that lands between our read and that write is silently overwritten,
// not rejected. Fine for a single writer per field (estimate, links); a
// future bulk caller must not rely on this for concurrent-safe merges.
export async function writeAttributes(
  ctx: ToolContext,
  resource: AttrResource,
  itemId: number,
  values: Record<number, unknown>,
): Promise<void> {
  const current = await readAttributes(ctx, resource, itemId);
  const merged: Record<string, unknown> = { ...current };
  for (const [id, value] of Object.entries(values)) {
    if (value === null) delete merged[id];
    else merged[id] = value;
  }
  await ctx.client.patch(VALUES_PATH[resource], itemId, { attributes_values: merged });
}

export function requireAttribute(ids: Map<string, number>, name: string): number {
  const id = ids.get(name);
  if (id === undefined) {
    throw new TaigaError(`В проекте нет поля «${name}».`, {
      hint: "Заведите его в Taiga: Admin → Attributes → Custom fields.",
    });
  }
  return id;
}
