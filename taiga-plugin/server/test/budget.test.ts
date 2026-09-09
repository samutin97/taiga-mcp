import { describe, it, expect } from "vitest";
import { startClient } from "./helpers/mcp-client.js";

const CHAR_BUDGET = 32_000; // ~8000 токенов

describe("tool schema budget", () => {
  it("stays within the context budget", async () => {
    const client = await startClient();
    const { tools } = await client.listTools();
    const size = JSON.stringify(tools).length;

    console.log(
      `${tools.length} tools, ${size} chars (~${Math.round(size / 4)} tokens)`,
    );
    expect(size).toBeLessThanOrEqual(CHAR_BUDGET);
  });

  it("names every tool taiga_<resource>_<action>", async () => {
    const client = await startClient();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^taiga_[a-z_]+$/);
      expect(tool.description ?? "").not.toEqual("");
    }
  });
});
