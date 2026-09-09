import { describe, it, expect, beforeAll } from "vitest";
import { startClient } from "../helpers/mcp-client.js";

const STAND = "http://localhost:9000";

beforeAll(async () => {
  process.env.TAIGA_URL = STAND;
  process.env.TAIGA_USERNAME = "admin";
  process.env.TAIGA_PASSWORD = "TaigaLocal2026!";
  process.env.TAIGA_PROJECT = "mcp-sandbox";

  const reachable = await fetch(`${STAND}/api/v1/`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    throw new Error(
      `Local Taiga stand is not reachable at ${STAND}. ` +
        `Start it: cd infra/taiga-docker && docker compose up -d (see infra/README.md)`,
    );
  }
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const client = await startClient();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  return { raw: text, json: JSON.parse(text), isError: result.isError === true };
}

describe("project tools against the local stand", () => {
  it("taiga_whoami reports the authenticated user", async () => {
    const { json } = await call("taiga_whoami");
    expect(json.username).toBe("admin");
    expect(Array.isArray(json.projects)).toBe(true);
  });

  it("taiga_project_list finds the sandbox project", async () => {
    const { json } = await call("taiga_project_list");
    const slugs = json.items.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain("mcp-sandbox");
  });

  it("taiga_project_get accepts a slug", async () => {
    const { json } = await call("taiga_project_get", { project: "mcp-sandbox" });
    expect(json.name).toBe("MCP Sandbox");
  });

  it("taiga_project_schema lists the user story statuses", async () => {
    const { json } = await call("taiga_project_schema", { project: "mcp-sandbox" });
    const names = json.lookups["userstory-status"].map(
      (entry: { name: string }) => entry.name,
    );
    expect(names).toContain("In progress");
  });

  it("never leaks the password", async () => {
    const { raw } = await call("taiga_whoami");
    expect(raw).not.toContain("TaigaLocal2026!");
  });
});
