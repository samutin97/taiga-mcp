import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard, PROJECT_SCHEMA } from "../context.js";
import { TaigaError } from "../errors.js";
import { defineTool } from "../registry.js";
import { attributeIds, readAttributes } from "../custom-attributes.js";
import { effectiveRole } from "../role-points.js";

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

/** Team capacity rule: 40 story points per developer per two-week sprint. */
const CAPACITY_PER_SPRINT = 40;

/** Bucket label for tasks nobody is assigned to — never merged into a person's load. */
const UNASSIGNED_LABEL = "Без исполнителя";

const NO_ESTIMATE_ATTRIBUTE_NOTE = "Оценок задач в проекте нет: заведите поле «Оценка» у задач.";

interface LoadRow {
  member: string;
  /** Real member's user id; `null` for the "Без исполнителя" bucket — never confused with a same-named person. */
  member_id: number | null;
  /** Sum of «Оценка» across every role this person has estimated tasks in. */
  points: number;
  of_capacity: number;
  /** This person's tasks with no «Оценка» value — hidden from `points`, not from the count. */
  unestimated_tasks: number;
  /** Only roles with at least one estimated task; a role with only unestimated tasks is absent, not zero. */
  by_role: Record<string, number>;
}

/**
 * Who is carrying how much of a sprint — one row per assignee, capacity
 * being a per-person rule (40 points/sprint), not a per-role one. `by_role`
 * keeps the split a role-distribution skill needs without multiplying rows.
 * Unassigned tasks are their own "member" bucket (`UNASSIGNED_LABEL`,
 * `member_id: null`), never a real person's load.
 *
 * Costs one request to check the «Оценка» field exists, one to list the
 * sprint's tasks (skipped entirely if the field is missing), and one more
 * per task to read its estimate.
 */
async function sprintLoad(
  ctx: ToolContext,
  projectId: number,
  milestoneId: number,
): Promise<{ load: LoadRow[]; load_note?: string }> {
  const attrIds = await attributeIds(ctx, projectId, "task");
  const estimateAttrId = attrIds.get("Оценка");
  if (estimateAttrId === undefined) {
    return { load: [], load_note: NO_ESTIMATE_ATTRIBUTE_NOTE };
  }

  const { items } = await ctx.client.list<Record<string, unknown>>("/tasks", {
    project: projectId,
    milestone: milestoneId,
    page_size: 1000,
  });
  const names = await ctx.cache.labelMap(projectId, "member");

  interface Bucket {
    member: string;
    member_id: number | null;
    points: number;
    unestimated: number;
    by_role: Map<string, number>;
  }
  const buckets = new Map<string, Bucket>();

  for (const task of items) {
    const assignedTo = task.assigned_to as number | null | undefined;
    const isAssigned = typeof assignedTo === "number";
    const role = effectiveRole(undefined, task.tags) ?? null;
    const key = isAssigned ? String(assignedTo) : "none";

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        member: isAssigned ? (names.get(assignedTo) ?? `#${assignedTo}`) : UNASSIGNED_LABEL,
        member_id: isAssigned ? assignedTo : null,
        points: 0,
        unestimated: 0,
        by_role: new Map(),
      };
      buckets.set(key, bucket);
    }

    const values = await readAttributes(ctx, "task", task.id as number);
    const raw = values[String(estimateAttrId)];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (raw !== undefined && raw !== null && Number.isFinite(value)) {
      bucket.points += value;
      if (role !== null) bucket.by_role.set(role, (bucket.by_role.get(role) ?? 0) + value);
    } else {
      bucket.unestimated += 1;
    }
  }

  const load = [...buckets.values()]
    .map((bucket) => ({
      member: bucket.member,
      member_id: bucket.member_id,
      points: bucket.points,
      of_capacity: Math.round((bucket.points / CAPACITY_PER_SPRINT) * 100) / 100,
      unestimated_tasks: bucket.unestimated,
      by_role: Object.fromEntries(bucket.by_role),
    }))
    .sort((a, b) => {
      if (a.member === UNASSIGNED_LABEL && b.member !== UNASSIGNED_LABEL) return 1;
      if (b.member === UNASSIGNED_LABEL && a.member !== UNASSIGNED_LABEL) return -1;
      return a.member.localeCompare(b.member);
    });

  return { load };
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
      const { load, load_note } = await sprintLoad(ctx, projectId, match.id);
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
        load,
        load_note,
      });
    }),
  );
}
