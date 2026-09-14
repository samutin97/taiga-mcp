import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";

const VARS = ["TAIGA_URL", "TAIGA_USERNAME", "TAIGA_PASSWORD", "TAIGA_PROJECT"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function connectUnconfigured() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("an unconfigured plugin", () => {
  it("still starts and lists its tools", async () => {
    const client = await connectUnconfigured();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("explains which variables are missing when a tool is called", async () => {
    const client = await connectUnconfigured();
    const result = await client.callTool({ name: "taiga_whoami", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("TAIGA_URL");
    expect(text).toContain("TAIGA_USERNAME");
    expect(text).toContain("TAIGA_PASSWORD");
  });
});
