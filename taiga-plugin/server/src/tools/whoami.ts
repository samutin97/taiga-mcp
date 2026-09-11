import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard } from "../context.js";
import { defineTool } from "../registry.js";

export function registerWhoamiTool(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    {
      name: "taiga_whoami",
      description:
        "Show the authenticated Taiga user and the projects they can access. " +
        "Use this to verify the connection and to discover project slugs.",
      input: {},
      kind: "read",
    },
    guard(async () => {
      const me = await ctx.client.get<Record<string, unknown>>("/users/me");
      // page_size explicit: Taiga's default page (30) would silently hide
      // projects from someone who is a member of more than that.
      const projects = await ctx.client.list<Record<string, unknown>>("/projects", {
        member: me.id as number,
        page_size: 1000,
      });
      return ok({
        id: me.id,
        username: me.username,
        full_name: me.full_name_display,
        email: me.email,
        default_project: ctx.config.defaultProject ?? null,
        projects: projects.items.map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
        })),
      });
    }),
  );
}
