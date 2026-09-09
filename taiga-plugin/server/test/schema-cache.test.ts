import { describe, it, expect, vi } from "vitest";
import { SchemaCache } from "../src/schema-cache.js";
import { TaigaError } from "../src/errors.js";

function fakeClient(routes: Record<string, unknown>) {
  return {
    get: vi.fn(async (path: string, params?: Record<string, unknown>) => {
      let key = path;
      if (params) {
        const query = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined) query.set(k, String(v));
        }
        const qs = query.toString();
        if (qs) key = `${path}?${qs}`;
      }
      if (!(key in routes)) throw new Error(`unexpected GET ${key}`);
      return routes[key];
    }),
    list: vi.fn(async (path: string) => ({
      items: (routes[path] as unknown[]) ?? [],
      total: 0,
      page: 1,
      hasMore: false,
    })),
  };
}

// The keys carry `page_size=1000` deliberately: every lookup fetch must ask
// for a page big enough to hold a real project's tables, because Taiga
// paginates these endpoints at 30 by default. A request without it does not
// match any route here and fails as an unexpected GET.
const lookupRoutes = {
  "/userstory-statuses?project=1&page_size=1000": [
    { id: 11, name: "New" },
    { id: 12, name: "In progress" },
  ],
  "/task-statuses?project=1&page_size=1000": [{ id: 21, name: "New" }],
  "/issue-statuses?project=1&page_size=1000": [{ id: 31, name: "New" }],
  "/epic-statuses?project=1&page_size=1000": [{ id: 36, name: "New" }],
  "/priorities?project=1&page_size=1000": [{ id: 41, name: "High" }],
  "/severities?project=1&page_size=1000": [{ id: 51, name: "Normal" }],
  "/issue-types?project=1&page_size=1000": [{ id: 61, name: "Bug" }],
  "/points?project=1&page_size=1000": [{ id: 71, name: "5" }],
  "/roles?project=1&page_size=1000": [{ id: 81, name: "Back" }],
  "/memberships?project=1&page_size=1000": [
    { user: 91, full_name: "Ivan Petrov", email: "ivan@example.com" },
    { user: 92, full_name: "Anna Ivanova", email: "anna@example.com" },
  ],
  "/projects/1": { id: 1, slug: "sandbox", name: "Sandbox" },
};

describe("SchemaCache", () => {
  it("resolves a status name to its numeric id", async () => {
    const client = fakeClient(lookupRoutes);
    const cache = new SchemaCache(client as never, {});
    await expect(
      cache.resolveLookup(1, "userstory-status", "In progress"),
    ).resolves.toBe(12);
  });

  it("matches status names case-insensitively", async () => {
    const client = fakeClient(lookupRoutes);
    const cache = new SchemaCache(client as never, {});
    await expect(
      cache.resolveLookup(1, "userstory-status", "in PROGRESS"),
    ).resolves.toBe(12);
  });

  it("passes numeric ids through untouched", async () => {
    const client = fakeClient(lookupRoutes);
    const cache = new SchemaCache(client as never, {});
    await expect(cache.resolveLookup(1, "userstory-status", 12)).resolves.toBe(12);
  });

  it("lists the valid values when a name does not match", async () => {
    const client = fakeClient(lookupRoutes);
    const cache = new SchemaCache(client as never, {});
    await expect(
      cache.resolveLookup(1, "userstory-status", "Ready"),
    ).rejects.toThrow(/New, In progress/);
  });

  it("resolves a member by full name", async () => {
    const client = fakeClient(lookupRoutes);
    const cache = new SchemaCache(client as never, {});
    await expect(cache.resolveLookup(1, "member", "Ivan Petrov")).resolves.toBe(91);
  });

  it("asks the user to disambiguate an ambiguous member name", async () => {
    const client = fakeClient({
      ...lookupRoutes,
      "/memberships?project=1&page_size=1000": [
        { user: 91, full_name: "Ivan Petrov", email: "ivan@a.com" },
        { user: 93, full_name: "Ivan Petrov", email: "ivan@b.com" },
      ],
    });
    const cache = new SchemaCache(client as never, {});
    await expect(cache.resolveLookup(1, "member", "Ivan Petrov")).rejects.toThrow(
      /ivan@a\.com/,
    );
  });

  it("fetches each lookup only once", async () => {
    const client = fakeClient(lookupRoutes);
    const cache = new SchemaCache(client as never, {});
    await cache.resolveLookup(1, "userstory-status", "New");
    await cache.resolveLookup(1, "userstory-status", "In progress");
    const statusCalls = client.get.mock.calls.filter(
      ([path]) => path === "/userstory-statuses",
    );
    expect(statusCalls).toHaveLength(1);
  });

  it("falls back to the configured default project", async () => {
    const client = fakeClient({ ...lookupRoutes, "/projects/by_slug?slug=sandbox": { id: 1 } });
    const cache = new SchemaCache(client as never, { defaultProject: "sandbox" });
    await expect(cache.resolveProject()).resolves.toBe(1);
  });

  it("explains what to do when no project is given at all", async () => {
    const client = fakeClient(lookupRoutes);
    const cache = new SchemaCache(client as never, {});
    await expect(cache.resolveProject()).rejects.toThrow(/TAIGA_PROJECT/);
  });

  it("labelMap returns a Map where .get(id) returns the display name", async () => {
    const client = fakeClient(lookupRoutes);
    const cache = new SchemaCache(client as never, {});
    const map = await cache.labelMap(1, "priority");
    expect(map.get(41)).toBe("High");
  });

  it("labelMap reuses the cache from resolveLookup", async () => {
    const client = fakeClient(lookupRoutes);
    const cache = new SchemaCache(client as never, {});
    await cache.resolveLookup(1, "priority", "High");
    await cache.labelMap(1, "priority");
    const priorityCalls = client.get.mock.calls.filter(
      ([path]) => path === "/priorities",
    );
    expect(priorityCalls).toHaveLength(1);
  });

  it("rejects a pending invitee who has no user id yet", async () => {
    const client = fakeClient({
      ...lookupRoutes,
      "/memberships?project=1&page_size=1000": [
        { user: 91, full_name: "Ivan Petrov", email: "ivan@example.com" },
        { user: null, full_name: "Pending Person", email: "pending@example.com" },
      ],
    });
    const cache = new SchemaCache(client as never, {});
    // Pending invitee cannot be resolved
    await expect(cache.resolveLookup(1, "member", "Pending Person")).rejects.toThrow(
      /Pending Person/,
    );
    // But normal members still resolve
    await expect(cache.resolveLookup(1, "member", "Ivan Petrov")).resolves.toBe(91);
  });

  it("asks for a lookup page big enough for a real team, not Taiga's default 30", async () => {
    // Taiga paginates /memberships at 30 (x-paginated-by: 30, verified live).
    // Without an explicit page_size, everyone past the first page vanishes:
    // `assigned_to: "<their name>"` would be rejected as not a valid member
    // and taiga_project_schema would show a truncated roster. The sandbox has
    // exactly one member, so only a mocked page this size can catch it.
    const roster = Array.from({ length: 31 }, (_, index) => ({
      user: 100 + index,
      full_name: `Member ${index + 1}`,
      email: `member${index + 1}@example.com`,
    }));
    const client = fakeClient({
      ...lookupRoutes,
      "/memberships?project=1&page_size=1000": roster,
    });
    const cache = new SchemaCache(client as never, {});
    await expect(cache.resolveLookup(1, "member", "Member 31")).resolves.toBe(130);
  });

  it("names the ref and the project when /resolver 404s on a missing #ref", async () => {
    // Taiga answers a resolver miss with HTTP 404 and an EMPTY
    // `_error_message`, so the generic HTTP error carries no text at all.
    const client = fakeClient(lookupRoutes);
    client.get = vi.fn(async (path: string) => {
      if (path === "/projects/1") return { id: 1, slug: "sandbox", name: "Sandbox" };
      if (path === "/resolver") throw new TaigaError("Not found in Taiga.", { status: 404 });
      throw new Error(`unexpected GET ${path}`);
    }) as never;
    const cache = new SchemaCache(client as never, {});
    await expect(cache.resolveRef(1, "us", 99999)).rejects.toThrow(
      /No item #99999 in project sandbox\./,
    );
  });

  it("resolveRef reuses project slug from cache", async () => {
    const client = fakeClient({
      ...lookupRoutes,
      "/projects/1": { id: 1, slug: "sandbox", name: "Sandbox" },
      "/resolver?project=sandbox&us=42": { us: 7 },
      "/resolver?project=sandbox&us=43": { us: 8 },
    });
    const cache = new SchemaCache(client as never, {});
    await cache.resolveRef(1, "us", 42);
    await cache.resolveRef(1, "us", 43);
    const projectCalls = client.get.mock.calls.filter(
      ([path]) => path === "/projects/1",
    );
    expect(projectCalls).toHaveLength(1);
  });
});
