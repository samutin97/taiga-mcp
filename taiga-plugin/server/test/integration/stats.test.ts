import { describe, it, expect, beforeAll } from "vitest";
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

describe("stats", () => {
  it("returns project totals when no sprint is given", async () => {
    const { json } = await call("taiga_stats");
    expect(json.scope).toBe("project");
    expect(json).toHaveProperty("total_points");
    expect(json).toHaveProperty("closed_points");
  });

  it("returns sprint stats with a burndown series", async () => {
    const { json } = await call("taiga_stats", { sprint: "Sprint 1" });
    expect(json.scope).toBe("sprint");
    expect(json.name).toBe("Sprint 1");
    expect(Array.isArray(json.burndown)).toBe(true);
    expect(json.burndown[0]).toHaveProperty("day");
    expect(json.burndown[0]).toHaveProperty("open_points");
  });

  it("names the available sprints when the name is wrong", async () => {
    const { raw, isError } = await call("taiga_stats", { sprint: "Sprint 99" });
    expect(isError).toBe(true);
    expect(raw).toMatch(/Sprint 1/);
  });
});
