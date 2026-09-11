import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { createContext, readServerOptions } from "../src/context.js";

beforeAll(() => {
  process.env.TAIGA_URL = "http://localhost:9000";
  process.env.TAIGA_USERNAME = "admin";
  process.env.TAIGA_PASSWORD = "TaigaLocal2026!";
  process.env.TAIGA_PROJECT = "mcp-sandbox";
});

async function connect(mode: string) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer(createContext(undefined, readServerOptions({ ...process.env, TAIGA_VOICE_GUARD: mode }))).connect(st);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(ct);
  return client;
}

const createdRefs: number[] = [];
afterEach(async () => {
  const client = await connect("off");
  while (createdRefs.length > 0) {
    const ref = createdRefs.pop()!;
    await client.callTool({ name: "taiga_userstory_delete", arguments: { ref, confirm: true } }).catch(() => {});
  }
});

const texts = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[]).map((c) => c.text);

describe("TAIGA_VOICE_GUARD", () => {
  it("block: refuses before touching Taiga", async () => {
    const client = await connect("block");
    const before = await client.callTool({ name: "taiga_userstory_list", arguments: {} });
    const total = JSON.parse(texts(before)[0]).total;
    const r = await client.callTool({ name: "taiga_userstory_create", arguments: { subject: "Guard test", description: "Контекст: x" } });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/рубрика/);
    const after = await client.callTool({ name: "taiga_userstory_list", arguments: {} });
    expect(JSON.parse(texts(after)[0]).total).toBe(total);
  });

  it("warn: writes and appends the findings", async () => {
    const client = await connect("warn");
    const r = await client.callTool({ name: "taiga_userstory_create", arguments: { subject: "Guard warn test ✅" } });
    expect(r.isError).toBeFalsy();
    const [payload, warning] = texts(r);
    createdRefs.push(JSON.parse(payload).ref);
    expect(warning).toMatch(/^Voice check:/);
    expect(warning).toMatch(/эмодзи/);
  });

  it("off: says nothing", async () => {
    const client = await connect("off");
    const r = await client.callTool({ name: "taiga_userstory_create", arguments: { subject: "Guard off test ✅" } });
    createdRefs.push(JSON.parse(texts(r)[0]).ref);
    expect(texts(r)).toHaveLength(1);
  });

  it("never touches read tools", async () => {
    const client = await connect("block");
    const r = await client.callTool({ name: "taiga_search", arguments: { text: "Контекст: x" } });
    expect(r.isError).toBeFalsy();
  });
});
