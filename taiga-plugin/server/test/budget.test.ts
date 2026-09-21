import { describe, it, expect } from "vitest";
import { startClient } from "./helpers/mcp-client.js";

const CHAR_BUDGET = 32_000; // ~8000 tokens of what the model actually reads

/** Only the parts of tools/list that reach the model's prompt. */
function promptFacing(tools: { name: string; description?: string; inputSchema: unknown }[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

describe("tool schema budget", () => {
  it("stays within the context budget", async () => {
    const client = await startClient();
    const { tools } = await client.listTools();
    const promptSize = JSON.stringify(promptFacing(tools)).length;
    const wireSize = JSON.stringify(tools).length;
    console.log(
      `${tools.length} tools; prompt-facing ${promptSize} chars (~${Math.round(promptSize / 4)} tokens); on the wire ${wireSize} chars`,
    );
    expect(promptSize).toBeLessThanOrEqual(CHAR_BUDGET);
  });

  it("names every tool taiga_<resource>_<action>", async () => {
    const client = await startClient();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(43);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^taiga_[a-z_]+$/);
      expect(tool.description ?? "").not.toEqual("");
    }
  });

  it("says the project default once, in taiga_project_list, not on every tool", async () => {
    const client = await startClient();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("taiga_project_list")!.description).toMatch(/TAIGA_PROJECT/);
    for (const tool of tools) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, `${tool.name} repeats the TAIGA_PROJECT default`).not.toMatch(/TAIGA_PROJECT/);
    }
  });

  it("cross-references list and search so the model picks the right one", async () => {
    const client = await startClient();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const res of ["userstory", "task", "issue", "epic", "sprint", "wiki"]) {
      expect(byName.get(`taiga_${res}_list`)!.description).toMatch(/taiga_search/);
    }
    expect(byName.get("taiga_search")!.description).toMatch(/_list/);
  });
});
