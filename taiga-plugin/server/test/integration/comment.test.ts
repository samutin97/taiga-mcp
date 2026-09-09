import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { startClient } from "../helpers/mcp-client.js";

beforeAll(() => {
  process.env.TAIGA_URL = "http://localhost:9000";
  process.env.TAIGA_USERNAME = "admin";
  process.env.TAIGA_PASSWORD = "TaigaLocal2026!";
  process.env.TAIGA_PROJECT = "mcp-sandbox";
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

describe("comments", () => {
  it("adds a comment and reads it back", async () => {
    const created = await call("taiga_userstory_create", {
      subject: "Comment test story",
    });
    const ref = track(created.json.ref);

    const added = await call("taiga_comment_add", {
      resource: "userstory",
      ref,
      comment: "Checked against the local stand.",
    });
    expect(added.isError).toBe(false);

    const listed = await call("taiga_comment_list", { resource: "userstory", ref });
    const texts = listed.json.items.map((c: { comment: string }) => c.comment);
    expect(texts).toContain("Checked against the local stand.");
    expect(listed.json.items[0]).toHaveProperty("author");
    expect(listed.json.items[0]).toHaveProperty("created_at");
  });

  it("skips history entries that carry no comment", async () => {
    const created = await call("taiga_userstory_create", { subject: "Quiet story" });
    const ref = track(created.json.ref);
    await call("taiga_userstory_update", { ref, subject: "Quiet story renamed" });

    const listed = await call("taiga_comment_list", { resource: "userstory", ref });
    expect(listed.json.items).toHaveLength(0);
  });

  it("returns comments oldest first", async () => {
    const created = await call("taiga_userstory_create", {
      subject: "Comment order test",
    });
    const ref = track(created.json.ref);

    await call("taiga_comment_add", {
      resource: "userstory",
      ref,
      comment: "First comment",
    });
    await call("taiga_comment_add", {
      resource: "userstory",
      ref,
      comment: "Second comment",
    });

    const listed = await call("taiga_comment_list", { resource: "userstory", ref });
    expect(listed.json.items.length).toBeGreaterThanOrEqual(2);
    expect(listed.json.items[0].comment).toBe("First comment");
    expect(listed.json.items[1].comment).toBe("Second comment");
  });
});
