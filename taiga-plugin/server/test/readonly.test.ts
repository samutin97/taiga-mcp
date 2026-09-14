import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { createContext, readServerOptions } from "../src/context.js";
import { ensureStandEnv } from "./helpers/env.js";

const RESOURCES = ["userstory", "task", "issue", "epic", "sprint", "wiki"];
const READ_ONLY_TOOLS = [
  "taiga_whoami",
  "taiga_project_list", "taiga_project_get", "taiga_project_schema",
  ...RESOURCES.map((r) => `taiga_${r}_list`),
  ...RESOURCES.map((r) => `taiga_${r}_get`),
  "taiga_comment_list",
  "taiga_search",
  "taiga_stats",
  "taiga_attachment_list",
  "taiga_attachment_download",
].sort();

async function connect(env: NodeJS.ProcessEnv) {
  ensureStandEnv();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(createContext(undefined, readServerOptions(env)));
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("TAIGA_READ_ONLY=1", () => {
  it("registers exactly the 21 read-only tools", async () => {
    const client = await connect({ ...process.env, TAIGA_READ_ONLY: "1" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(READ_ONLY_TOOLS);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("is off unless the value is exactly \"1\"", () => {
    expect(readServerOptions({ TAIGA_READ_ONLY: "1" }).readOnly).toBe(true);
    expect(readServerOptions({ TAIGA_READ_ONLY: "true" }).readOnly).toBe(false);
    expect(readServerOptions({}).readOnly).toBe(false);
  });

  it("parses TAIGA_VOICE_GUARD and defaults to off", () => {
    expect(readServerOptions({}).voiceGuard).toBe("off");
    expect(readServerOptions({ TAIGA_VOICE_GUARD: "warn" }).voiceGuard).toBe("warn");
    expect(readServerOptions({ TAIGA_VOICE_GUARD: "block" }).voiceGuard).toBe("block");
    expect(readServerOptions({ TAIGA_VOICE_GUARD: "loud" }).voiceGuard).toBe("off");
  });
});
