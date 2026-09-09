import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard } from "../context.js";
import { TaigaError } from "../errors.js";
import { project, type LabelMaps } from "../projections.js";
import { USER_STORY, TASK, ISSUE, type ResourceDef } from "../resources.js";

const MAX_ITEMS = 50;

const BULK_RESOURCES: Record<string, ResourceDef> = {
  userstory: USER_STORY,
  task: TASK,
  issue: ISSUE,
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
  server.tool(
    "taiga_bulk_create",
    `Create up to ${MAX_ITEMS} user stories, tasks or issues in one call. ` +
      "Each item is created independently: a failure in one does not stop the rest. " +
      "Show the user the plan before calling this.",
    {
      project: z.union([z.string(), z.number()]).optional()
        .describe("Project id or slug. Defaults to TAIGA_PROJECT."),
      resource: z.enum(["userstory", "task", "issue"]),
      items: z
        .array(z.record(z.unknown()))
        .min(1)
        .describe(
          "Items to create. Each takes the same fields as the matching " +
            "taiga_<resource>_create tool, e.g. {subject, description, status, tags}.",
        ),
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

      const created: Record<string, unknown>[] = [];
      const failed: { item: Record<string, unknown>; error: string }[] = [];

      for (const item of a.items) {
        try {
          const payload: Record<string, unknown> = { project: projectId };
          for (const [key, value] of Object.entries(item)) {
            if (value === undefined) continue;
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
          const row = await ctx.client.post<Record<string, unknown>>(def.path, payload);
          created.push(project(def.name, row, "slim", labels));
        } catch (error) {
          failed.push({
            item,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return ok({ created, failed });
    }),
  );
}
