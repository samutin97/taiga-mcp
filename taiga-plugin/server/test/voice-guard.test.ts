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
    const subject = "Guard block test 7d3f";
    const r = await client.callTool({ name: "taiga_userstory_create", arguments: { subject, description: "Контекст: x" } });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/рубрика/);

    // Parallel integration files write to the same shared stand, so an
    // exact total-count comparison is not safe here. Instead: page through
    // every story and confirm none carries this test's unique subject —
    // that proves the refused create never reached Taiga, without
    // depending on the story count staying quiet.
    let page = 1;
    let found = false;
    for (;;) {
      const listed = await client.callTool({ name: "taiga_userstory_list", arguments: { limit: 200, page } });
      const body = JSON.parse(texts(listed)[0]) as { items: { subject: string }[]; has_more: boolean };
      if (body.items.some((item) => item.subject === subject)) found = true;
      if (!body.has_more) break;
      page += 1;
    }
    expect(found).toBe(false);
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
