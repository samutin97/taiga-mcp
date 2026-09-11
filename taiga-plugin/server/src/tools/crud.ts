import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard, FIELDS_SCHEMA, PROJECT_SCHEMA, asFieldMode } from "../context.js";
import { project, projectMany, type LabelMaps } from "../projections.js";
import { TaigaError } from "../errors.js";
import type { ResourceDef } from "../resources.js";

/** Build the id→name maps this resource's projection needs. Empty for most resources. */
async function buildLabels(
  ctx: ToolContext,
  def: ResourceDef,
  projectId: number,
): Promise<LabelMaps> {
  const wanted = def.labels ?? [];
  const resolved = await Promise.all(
    wanted.map(async ({ map, kind }) => [map, await ctx.cache.labelMap(projectId, kind)] as const),
  );
  return Object.fromEntries(resolved) as LabelMaps;
}

/** Resolve the caller's `id` or `ref` into an internal object id. */
async function locate(
  ctx: ToolContext,
  def: ResourceDef,
  projectId: number,
  args: { id?: number; ref?: number; slug?: string },
): Promise<number> {
  if (typeof args.id === "number") return args.id;
  if (typeof args.ref === "number" && def.resolverKey) {
    return ctx.cache.resolveRef(projectId, def.resolverKey, args.ref);
  }
  if (args.slug) {
    // page_size explicit: Taiga's default page (30) would silently hide a
    // valid slug on a project with more milestones/wiki pages than that.
    const found = await ctx.client.list<{ id: number; slug: string }>(def.path, {
      project: projectId,
      page_size: 1000,
    });
    // Some Taiga list endpoints ignore a ?slug= filter and return everything,
    // so match here rather than trusting the server to have filtered.
    const match = found.items.find((item) => item.slug === args.slug);
    if (!match) {
      throw new TaigaError(`No ${def.label} with slug "${args.slug}" in this project.`, {
        hint: `Available: ${found.items.map((i) => i.slug).join(", ")}`,
      });
    }
    return match.id;
  }
  throw new TaigaError(
    `Specify which ${def.label} to act on.`,
    { hint: def.hasRef ? "Pass `ref` (the #number) or `id`." : "Pass `slug` or `id`." },
  );
}

/**
 * Fields Taiga stores as a nullable foreign key or date, where the caller
 * needs a way to say "none" — unassign a person, drop a due date. The empty
 * string is that way, following the convention `epic: ""` already set, and
 * `sprint` gets the same treatment where it is turned into `milestone`.
 * Text fields are deliberately absent: "" is already a meaningful value there.
 */
const CLEARABLE = new Set(["assigned_to", "due_date"]);

/** Translate human-readable field values into the numeric ids Taiga expects. */
async function resolveFields(
  ctx: ToolContext,
  def: ResourceDef,
  projectId: number,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value === "" && CLEARABLE.has(key)) {
      output[key] = null;
      continue;
    }
    const lookup = def.lookups.find((entry) => entry.field === key);
    if (lookup && (typeof value === "string" || typeof value === "number")) {
      output[key] = await ctx.cache.resolveLookup(projectId, lookup.kind, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

/**
 * Resolve a sprint name to its milestone id.
 * Exported so `taiga_bulk_create` can reuse it instead of passing the name
 * straight through, which Taiga's serializer silently ignores.
 */
export async function resolveSprint(
  ctx: ToolContext,
  projectId: number,
  name: string,
): Promise<number> {
  // page_size explicit: Taiga's default page (30) would silently hide a
  // valid sprint name on a project with more milestones than that.
  const milestones = await ctx.client.list<{ id: number; name: string }>("/milestones", {
    project: projectId,
    page_size: 1000,
  });
  const match = milestones.items.find(
    (m) => m.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (!match) {
    throw new TaigaError(`"${name}" is not a sprint in this project.`, {
      hint: `Sprints: ${milestones.items.map((m) => m.name).join(", ")}`,
    });
  }
  return match.id;
}

/**
 * Resolve an epic subject to its id for the `epic` list filter.
 *
 * Verified live: Taiga's /userstories?epic= filter expects a numeric epic id
 * and returns an HTTP 500 (not a 400) when given the subject text the tool
 * schema advertises, so the subject has to be resolved here first.
 */
export async function resolveEpic(
  ctx: ToolContext,
  projectId: number,
  subject: string,
): Promise<number> {
  // page_size explicit: Taiga's default page (30) would silently hide a
  // valid epic subject on a project with more epics than that.
  const epics = await ctx.client.list<{ id: number; subject: string }>("/epics", {
    project: projectId,
    page_size: 1000,
  });
  const match = epics.items.find(
    (e) => e.subject.toLowerCase() === subject.trim().toLowerCase(),
  );
  if (!match) {
    throw new TaigaError(`"${subject}" is not an epic in this project.`, {
      hint: `Epics: ${epics.items.map((e) => e.subject).join(", ")}`,
    });
  }
  return match.id;
}

/**
 * Link a story to an epic. Taiga models this as its own many-to-many
 * resource, not a field on the story — verified live: `infra/seed_test_data.py`
 * links stories to epics via exactly this call.
 * Exported so `taiga_bulk_create` can reuse it instead of duplicating the
 * request shape.
 */
export async function linkStoryToEpic(
  ctx: ToolContext,
  epicId: number,
  storyId: number,
): Promise<void> {
  await ctx.client.post(`/epics/${epicId}/related_userstories`, {
    epic: epicId,
    user_story: storyId,
  });
}

/**
 * Link a story to an epic, or — when `epic` is the empty string — unlink it
 * from every epic it currently belongs to.
 *
 * The matching unlink endpoint, confirmed against the local stand the same
 * way as the link one, is `DELETE /epics/{epicId}/related_userstories/{userStoryId}`.
 */
async function applyEpicLink(
  ctx: ToolContext,
  projectId: number,
  storyId: number,
  epic: string,
  currentEpics: { id: number }[] | null,
): Promise<void> {
  if (epic === "") {
    for (const linked of currentEpics ?? []) {
      await ctx.client.remove(`/epics/${linked.id}/related_userstories`, storyId);
    }
    return;
  }
  const epicId = await resolveEpic(ctx, projectId, epic);
  await linkStoryToEpic(ctx, epicId, storyId);
}

/**
 * Resolve a human points value (e.g. "5") to the per-role map Taiga's
 * userstory.points field actually requires.
 *
 * Verified live: Taiga stores points as `{ roleId: pointsEntryId }`, one
 * entry per computable role. Sending a bare string or number — the shape the
 * brief's draft schema implied — crashes the server with an opaque HTTP 500
 * instead of a validation error. The value is written to the project's
 * primary role (lowest `order` among computable roles); Taiga defaults any
 * other computable role to "unestimated" on create and leaves it untouched
 * on update, so a single human value maps onto the per-role model without
 * the caller ever seeing roles.
 *
 * Exported so `taiga_bulk_create` can reuse it: a bare string here is the
 * HTTP 500 described above.
 */
export async function resolvePoints(
  ctx: ToolContext,
  projectId: number,
  value: string | number,
): Promise<Record<string, number>> {
  const pointsId = await ctx.cache.resolveLookup(projectId, "points", value);
  // page_size explicit: Taiga's default page (30) would silently hide a
  // computable role on a project with more roles than that, and the "primary"
  // role picked below would then be the wrong one.
  const roles = await ctx.client.list<{ id: number; order: number; computable: boolean }>(
    "/roles",
    { project: projectId, page_size: 1000 },
  );
  const primary = roles.items
    .filter((role) => role.computable)
    .sort((a, b) => a.order - b.order)[0];
  if (!primary) {
    throw new TaigaError("This project has no computable role to hold story points.");
  }
  return { [primary.id]: pointsId };
}

export function registerCrudTools(
  server: McpServer,
  ctx: ToolContext,
  def: ResourceDef,
): void {
  const idArgs = {
    id: z.number().optional().describe(`Internal ${def.label} id.`),
    ...(def.hasRef
      ? { ref: z.number().optional().describe(`The #number shown in Taiga.`) }
      : {}),
    ...(def.name === "wiki" || def.name === "sprint"
      ? { slug: z.string().optional().describe("Slug.") }
      : {}),
  };

  server.tool(
    `taiga_${def.name}_list`,
    `List ${def.label} items in a Taiga project. Returns a slim projection by default. ` +
      `For name lookup use taiga_search.`,
    {
      project: PROJECT_SCHEMA,
      ...def.listFilters,
      limit: z.number().max(200).optional().describe("Max items to return. Default 50."),
      page: z.number().optional().describe("1-based page number."),
      fields: FIELDS_SCHEMA,
    },
    guard(async (args) => {
      const { project: ref, fields, limit, page, ...filters } = args as Record<string, unknown>;

      // Both of these write `params.milestone` below; whichever the loop
      // reached last used to win, with the other silently discarded.
      if (filters.sprint !== undefined && filters.in_backlog === true) {
        throw new TaigaError(
          "Pass either `sprint` or `in_backlog: true`, not both.",
          { hint: "`in_backlog: true` means no sprint at all." },
        );
      }

      const projectId = await ctx.cache.resolveProject(ref as string | number | undefined);

      const params: Record<string, string | number | undefined> = {
        project: projectId,
        page: page as number | undefined,
        page_size: (limit as number | undefined) ?? 50,
      };

      for (const [key, value] of Object.entries(filters)) {
        if (value === undefined) continue;
        if (key === "sprint") {
          params.milestone = await resolveSprint(ctx, projectId, String(value));
        } else if (key === "in_backlog") {
          // Taiga wants the literal string "null" here, not the boolean.
          // No inverse form on this endpoint: `in_backlog: false` means "no
          // opinion" — nothing sent — not "assigned to a sprint", since
          // that is already what a plain, unfiltered call returns.
          if (value === true) params.milestone = "null";
        } else if (key === "epic") {
          params.epic = await resolveEpic(ctx, projectId, String(value));
        } else if (key === "user_story") {
          // Taiga filters tasks by the story's internal id; callers give the #ref.
          params.user_story = await ctx.cache.resolveRef(projectId, "us", Number(value));
        } else if (key === "tags") {
          params.tags = (value as string[]).join(",");
        } else {
          const lookup = def.lookups.find((entry) => entry.field === key);
          params[key] = lookup
            ? await ctx.cache.resolveLookup(projectId, lookup.kind, value as string)
            : (value as string | number);
        }
      }

      const result = await ctx.client.list<Record<string, unknown>>(def.path, params);
      const labels = await buildLabels(ctx, def, projectId);
      return ok({
        total: result.total,
        page: result.page,
        has_more: result.hasMore,
        items: projectMany(def.name, result.items, asFieldMode(fields), labels),
      });
    }),
  );

  server.tool(
    `taiga_${def.name}_get`,
    `Get one ${def.label} by its #ref number or internal id.`,
    { project: PROJECT_SCHEMA, ...idArgs, fields: FIELDS_SCHEMA },
    guard(async (args) => {
      const a = args as Record<string, unknown>;
      const projectId = await ctx.cache.resolveProject(a.project as string | undefined);
      const id = await locate(ctx, def, projectId, a);
      const raw = await ctx.client.get<Record<string, unknown>>(`${def.path}/${id}`);
      const labels = await buildLabels(ctx, def, projectId);
      return ok(project(def.name, raw, asFieldMode(a.fields), labels));
    }),
  );

  server.tool(
    `taiga_${def.name}_create`,
    `Create a ${def.label}. Status and assignee are given by name, not by id.`,
    { project: PROJECT_SCHEMA, ...def.createFields },
    guard(async (args) => {
      const { project: ref, sprint, points, epic, ...rest } = args as Record<string, unknown>;
      const projectId = await ctx.cache.resolveProject(ref as string | undefined);
      const payload = await resolveFields(ctx, def, projectId, rest);
      payload.project = projectId;
      // Callers give the parent story by its #ref, which is what they see in Taiga.
      if (typeof payload.user_story === "number") {
        payload.user_story = await ctx.cache.resolveRef(projectId, "us", payload.user_story as number);
      }
      if (typeof sprint === "string") {
        payload.milestone = sprint === "" ? null : await resolveSprint(ctx, projectId, sprint);
      }
      if (points !== undefined) {
        payload.points = await resolvePoints(ctx, projectId, points as string | number);
      }
      const created = await ctx.client.post<Record<string, unknown>>(def.path, payload);
      // The link needs the story's id, so it can only happen after create
      // returns. An empty string here (nothing to unlink yet) is a no-op.
      if (typeof epic === "string" && epic !== "") {
        await applyEpicLink(ctx, projectId, created.id as number, epic, null);
      }
      const labels = await buildLabels(ctx, def, projectId);
      return ok(project(def.name, created, "slim", labels));
    }),
  );

  server.tool(
    `taiga_${def.name}_update`,
    `Update a ${def.label}. Only the fields you pass are changed; the current ` +
      `version is read and sent automatically.` +
      (def.supportsAppend
        ? ` Use append_description and add_tags to add without overwriting.`
        : ""),
    {
      project: PROJECT_SCHEMA,
      ...idArgs,
      ...def.updateFields,
      ...(def.supportsAppend
        ? {
            append_description: z
              .string()
              .optional()
              .describe("Text to append to the existing description."),
            add_tags: z
              .array(z.string())
              .optional()
              .describe("Tags to add, keeping the existing ones."),
          }
        : {}),
    },
    guard(async (args) => {
      const a = { ...(args as Record<string, unknown>) };
      const projectId = await ctx.cache.resolveProject(a.project as string | undefined);
      const id = await locate(ctx, def, projectId, a);

      const appendText = a.append_description as string | undefined;
      const addTags = a.add_tags as string[] | undefined;
      const sprint = a.sprint as string | undefined;
      const points = a.points as string | number | undefined;
      const epic = a.epic as string | undefined;
      for (const key of [
        "project", "id", "ref", "slug", "append_description", "add_tags", "sprint", "points", "epic",
      ]) {
        delete a[key];
      }

      const changes = await resolveFields(ctx, def, projectId, a);
      // Callers give the parent story by its #ref, which is what they see in Taiga.
      if (typeof changes.user_story === "number") {
        changes.user_story = await ctx.cache.resolveRef(projectId, "us", changes.user_story as number);
      }
      // "" moves the story back to the backlog, mirroring `epic: ""`.
      if (sprint !== undefined) {
        changes.milestone = sprint === "" ? null : await resolveSprint(ctx, projectId, sprint);
      }
      if (points !== undefined) {
        changes.points = await resolvePoints(ctx, projectId, points);
      }

      if (appendText !== undefined || addTags !== undefined) {
        // A value passed in this same call (already resolved into `changes`)
        // takes precedence over the server's current value as the base to
        // append/add onto — otherwise an explicit `description`/`tags` here
        // would be silently discarded in favour of the stale server value.
        const current = await ctx.client.get<Record<string, unknown>>(
          `${def.path}/${id}`,
        );
        if (appendText !== undefined) {
          const base =
            typeof changes.description === "string"
              ? changes.description
              : ((current.description as string | null) ?? "");
          changes.description = base ? `${base}\n\n${appendText}` : appendText;
        }
        if (addTags !== undefined) {
          const base = Array.isArray(changes.tags)
            ? (changes.tags as string[])
            : Array.isArray(current.tags)
              ? (current.tags as unknown[]).map((t) => (Array.isArray(t) ? t[0] : t))
              : [];
          changes.tags = [...new Set([...(base as string[]), ...addTags])];
        }
      }

      if (Object.keys(changes).length === 0 && epic === undefined) {
        throw new TaigaError(`Nothing to change on this ${def.label}.`);
      }

      // Skip a no-op PATCH when linking/unlinking the epic is the only
      // requested change; the story's current data (including its existing
      // epic links, needed below to unlink) comes from a plain read instead.
      const updated =
        Object.keys(changes).length > 0
          ? await ctx.client.patch<Record<string, unknown>>(def.path, id, changes)
          : await ctx.client.get<Record<string, unknown>>(`${def.path}/${id}`);

      if (epic !== undefined) {
        await applyEpicLink(
          ctx, projectId, id, epic, updated.epics as { id: number }[] | null,
        );
      }

      const labels = await buildLabels(ctx, def, projectId);
      return ok(project(def.name, updated, "slim", labels));
    }),
  );

  server.tool(
    `taiga_${def.name}_delete`,
    `Permanently delete a ${def.label}. Requires confirm: true. ` +
      `Ask the user before calling this.`,
    {
      project: PROJECT_SCHEMA,
      ...idArgs,
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true. Guards against accidental deletion."),
    },
    guard(async (args) => {
      const a = args as Record<string, unknown>;
      if (a.confirm !== true) {
        throw new TaigaError(
          `Refusing to delete this ${def.label} without confirm: true.`,
          { hint: "Ask the user first, then call again with confirm: true." },
        );
      }
      const projectId = await ctx.cache.resolveProject(a.project as string | undefined);
      const id = await locate(ctx, def, projectId, a);
      await ctx.client.remove(def.path, id);
      return ok({ deleted: true, resource: def.name, id });
    }),
  );
}
