import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard, PROJECT_SCHEMA } from "../context.js";
import { TaigaError } from "../errors.js";
import { defineTool } from "../registry.js";

interface MilestoneStats {
  name: string;
  estimated_start: string;
  estimated_finish: string;
  total_points: Record<string, number>;
  completed_points: number[];
  completed_userstories: number;
  completed_tasks: number;
  days: { day: string; name?: number; open_points: number; optimal_points: number }[];
}

export function registerStatsTool(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    {
      name: "taiga_stats",
      description:
        "Progress statistics. With `sprint` it returns that sprint's points, completed " +
        "work and a day-by-day burndown series. Without it, project-wide totals and velocity.",
      input: {
        project: PROJECT_SCHEMA,
        sprint: z.string().optional()
          .describe("Sprint name, e.g. 'Sprint 2'. Omit for project-wide stats."),
      },
      kind: "read",
    },
    guard(async (args) => {
      const a = args as { project?: string | number; sprint?: string };
      const projectId = await ctx.cache.resolveProject(a.project);

      if (!a.sprint) {
        const stats = await ctx.client.get<Record<string, unknown>>(
          `/projects/${projectId}/stats`,
        );
        return ok({
          scope: "project",
          name: stats.name,
          total_points: stats.total_points ?? stats.defined_points,
          defined_points: stats.defined_points,
          assigned_points: stats.assigned_points,
          closed_points: stats.closed_points,
          speed: stats.speed,
          milestones: stats.milestones,
        });
      }

      const milestones = await ctx.client.list<{ id: number; name: string }>(
        "/milestones",
        { project: projectId, page_size: 1000 },
      );
      const match = milestones.items.find(
        (m) => m.name.toLowerCase() === a.sprint!.trim().toLowerCase(),
      );
      if (!match) {
        throw new TaigaError(`"${a.sprint}" is not a sprint in this project.`, {
          hint: `Sprints: ${milestones.items.map((m) => m.name).join(", ")}`,
        });
      }

      const stats = await ctx.client.get<MilestoneStats>(`/milestones/${match.id}/stats`);
      const points = Object.values(stats.total_points ?? {}).reduce(
        (sum, value) => sum + (value ?? 0),
        0,
      );
      const completed = stats.completed_points.reduce((s, v) => s + (v ?? 0), 0);
      return ok({
        scope: "sprint",
        name: stats.name,
        starts: stats.estimated_start,
        finishes: stats.estimated_finish,
        total_points: points,
        completed_points: completed,
        completed_userstories: stats.completed_userstories,
        completed_tasks: stats.completed_tasks,
        burndown: (stats.days ?? []).map((day) => ({
          day: day.day,
          open_points: day.open_points,
          optimal_points: day.optimal_points,
        })),
      });
    }),
  );
}
