import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard } from "../context.js";
import { projectMany, type LabelMaps, type ResourceName } from "../projections.js";

export function registerSearchTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "taiga_search",
    "Full-text search across a project's user stories, tasks, issues, epics and " +
      "wiki pages. Use it when you know roughly what an item is called but not its #ref.",
    {
      project: z.union([z.string(), z.number()]).optional()
        .describe("Project id or slug. Defaults to TAIGA_PROJECT."),
      text: z.string().min(1).describe("Search query."),
    },
    guard(async (args) => {
      const a = args as { project?: string | number; text: string };
      const projectId = await ctx.cache.resolveProject(a.project);
      const found = await ctx.client.get<Record<string, Record<string, unknown>[] | number>>(
        "/search",
        { project: projectId, text: a.text },
      );

      // /search omits every *_extra_info object and sends bare numeric ids
      // instead (status on userstory/task/issue/epic hits, assigned_to on
      // issue hits, priority/severity/type on issue hits, last_modifier on
      // wikipage hits) — the exact shape the label mechanism exists to
      // translate. Each resource has its own status table, so these must
      // not be shared across buckets.
      const [userstoryStatus, taskStatus, issueStatus, priority, severity, type, member] =
        await Promise.all([
          ctx.cache.labelMap(projectId, "userstory-status"),
          ctx.cache.labelMap(projectId, "task-status"),
          ctx.cache.labelMap(projectId, "issue-status"),
          ctx.cache.labelMap(projectId, "priority"),
          ctx.cache.labelMap(projectId, "severity"),
          ctx.cache.labelMap(projectId, "issue-type"),
          ctx.cache.labelMap(projectId, "member"),
        ]);
      const userstoryLabels: LabelMaps = { status: userstoryStatus, member };
      const taskLabels: LabelMaps = { status: taskStatus, member };
      const issueLabels: LabelMaps = { status: issueStatus, priority, severity, type, member };
      const epicLabels: LabelMaps = { member };
      const wikiLabels: LabelMaps = { member };

      const bucket = (
        key: string,
        resource: ResourceName,
        labels: LabelMaps = {},
      ) => projectMany(resource, (found[key] as Record<string, unknown>[]) ?? [], "slim", labels);

      return ok({
        count: found.count ?? 0,
        userstories: bucket("userstories", "userstory", userstoryLabels),
        tasks: bucket("tasks", "task", taskLabels),
        issues: bucket("issues", "issue", issueLabels),
        epics: bucket("epics", "epic", epicLabels),
        wikipages: bucket("wikipages", "wiki", wikiLabels),
      });
    }),
  );
}
