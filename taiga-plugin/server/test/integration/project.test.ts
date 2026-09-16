import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startClient } from "../helpers/mcp-client.js";
import { TaigaAuth } from "../../src/auth.js";
import { TaigaClient } from "../../src/client.js";
import type { TaigaConfig } from "../../src/config.js";
import { resetAttributeCache } from "../../src/custom-attributes.js";

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

  it("taiga_project_schema reports no custom fields when the project has none", async () => {
    const { json } = await call("taiga_project_schema", { project: "mcp-sandbox" });
    expect(json.customFields).toEqual({ task: [], userstory: [] });
  });
});

function adminClient(): TaigaClient {
  const config: TaigaConfig = { url: STAND, username: "admin", password: "TaigaLocal2026!" };
  return new TaigaClient(config, new TaigaAuth(config));
}

// The sandbox has no custom fields by default — this suite creates one
// through the raw Taiga API (standing in for Admin → Attributes → Custom
// fields) and removes it afterwards, so taiga_project_schema's new
// customFields answer gets exercised against a real field, not a fixture.
describe("taiga_project_schema и кастомные поля", () => {
  let attributeId: number | undefined;

  beforeAll(async () => {
    const client = adminClient();
    const project = await client.get<{ id: number }>("/projects/by_slug", { slug: "mcp-sandbox" });
    const attribute = await client.post<{ id: number }>("/task-custom-attributes", {
      name: "Оценка",
      project: project.id,
      type: "number",
    });
    attributeId = attribute.id;
    // attributeIds()/attributeSummaries() cache definitions for a minute —
    // other suites in this run already primed an empty list for this project.
    resetAttributeCache();
  });

  afterAll(async () => {
    if (attributeId === undefined) return;
    await adminClient().remove("/task-custom-attributes", attributeId).catch(() => {});
    resetAttributeCache();
  });

  it("видит «Оценка» в customFields.task с типом number", async () => {
    const { json } = await call("taiga_project_schema", { project: "mcp-sandbox" });
    expect(json.customFields.task).toContainEqual({ name: "Оценка", type: "number" });
    expect(json.customFields.userstory).toEqual([]);
  });
});
