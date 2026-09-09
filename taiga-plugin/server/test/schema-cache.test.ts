import { describe, it, expect, vi } from "vitest";
import { SchemaCache } from "../src/schema-cache.js";

function fakeClient(routes: Record<string, unknown>) {
  return {
    get: vi.fn(async (path: string, params?: Record<string, unknown>) => {
      const key = params?.project ? `${path}?project=${params.project}` : path;
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

const lookupRoutes = {
  "/userstory-statuses?project=1": [
    { id: 11, name: "New" },
    { id: 12, name: "In progress" },
  ],
  "/task-statuses?project=1": [{ id: 21, name: "New" }],
  "/issue-statuses?project=1": [{ id: 31, name: "New" }],
  "/priorities?project=1": [{ id: 41, name: "High" }],
  "/severities?project=1": [{ id: 51, name: "Normal" }],
  "/issue-types?project=1": [{ id: 61, name: "Bug" }],
  "/points?project=1": [{ id: 71, name: "5" }],
  "/roles?project=1": [{ id: 81, name: "Back" }],
  "/memberships?project=1": [
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
      "/memberships?project=1": [
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
    const client = fakeClient({ ...lookupRoutes, "/projects/by_slug": { id: 1 } });
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
});
