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

  it("post() sends JSON and bearer token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(json({ id: 10, subject: "New" }));
    const { client } = makeClient(fetchImpl);

    await client.post("/userstories", { subject: "New" });

    const [, init] = fetchImpl.mock.calls[1];
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ subject: "New" });
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("remove() sends DELETE and handles 204", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(
        new Response(null, { status: 204, statusText: "No Content" }),
      );
    const { client } = makeClient(fetchImpl);

    await expect(client.remove("/userstories", 7)).resolves.toBeUndefined();

    const [, init] = fetchImpl.mock.calls[1];
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("postForm() sends FormData without content-type header", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(json({ id: 15 }));
    const { client } = makeClient(fetchImpl);

    const form = new FormData();
    form.append("file", new Blob(["test"]), "test.txt");
    await client.postForm("/attachments", form);

    const [, init] = fetchImpl.mock.calls[1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(form);
    expect(init.headers["content-type"]).toBeUndefined();
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("getBinary() retries on 401 with new token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "old", id: 1 }))
      .mockResolvedValueOnce(json({ detail: "expired" }, 401))
      .mockResolvedValueOnce(json({ auth_token: "new", id: 1 }))
      .mockResolvedValueOnce(
        new Response(Buffer.from("binary"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      );
    const { client } = makeClient(fetchImpl);

    const result = await client.getBinary("http://taiga.test/attachments/file.pdf");
    expect(result.data).toEqual(Buffer.from("binary"));
    expect(result.contentType).toBe("application/pdf");
    expect(fetchImpl.mock.calls[3][1].headers.Authorization).toBe("Bearer new");
  });

  it("getBinary() on network error names TAIGA_URL without echoing the signed URL", async () => {
    // The attachment URL carries a `?token=` that authorises the download with
    // no login at all. Interpolating it into the error put that token into
    // every transcript that captured the tool result — exactly what
    // attachment.ts refuses to do when listing attachments.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockRejectedValueOnce(new Error("Network unreachable"));
    const { client } = makeClient(fetchImpl);

    const signed = "http://taiga.test/media/attachments/secret.pdf?token=SUPERSECRET";
    const error = (await client.getBinary(signed).catch((e) => e)) as Error;

    expect(error.message).toMatch(/Cannot reach the Taiga file service/);
    expect(error.message).toContain("TAIGA_URL");
    expect(error.message).not.toContain("SUPERSECRET");
    expect(error.message).not.toContain(signed);
  });

  it("getBinary() does not send the session token to a different media host", async () => {
    // Taiga can be configured with an S3-style media backend, which would put
    // the user's Taiga session token in a request to a third-party host. The
    // signed URL authorises itself and does not need the header at all.
    const fetchImpl = vi.fn(async () =>
      new Response(Buffer.from("binary"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    const { client } = makeClient(fetchImpl);

    await client.getBinary("https://media.cdn.example/taiga/file.pdf?token=signed");

    // One call only: no login happened either, because no token was needed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://media.cdn.example/taiga/file.pdf?token=signed");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("still sends the bearer token for a same-origin media URL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(
        new Response(Buffer.from("binary"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      );
    const { client } = makeClient(fetchImpl);

    await client.getBinary("http://taiga.test/media/attachments/file.pdf?token=signed");
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer tok");
  });

  it("list() derives hasMore from x-pagination-next when no page_size was sent", async () => {
    // Without an explicit page_size the arithmetic had no page size to work
    // with and concluded "no more pages" every time, even on a 30-item first
    // page of a 100-member project.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(
        json(
          Array.from({ length: 30 }, (_, i) => ({ id: i })),
          200,
          {
            "x-pagination-count": "100",
            "x-pagination-current": "1",
            "x-paginated": "true",
            "x-paginated-by": "30",
            "x-pagination-next": "http://taiga.test/api/v1/memberships?page=2",
          },
        ),
      );
    const { client } = makeClient(fetchImpl);

    const result = await client.list("/memberships", { project: 1 });
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(100);
  });

  it("list() on a paginated last page with no x-pagination-next → hasMore=false", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(
        json([{ id: 1 }, { id: 2 }, { id: 3 }], 200, {
          "x-pagination-count": "33",
          "x-pagination-current": "2",
          "x-paginated": "true",
          "x-paginated-by": "30",
          "x-pagination-prev": "http://taiga.test/api/v1/memberships?page=1",
        }),
      );
    const { client } = makeClient(fetchImpl);

    const result = await client.list("/memberships", { project: 1 });
    expect(result.hasMore).toBe(false);
  });

  it("list() on short final page: total=5, page_size=3, page 2 with 2 items → hasMore=false", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(
        json([{ id: 4 }, { id: 5 }], 200, {
          "x-pagination-count": "5",
          "x-pagination-current": "2",
        }),
      );
    const { client } = makeClient(fetchImpl);

    const result = await client.list("/userstories", { page: 2, page_size: 3 });
    expect(result.hasMore).toBe(false);
  });

  it("list() on empty page past the end → hasMore=false", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(
        json([], 200, {
          "x-pagination-count": "5",
          "x-pagination-current": "3",
        }),
      );
    const { client } = makeClient(fetchImpl);

    const result = await client.list("/userstories", { page: 3, page_size: 3 });
    expect(result.hasMore).toBe(false);
  });

  it("patch() with validation error containing 'version' field → shows actual error, not conflict", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ auth_token: "tok", id: 1 }))
      .mockResolvedValueOnce(json({ id: 7, version: 3 }))
      .mockResolvedValueOnce(
        json({ app_version: ["This field is required."] }, 400),
      );
    const { client } = makeClient(fetchImpl);

    await expect(client.patch("/userstories", 7, { subject: "x" })).rejects.toThrow(
      /app_version/,
    );
  });
});
