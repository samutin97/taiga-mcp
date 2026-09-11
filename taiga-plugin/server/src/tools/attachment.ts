import { z } from "zod";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ToolContext, ok, guard, PROJECT_SCHEMA } from "../context.js";
import { TaigaError } from "../errors.js";
import { defineTool } from "../registry.js";

// Taiga's gateway (nginx) caps request bodies at 100M on the local stand;
// refuse early with a clear message instead of buffering a huge file into
// memory only to have the upload rejected anyway.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function checkUploadSize(size: number, filePath: string): void {
  if (size > MAX_UPLOAD_BYTES) {
    throw new TaigaError(
      `"${filePath}" is ${Math.round(size / 1024 / 1024)} MB; the limit is 100 MB.`,
      { hint: "Taiga's gateway rejects larger uploads." },
    );
  }
}

function unreadableFile(filePath: string): TaigaError {
  return new TaigaError(`Cannot read the file "${filePath}".`, {
    hint: "Pass an absolute path to a file that exists.",
  });
}

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
  project: PROJECT_SCHEMA,
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

// `url` is deliberately not projected: it is a self-authorizing, signed link
// to the file (the `?token=` query parameter, not the caller's session, is
// what grants access to it). Echoing it here would leak a no-login-required
// download link into every MCP transcript that captures this result.
// `taiga_attachment_download` fetches the row itself and reads `url` there.
function slim(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    created_date: row.created_date,
  };
}

export function registerAttachmentTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    {
      name: "taiga_attachment_list",
      description: "List the files attached to a user story, task, issue or epic.",
      input: common,
      kind: "read",
    },
    guard(async (args) => {
      const a = args as Record<string, unknown>;
      const resource = a.resource as Attachable;
      const projectId = await ctx.cache.resolveProject(a.project as string | undefined);
      const objectId = await locate(
        ctx, resource, projectId, a.id as number | undefined, a.ref as number | undefined,
      );
      // page_size explicit: Taiga's default page (30) would silently hide
      // attachments past the thirtieth on a busy item.
      const result = await ctx.client.list<Record<string, unknown>>(
        ATTACHABLE[resource].path,
        { project: projectId, object_id: objectId, page_size: 1000 },
      );
      return ok({ total: result.total, items: result.items.map(slim) });
    }),
  );

  defineTool(
    server,
    ctx,
    {
      name: "taiga_attachment_upload",
      description: "Attach a local file to a user story, task, issue or epic.",
      input: { ...common, file_path: z.string().describe("Absolute path to the file to upload.") },
      kind: "create",
      confirm: true,
    },
    guard(async (args) => {
      const a = args as Record<string, unknown>;
      const resource = a.resource as Attachable;
      const filePath = a.file_path as string;

      let size: number;
      try {
        size = (await stat(filePath)).size;
      } catch {
        throw unreadableFile(filePath);
      }
      checkUploadSize(size, filePath);

      let data: Buffer;
      try {
        data = await readFile(filePath);
      } catch {
        throw unreadableFile(filePath);
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

  defineTool(
    server,
    ctx,
    {
      name: "taiga_attachment_download",
      description: "Download an attachment to a local directory. Get the id from taiga_attachment_list.",
      input: {
        attachment_id: z.number().describe("Attachment id."),
        resource: common.resource,
        target_dir: z.string().describe("Absolute path to the directory to save into."),
      },
      kind: "read",
    },
    guard(async (args) => {
      const a = args as { attachment_id: number; resource: Attachable; target_dir: string };
      const row = await ctx.client.get<Record<string, unknown>>(
        `${ATTACHABLE[a.resource].path}/${a.attachment_id}`,
      );
      const { data } = await ctx.client.getBinary(String(row.url));

      await mkdir(a.target_dir, { recursive: true });
      // basename strips any directory components (including `..`) that a
      // hostile or careless attachment name might carry, so the write can
      // never land outside target_dir — except basename("..") returns ".."
      // unchanged, which join() would then resolve to the PARENT of
      // target_dir. Reject that (and the equally degenerate "" and ".")
      // outright so the claim above is actually true.
      const safeName = basename(String(row.name));
      if (safeName === "" || safeName === "." || safeName === "..") {
        throw new TaigaError(
          `Attachment ${a.attachment_id} has an unusable file name.`,
          { hint: "Download it from the Taiga web interface instead." },
        );
      }
      const savedTo = join(a.target_dir, safeName);
      // The name comes from whoever attached the file, so an overwrite here is
      // an overwrite of the caller's own file chosen by someone else: "save the
      // attachments from #12 into my project root" plus an attachment called
      // `.env`. Refuse instead, and let the caller decide.
      try {
        await writeFile(savedTo, data, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new TaigaError(`"${savedTo}" already exists; refusing to overwrite it.`, {
            hint: "Download into an empty directory, or move the existing file away first.",
          });
        }
        throw error;
      }
      return ok({ saved_to: savedTo, size: data.byteLength });
    }),
  );
}
