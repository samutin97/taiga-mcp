import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard } from "../context.js";

export function registerWhoamiTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "taiga_whoami",
    "Show the authenticated Taiga user and the projects they can access. " +
      "Use this to verify the connection and to discover project slugs.",
    {},
    guard(async () => {
      const me = await ctx.client.get<Record<string, unknown>>("/users/me");
      const projects = await ctx.client.list<Record<string, unknown>>("/projects", {
        member: me.id as number,
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
