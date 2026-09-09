import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard } from "../context.js";
import { TaigaError } from "../errors.js";

/** Resources that carry attachments, mapped to their /attachments segment. */
const ATTACHABLE = {
  userstory: { path: "/userstories/attachments", resolverKey: "us" },
  task: { path: "/tasks/attachments", resolverKey: "task" },
  issue: { path: "/issues/attachments", resolverKey: "issue" },
  epic: { path: "/epics/attachments", resolverKey: "epic" },
} as const;

type Attachable = keyof typeof ATTACHABLE;

// Shared by all three tools below; written once and reused to stay inside
// the schema character budget.
const common = {
  project: z.union([z.string(), z.number()]).optional()
    .describe("Project id or slug. Defaults to TAIGA_PROJECT."),
  resource: z.enum(["userstory", "task", "issue", "epic"])
    .describe("Which kind of item the attachment belongs to."),
  id: z.number().optional().describe("Internal item id."),
  ref: z.number().optional().describe("The #number shown in Taiga."),
};

async function locate(
  ctx: ToolContext, resource: Attachable, projectId: number,
  id?: number, ref?: number,
): Promise<number> {
  if (typeof id === "number") return id;
  if (typeof ref === "number") {
    return ctx.cache.resolveRef(projectId, ATTACHABLE[resource].resolverKey, ref);
  }
  throw new TaigaError("Specify the item by `ref` (the #number) or `id`.");
}

function slim(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    url: row.url,
    created_date: row.created_date,
  };
}

export function registerAttachmentTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "taiga_attachment_list",
    "List the files attached to a user story, task, issue or epic.",
    common,
    guard(async (args) => {
      const a = args as Record<string, unknown>;
      const resource = a.resource as Attachable;
      const projectId = await ctx.cache.resolveProject(a.project as string | undefined);
      const objectId = await locate(
        ctx, resource, projectId, a.id as number | undefined, a.ref as number | undefined,
      );
      const result = await ctx.client.list<Record<string, unknown>>(
        ATTACHABLE[resource].path,
        { project: projectId, object_id: objectId },
      );
      return ok({ total: result.total, items: result.items.map(slim) });
    }),
  );

  server.tool(
    "taiga_attachment_upload",
    "Attach a local file to a user story, task, issue or epic.",
    { ...common, file_path: z.string().describe("Absolute path to the file to upload.") },
    guard(async (args) => {
      const a = args as Record<string, unknown>;
      const resource = a.resource as Attachable;
      const filePath = a.file_path as string;

      let data: Buffer;
      try {
        data = await readFile(filePath);
      } catch {
        throw new TaigaError(`Cannot read the file "${filePath}".`, {
          hint: "Pass an absolute path to a file that exists.",
        });
      }

      const projectId = await ctx.cache.resolveProject(a.project as string | undefined);
      const objectId = await locate(
        ctx, resource, projectId, a.id as number | undefined, a.ref as number | undefined,
      );

      const form = new FormData();
      form.set("project", String(projectId));
      form.set("object_id", String(objectId));
      form.set("attached_file", new Blob([new Uint8Array(data)]), basename(filePath));

      const created = await ctx.client.postForm<Record<string, unknown>>(
        ATTACHABLE[resource].path,
        form,
      );
      return ok(slim(created));
    }),
  );

  server.tool(
    "taiga_attachment_download",
    "Download an attachment to a local directory. Get the id from taiga_attachment_list.",
    {
      attachment_id: z.number().describe("Attachment id."),
      resource: common.resource,
      target_dir: z.string().describe("Absolute path to the directory to save into."),
    },
    guard(async (args) => {
      const a = args as { attachment_id: number; resource: Attachable; target_dir: string };
      const row = await ctx.client.get<Record<string, unknown>>(
        `${ATTACHABLE[a.resource].path}/${a.attachment_id}`,
      );
      const { data } = await ctx.client.getBinary(String(row.url));

      await mkdir(a.target_dir, { recursive: true });
      const savedTo = join(a.target_dir, String(row.name));
      await writeFile(savedTo, data);
      return ok({ saved_to: savedTo, size: data.byteLength });
    }),
  );
}
