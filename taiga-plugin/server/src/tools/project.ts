import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard, FIELDS_SCHEMA, asFieldMode } from "../context.js";
import { project, projectMany } from "../projections.js";

const projectRef = z
  .union([z.string(), z.number()])
  .optional()
  .describe("Project id or slug; defaults to TAIGA_PROJECT.");

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "taiga_project_list",
    "List the Taiga projects the current user is a member of.",
    { fields: FIELDS_SCHEMA },
    guard(async ({ fields }) => {
      const me = await ctx.client.get<{ id: number }>("/users/me");
      // page_size explicit: Taiga's default page (30) would silently hide
      // projects from someone who is a member of more than that.
      const result = await ctx.client.list<Record<string, unknown>>("/projects", {
        member: me.id,
        page_size: 1000,
      });
      return ok({
        total: result.total,
        items: projectMany("project", result.items, asFieldMode(fields)),
      });
    }),
  );

  server.tool(
    "taiga_project_get",
    "Get one Taiga project by id or slug.",
    { project: projectRef, fields: FIELDS_SCHEMA },
    guard(async ({ project: ref, fields }) => {
      const id = await ctx.cache.resolveProject(ref);
      const raw = await ctx.client.get<Record<string, unknown>>(`/projects/${id}`);
      return ok(project("project", raw, asFieldMode(fields)));
    }),
  );

  server.tool(
    "taiga_project_schema",
    "List the valid statuses, priorities, severities, issue types, points, roles " +
      "and members of a project. Use it to show the user what values are allowed; " +
      "you do not need it before writing, because status and person names are " +
      "resolved automatically.",
    { project: projectRef },
    guard(async ({ project: ref }) => {
      const id = await ctx.cache.resolveProject(ref);
      return ok(await ctx.cache.schema(id));
    }),
  );
}
