import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAttachmentTools,
  checkUploadSize,
  MAX_UPLOAD_BYTES,
} from "../src/tools/attachment.js";
import type { ToolContext } from "../src/context.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

/**
 * Captures the handler `registerAttachmentTools` passes to `server.tool(...)`
 * without needing a real MCP transport or the live Taiga stand — these tests
 * cover behaviour (path safety, URL redaction, size limits) that either
 * cannot be triggered against a real server (Taiga will not store a hostile
 * `..` name) or would be wasteful to exercise live (a 100 MB fixture file).
 */
function captureHandler(): { server: McpServer; handlerFor: (name: string) => ToolHandler } {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  return {
    server: server as unknown as McpServer,
    handlerFor: (name: string) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`tool ${name} was not registered`);
      return handler;
    },
  };
}

async function callHandler(handler: ToolHandler, args: Record<string, unknown>) {
  const result = await handler(args);
  return {
    result,
    json: result.isError ? undefined : JSON.parse(result.content[0].text),
    raw: result.content[0].text,
  };
}

describe("taiga_attachment_download path safety", () => {
  it("keeps the saved file inside target_dir even when the stored name carries `..`", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "taiga-attachment-unit-"));
    try {
      const { server, handlerFor } = captureHandler();
      const ctx = {
        cache: {},
        client: {
          get: vi.fn(async () => ({
            id: 9,
            name: "../../escaped.txt",
            url: "http://example.test/attachments/escaped.txt",
          })),
          getBinary: vi.fn(async () => ({
            data: Buffer.from("payload"),
            contentType: "text/plain",
          })),
        },
      } as unknown as ToolContext;

      registerAttachmentTools(server, ctx);
      const { json } = await callHandler(handlerFor("taiga_attachment_download"), {
        attachment_id: 9,
        resource: "userstory",
        target_dir: targetDir,
      });

      expect(json.saved_to).toBe(join(targetDir, "escaped.txt"));
      expect(existsSync(json.saved_to)).toBe(true);
      // The `..` segments in the stored name must not have escaped target_dir.
      expect(existsSync(join(targetDir, "..", "..", "escaped.txt"))).toBe(false);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

describe("taiga_attachment_download rejects a degenerate `..` file name", () => {
  it("errors with a clear message instead of writing into the parent of target_dir", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "taiga-attachment-unit-"));
    try {
      const { server, handlerFor } = captureHandler();
      const ctx = {
        cache: {},
        client: {
          get: vi.fn(async () => ({
            id: 9,
            // basename("..") returns ".." unchanged (unlike "../../escaped.txt",
            // which basename reduces to "escaped.txt"), so this name needs its
            // own guard rather than relying on basename alone — without it,
            // join(target_dir, "..") resolves to target_dir's PARENT.
            name: "..",
            url: "http://example.test/attachments/dotdot",
          })),
          getBinary: vi.fn(async () => ({
            data: Buffer.from("payload"),
            contentType: "text/plain",
          })),
        },
      } as unknown as ToolContext;

      registerAttachmentTools(server, ctx);
      const { result, json, raw } = await callHandler(
        handlerFor("taiga_attachment_download"),
        { attachment_id: 9, resource: "userstory", target_dir: targetDir },
      );

      expect(result.isError).toBe(true);
      expect(json).toBeUndefined();
      // The specific message proves the dedicated guard fired — not some
      // incidental EISDIR from Node refusing to open an existing directory
      // as a file, which is what would happen if the guard were removed
      // and the write were merely rejected instead of prevented.
      expect(raw).toMatch(/unusable file name/);
      // target_dir itself must stay empty: nothing was written anywhere.
      expect(readdirSync(targetDir)).toEqual([]);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

describe("taiga_attachment_list does not leak the signed download URL", () => {
  it("omits `url` from a listed attachment", async () => {
    const { server, handlerFor } = captureHandler();
    const ctx = {
      cache: { resolveProject: vi.fn(async () => 1) },
      client: {
        list: vi.fn(async () => ({
          items: [
            {
              id: 1,
              name: "a.txt",
              size: 3,
              url: "http://example.test/signed?token=secret",
              created_date: "now",
            },
          ],
          total: 1,
          page: 1,
          hasMore: false,
        })),
      },
    } as unknown as ToolContext;

    registerAttachmentTools(server, ctx);
    const { json } = await callHandler(handlerFor("taiga_attachment_list"), {
      resource: "userstory",
      id: 42,
    });

    expect(json.items[0]).not.toHaveProperty("url");
    expect(json.items[0]).toMatchObject({ id: 1, name: "a.txt", size: 3, created_date: "now" });
  });
});

describe("taiga_attachment_upload size guard", () => {
  it("refuses a file larger than the gateway's upload limit", () => {
    expect(() => checkUploadSize(MAX_UPLOAD_BYTES + 1, "/tmp/huge.bin")).toThrow(/100 MB/);
  });

  it("allows a file at or under the limit", () => {
    expect(() => checkUploadSize(MAX_UPLOAD_BYTES, "/tmp/ok.bin")).not.toThrow();
    expect(() => checkUploadSize(1024, "/tmp/ok.bin")).not.toThrow();
  });
});
