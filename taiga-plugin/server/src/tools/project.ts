import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard, FIELDS_SCHEMA, PROJECT_SCHEMA, asFieldMode } from "../context.js";
import { project, projectMany } from "../projections.js";
import { defineTool } from "../registry.js";

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    {
      name: "taiga_project_list",
      description:
        "List the Taiga projects the current user is a member of. " +
        "If TAIGA_PROJECT is set, every other tool defaults to it.",
      input: { fields: FIELDS_SCHEMA },
      kind: "read",
    },
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

  defineTool(
    server,
    ctx,
    {
      name: "taiga_project_get",
      description: "Get one Taiga project by id or slug.",
      input: { project: PROJECT_SCHEMA, fields: FIELDS_SCHEMA },
      kind: "read",
    },
    guard(async ({ project: ref, fields }) => {
      const id = await ctx.cache.resolveProject(ref);
      const raw = await ctx.client.get<Record<string, unknown>>(`/projects/${id}`);
      return ok(project("project", raw, asFieldMode(fields)));
    }),
  );

  defineTool(
    server,
    ctx,
    {
      name: "taiga_project_schema",
      description:
        "List the valid statuses, priorities, severities, issue types, points, roles " +
        "and members of a project. Members include their username and role in the project. " +
        "Use it to show the user what values are allowed; " +
        "you do not need it before writing, because status and person names are " +
        "resolved automatically.",
      input: { project: PROJECT_SCHEMA },
      kind: "read",
    },
    guard(async ({ project: ref }) => {
      const id = await ctx.cache.resolveProject(ref);
      return ok(await ctx.cache.schema(id));
    }),
  );
}
