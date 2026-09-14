import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startClient } from "../helpers/mcp-client.js";

const upload = join(tmpdir(), "taiga-attachment-test.txt");
const downloadDir = join(tmpdir(), "taiga-download-test");
const payload = "attachment payload from the integration test\n";

beforeAll(() => {
  process.env.TAIGA_URL = "http://localhost:9000";
  process.env.TAIGA_USERNAME = "admin";
  process.env.TAIGA_PASSWORD = "TaigaLocal2026!";
  process.env.TAIGA_PROJECT = "mcp-sandbox";
  writeFileSync(upload, payload);
});

afterAll(() => {
  rmSync(upload, { force: true });
  rmSync(downloadDir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const client = await startClient();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  return {
    raw: text,
    json: result.isError ? undefined : JSON.parse(text),
    isError: result.isError === true,
  };
}

/** Refs created by a test, deleted after it whether it passed or failed. */
const createdRefs: number[] = [];

function track(ref: number): number {
  createdRefs.push(ref);
  return ref;
}

afterEach(async () => {
  while (createdRefs.length > 0) {
    const ref = createdRefs.pop()!;
    try {
      await call("taiga_userstory_delete", { ref, confirm: true });
    } catch {
      // Best effort: a test may already have deleted it deliberately.
    }
  }
});

describe("attachments", () => {
  it("uploads, lists and downloads a file", async () => {
    const story = await call("taiga_userstory_create", { subject: "Attachment test" });
    const ref = track(story.json.ref);

    const uploaded = await call("taiga_attachment_upload", {
      resource: "userstory",
      ref,
      file_path: upload,
    });
    expect(uploaded.isError).toBe(false);
    expect(uploaded.json.name).toBe("taiga-attachment-test.txt");

    const listed = await call("taiga_attachment_list", { resource: "userstory", ref });
    expect(listed.json.items).toHaveLength(1);

    const downloaded = await call("taiga_attachment_download", {
      attachment_id: listed.json.items[0].id,
      resource: "userstory",
      target_dir: downloadDir,
    });
    expect(existsSync(downloaded.json.saved_to)).toBe(true);
    // Verifies the bytes actually crossed the taiga-protected download path
    // intact, not just that some file landed on disk.
    expect(readFileSync(downloaded.json.saved_to, "utf8")).toBe(payload);
  });

  it("says clearly when the file does not exist", async () => {
    const story = await call("taiga_userstory_create", { subject: "Missing file test" });
    const ref = track(story.json.ref);
    const { raw, isError } = await call("taiga_attachment_upload", {
      resource: "userstory",
      ref,
      file_path: join(tmpdir(), "definitely-not-here.txt"),
    });
    expect(isError).toBe(true);
    expect(raw).toMatch(/definitely-not-here\.txt/);
  });
});
