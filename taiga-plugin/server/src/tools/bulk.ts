import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard, PROJECT_SCHEMA } from "../context.js";
import { TaigaError } from "../errors.js";
import { project, type LabelMaps } from "../projections.js";
import { USER_STORY, TASK, ISSUE, type ResourceDef } from "../resources.js";
import { resolveEpic, linkStoryToEpic, resolveSprint, effectiveRole } from "./crud.js";
import { defineTool } from "../registry.js";
import { pointsPayload } from "../points.js";
import { attributeIds, requireAttribute, writeAttributes } from "../custom-attributes.js";
import { withRoleTag, recalcStoryPoints, type RoleTag } from "../role-points.js";

const MAX_ITEMS = 50;

const BULK_RESOURCES: Record<string, ResourceDef> = {
  userstory: USER_STORY,
  task: TASK,
  issue: ISSUE,
};

/** Fields limited to one resource kind; naming them on the wrong kind is an error, not a silent drop. */
const SINGLE_RESOURCE_FIELDS: Record<string, string> = {
  sprint: "user stories",
  points: "user stories",
  role: "tasks",
  estimate: "tasks",
};

/**
 * Build the id→name maps this resource's projection needs, same as the CRUD
 * create handler does — a bulk-created issue must show priority/severity/type
 * as names too, not the bare ids Taiga's create response echoes back.
 */
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

export function registerBulkTool(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    {
      name: "taiga_bulk_create",
      description:
        `Create up to ${MAX_ITEMS} user stories, tasks or issues in one call. ` +
        "Each item is created independently: a failure in one does not stop the rest. " +
        "Show the user the plan before calling this.",
      input: {
        project: PROJECT_SCHEMA,
        resource: z.enum(["userstory", "task", "issue"]),
        items: z
          .array(z.record(z.unknown()))
          .min(1)
          .describe(
            "Items to create. Each takes the same fields as the matching " +
              "taiga_<resource>_create tool, e.g. {subject, description, status, tags}.",
          ),
      },
      kind: "create",
    },
    guard(async (args) => {
      const a = args as {
        project?: string | number;
        resource: string;
        items: Record<string, unknown>[];
      };

      if (a.items.length > MAX_ITEMS) {
        throw new TaigaError(
          `Refusing to create ${a.items.length} items at once; the limit is ${MAX_ITEMS}.`,
          { hint: "Split the work into smaller batches." },
        );
      }

      const def = BULK_RESOURCES[a.resource];
      const projectId = await ctx.cache.resolveProject(a.project);
      const labels = await buildLabels(ctx, def, projectId);

      // Resolve each distinct epic subject at most once per batch, not once
      // per item — fifty items naming the same epic should not mean fifty
      // lookups. Only meaningful for user stories; done up front so a bad
      // epic name fails every item that names it without touching Taiga for
      // any of them (mirrors how a bad `status` never reaches ctx.client.post
      // below).
      const epicResolutions = new Map<string, { id: number } | { error: string }>();
      if (def.name === "userstory") {
        const names = new Set(
          a.items
            .map((item) => item.epic)
            .filter((value): value is string => typeof value === "string" && value !== ""),
        );
        for (const name of names) {
          try {
            epicResolutions.set(name, { id: await resolveEpic(ctx, projectId, name) });
          } catch (error) {
            epicResolutions.set(name, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      const created: Record<string, unknown>[] = [];
      const failed: { item: Record<string, unknown>; error: string }[] = [];

      // Points get recalculated once per (story, role) pair after the loop,
      // not once per item — fifty tasks landing on the same story and role
      // should mean one recalculation, not fifty.
      const rolePairs = new Map<string, { storyId: number; role: RoleTag; ref: number | null }>();

      for (const item of a.items) {
        try {
          // `epic` only makes sense for user stories; a task/issue item
          // carrying it would otherwise be silently ignored — the exact
          // "success response but no link" problem this field exists to
          // avoid on the single-create path.
          if (def.name !== "userstory" && item.epic !== undefined) {
            throw new TaigaError(
              `"epic" applies to user stories only, not to ${def.label} items.`,
            );
          }
          // A non-string `epic` (number, boolean, object, null) would
          // otherwise fail the `typeof epicValue === "string"` check below
          // silently — the item would be created with no link and no error,
          // the same failure this field exists to avoid, reached through a
          // type mismatch instead of a bad name. The single-create tool's
          // zod schema rejects this before the handler ever runs; bulk items
          // are `z.record(z.unknown())` and need the check done by hand.
          if (def.name === "userstory" && item.epic !== undefined && typeof item.epic !== "string") {
            throw new TaigaError(
              `"epic" must be an epic subject given as a string, not ${typeof item.epic}.`,
            );
          }

          // `sprint`/`points` (user stories) and `role`/`estimate` (tasks)
          // need the same resolution the matching single-create tool gives
          // them, and each is only defined in that one resource's
          // createFields. Sent raw, `points` is an opaque HTTP 500 from
          // Taiga (it stores points as a per-role map) and `sprint` is an
          // unknown field on the serializer: silently dropped, with the item
          // still reported in `created` — the same silent-success failure
          // the `epic` guards above exist to stop. `role`/`estimate` on a
          // user story or issue would be dropped the same way if let through.
          for (const [field, appliesTo] of Object.entries(SINGLE_RESOURCE_FIELDS)) {
            if (item[field] !== undefined && def.createFields[field] === undefined) {
              throw new TaigaError(
                `"${field}" applies to ${appliesTo} only, not to ${def.label} items.`,
              );
            }
          }

          // Reached only for `resource: "task"` items — the loop above
          // already rejected `role`/`estimate` on any other resource. A bad
          // type here would otherwise reach `withRoleTag`/`writeAttributes`
          // as a confusing low-level error instead of a clear one.
          if (item.role !== undefined && typeof item.role !== "string") {
            throw new TaigaError(`"role" must be given as a string, not ${typeof item.role}.`);
          }
          if (item.estimate !== undefined && typeof item.estimate !== "number") {
            throw new TaigaError(
              `"estimate" must be given as a number, not ${typeof item.estimate}.`,
            );
          }
          const role = item.role as string | undefined;
          const estimate = item.estimate as number | undefined;

          const payload: Record<string, unknown> = { project: projectId };
          for (const [key, value] of Object.entries(item)) {
            if (value === undefined || key === "epic" || key === "role" || key === "estimate") {
              continue;
            }
            if (key === "sprint") {
              payload.milestone =
                value === "" ? null : await resolveSprint(ctx, projectId, String(value));
              continue;
            }
            if (key === "points") {
              payload.points = await pointsPayload(
                ctx, projectId, value as string | number | Record<string, string | number>,
              );
              continue;
            }
            const lookup = def.lookups.find((entry) => entry.field === key);
            payload[key] = lookup
              ? await ctx.cache.resolveLookup(
                  projectId, lookup.kind, value as string | number,
                )
              : value;
          }
          // Callers give the parent story by its #ref, exactly as the single
          // taiga_task_create tool does — see crud.ts's create handler.
          if (typeof payload.user_story === "number") {
            payload.user_story = await ctx.cache.resolveRef(
              projectId, "us", payload.user_story as number,
            );
          }

          // Fail this item on a bad epic name before creating anything, so a
          // typo'd epic never leaves an unlinked story behind.
          let epicId: number | undefined;
          const epicValue = item.epic as string | undefined;
          if (typeof epicValue === "string" && epicValue !== "") {
            const resolution = epicResolutions.get(epicValue);
            if (resolution && "error" in resolution) throw new TaigaError(resolution.error);
            epicId = resolution?.id;
          }

          // Checked before the task is created: mirrors taiga_task_create —
          // if «Оценка» is missing, the item fails with nothing created,
          // instead of leaving an orphaned task with no ref to clean up.
          let estimateAttrId: number | undefined;
          if (typeof estimate === "number") {
            const ids = await attributeIds(ctx, projectId, "task");
            estimateAttrId = requireAttribute(ids, "Оценка");
          }
          if (role !== undefined) {
            payload.tags = withRoleTag((payload.tags as string[] | undefined) ?? [], role);
          }

          const row = await ctx.client.post<Record<string, unknown>>(def.path, payload);
          if (epicId !== undefined) {
            await linkStoryToEpic(ctx, epicId, row.id as number);
          }
          if (estimateAttrId !== undefined) {
            await writeAttributes(ctx, "task", row.id as number, { [estimateAttrId]: estimate });
          }
          if (estimate !== undefined || role !== undefined) {
            const forRole = effectiveRole(role, row.tags);
            if (forRole && typeof row.user_story === "number") {
              const storyExtra = row.user_story_extra_info as { ref?: number } | null | undefined;
              rolePairs.set(`${row.user_story}:${forRole}`, {
                storyId: row.user_story,
                role: forRole,
                ref: storyExtra?.ref ?? null,
              });
            }
          }
          created.push(project(def.name, row, "slim", labels));
        } catch (error) {
          failed.push({
            item,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const storyPoints: { user_story: number | null; role: string; from: number | null; to: number }[] = [];
      for (const { storyId, role, ref } of rolePairs.values()) {
        const result = await recalcStoryPoints(ctx, projectId, storyId, role);
        if (result) storyPoints.push({ user_story: ref, ...result });
      }

      return ok(
        storyPoints.length > 0 ? { created, failed, story_points: storyPoints } : { created, failed },
      );
    }),
  );
}
