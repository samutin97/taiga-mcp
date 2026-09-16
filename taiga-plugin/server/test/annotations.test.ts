import { describe, it, expect } from "vitest";
import { startClient } from "./helpers/mcp-client.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const RESOURCES = ["userstory", "task", "issue", "epic", "sprint", "wiki"];

export const CONFIRMED = [...RESOURCES.map((r) => `taiga_${r}_delete`)];

function expectedFor(name: string) {
  if (name.endsWith("_delete")) return DESTRUCTIVE;
  if (name.endsWith("_update") || name === "taiga_link") return UPDATE;
  if (
    name.endsWith("_create") ||
    name === "taiga_comment_add" ||
    name === "taiga_attachment_upload"
  ) return CREATE;
  return READ;
}

describe("tool annotations", () => {
  it("annotates all 43 tools by kind", async () => {
    const client = await startClient();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(43);
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} has no annotations`).toEqual(expectedFor(tool.name));
      expect(tool.annotations, `${tool.name} carries a title`).not.toHaveProperty("title");
    }
  });

  it("hard-gates exactly the six delete tools", async () => {
    const client = await startClient();
    const { tools } = await client.listTools();
    const gated = tools
      .filter((t) => (t._meta as Record<string, unknown> | undefined)?.["anthropic/requiresUserInteraction"] === true)
      .map((t) => t.name)
      .sort();
    expect(gated).toEqual([...CONFIRMED].sort());
  });
});
