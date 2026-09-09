import { describe, it, expect, vi } from "vitest";
import { TaigaClient } from "../src/client.js";
import { TaigaAuth } from "../src/auth.js";

const config = { url: "http://taiga.test", username: "admin", password: "pw" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(fetchImpl: unknown) {
  const auth = new TaigaAuth(config, fetchImpl as typeof fetch);
  return { client: new TaigaClient(config, auth, fetchImpl as typeof fetch), auth };
}

describe("TaigaClient", () => {
  it("sends the bearer token and query params", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(json({ id: 7 }));
    const { client } = makeClient(fetchImpl);

    await client.get("/userstories/7", { project: 1, skip: undefined });

    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe("http://taiga.test/api/v1/userstories/7?project=1");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("reads pagination headers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(
        json([{ id: 1 }, { id: 2 }], 200, {
          "x-pagination-count": "42",
          "x-pagination-current": "1",
        }),
      );
    const { client } = makeClient(fetchImpl);

    const result = await client.list("/userstories", { project: 1 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(42);
    expect(result.page).toBe(1);
    expect(result.hasMore).toBe(true);
  });

  it("re-logs in once on 401 and retries the request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "old", id: 1 }))
      .mockResolvedValueOnce(json({ detail: "expired" }, 401))
      .mockResolvedValueOnce(json({ auth_token: "new", id: 1 }))
      .mockResolvedValueOnce(json({ id: 7 }));
    const { client } = makeClient(fetchImpl);

    await expect(client.get("/userstories/7")).resolves.toEqual({ id: 7 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[3][1].headers.Authorization).toBe("Bearer new");
  });

  it("gives up after a second 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "old", id: 1 }))
      .mockResolvedValueOnce(json({ detail: "nope" }, 401))
      .mockResolvedValueOnce(json({ auth_token: "new", id: 1 }))
      .mockResolvedValueOnce(json({ detail: "nope" }, 401));
    const { client } = makeClient(fetchImpl);

    await expect(client.get("/userstories/7")).rejects.toThrow(/TAIGA_USERNAME/);
  });

  it("reads the current version before patching", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(json({ id: 7, version: 3 }))
      .mockResolvedValueOnce(json({ id: 7, version: 4, subject: "New" }));
    const { client } = makeClient(fetchImpl);

    await client.patch("/userstories", 7, { subject: "New" });

    const [, init] = fetchImpl.mock.calls[2];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ subject: "New", version: 3 });
  });

  it("explains a version conflict instead of overwriting", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(json({ id: 7, version: 3 }))
      .mockResolvedValueOnce(
        json({ version: ["The object has changed"] }, 400),
      );
    const { client } = makeClient(fetchImpl);

    await expect(client.patch("/userstories", 7, { subject: "x" })).rejects.toThrow(
      /changed in Taiga/i,
    );
  });
});
