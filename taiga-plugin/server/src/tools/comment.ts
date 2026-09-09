import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard } from "../context.js";
import { TaigaError } from "../errors.js";

/** Resources that carry a comment thread, mapped to their /history/ segment. */
const COMMENTABLE = {
  userstory: { path: "/userstories", history: "userstory", resolverKey: "us" },
  task: { path: "/tasks", history: "task", resolverKey: "task" },
  issue: { path: "/issues", history: "issue", resolverKey: "issue" },
  epic: { path: "/epics", history: "epic", resolverKey: "epic" },
} as const;

type Commentable = keyof typeof COMMENTABLE;

const resourceArg = z
  .enum(["userstory", "task", "issue", "epic"])
  .describe("Which kind of item the comment belongs to.");

async function locateItem(
  ctx: ToolContext,
  resource: Commentable,
  projectId: number,
  id?: number,
  ref?: number,
): Promise<number> {
  if (typeof id === "number") return id;
  if (typeof ref === "number") {
    return ctx.cache.resolveRef(projectId, COMMENTABLE[resource].resolverKey, ref);
  }
  throw new TaigaError("Specify the item by `ref` (the #number) or `id`.");
}

export function registerCommentTools(server: McpServer, ctx: ToolContext): void {
  const common = {
    project: z.union([z.string(), z.number()]).optional()
      .describe("Project id or slug. Defaults to TAIGA_PROJECT."),
    resource: resourceArg,
    id: z.number().optional().describe("Internal item id."),
    ref: z.number().optional().describe("The #number shown in Taiga."),
  };

  server.tool(
    "taiga_comment_list",
    "List the comments on a user story, task, issue or epic, oldest first.",
    common,
    guard(async (args) => {
      const a = args as Record<string, unknown>;
      const resource = a.resource as Commentable;
      const projectId = await ctx.cache.resolveProject(a.project as string | undefined);
      const id = await locateItem(
        ctx, resource, projectId, a.id as number | undefined, a.ref as number | undefined,
      );

      const history = await ctx.client.get<Record<string, unknown>[]>(
        `/history/${COMMENTABLE[resource].history}/${id}`,
      );
      const items = history
        .filter((entry) => typeof entry.comment === "string" && entry.comment !== "")
        .map((entry) => ({
          author:
            (entry.user as Record<string, unknown> | undefined)?.name ?? null,
          created_at: entry.created_at,
          comment: entry.comment,
        }))
        .reverse();

      return ok({ total: items.length, items });
    }),
  );

  server.tool(
    "taiga_comment_add",
    "Add a comment to a user story, task, issue or epic.",
    { ...common, comment: z.string().min(1).describe("Comment text (Markdown).") },
    guard(async (args) => {
      const a = args as Record<string, unknown>;
      const resource = a.resource as Commentable;
      const projectId = await ctx.cache.resolveProject(a.project as string | undefined);
      const id = await locateItem(
        ctx, resource, projectId, a.id as number | undefined, a.ref as number | undefined,
      );

      // Taiga takes a comment as a field on PATCH, not as its own resource.
      await ctx.client.patch(COMMENTABLE[resource].path, id, {
        comment: a.comment as string,
      });
      return ok({ added: true, resource, id });
    }),
  );
}
