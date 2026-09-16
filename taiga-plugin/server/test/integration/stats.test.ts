import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startClient } from "../helpers/mcp-client.js";
import { TaigaAuth } from "../../src/auth.js";
import { TaigaClient } from "../../src/client.js";
import type { TaigaConfig } from "../../src/config.js";

const STAND = "http://localhost:9000";

beforeAll(() => {
  process.env.TAIGA_URL = STAND;
  process.env.TAIGA_USERNAME = "admin";
  process.env.TAIGA_PASSWORD = "TaigaLocal2026!";
  process.env.TAIGA_PROJECT = "mcp-sandbox";
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const client = await startClient();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  return {
    raw: text,
    json: result.isError ? undefined : JSON.parse(text),
    isError: result.isError === true,
  };
}

function adminClient(): TaigaClient {
  const config: TaigaConfig = { url: STAND, username: "admin", password: "TaigaLocal2026!" };
  return new TaigaClient(config, new TaigaAuth(config));
}

describe("stats", () => {
  it("returns project totals when no sprint is given", async () => {
    const { json } = await call("taiga_stats");
    expect(json.scope).toBe("project");
    expect(json).toHaveProperty("total_points");
    expect(json).toHaveProperty("closed_points");
  });

  it("returns sprint stats with a burndown series", async () => {
    const { json } = await call("taiga_stats", { sprint: "Sprint 1" });
    expect(json.scope).toBe("sprint");
    expect(json.name).toBe("Sprint 1");
    expect(Array.isArray(json.burndown)).toBe(true);
    expect(json.burndown[0]).toHaveProperty("day");
    expect(json.burndown[0]).toHaveProperty("open_points");
  });

  it("names the available sprints when the name is wrong", async () => {
    const { raw, isError } = await call("taiga_stats", { sprint: "Sprint 99" });
    expect(isError).toBe(true);
    expect(raw).toMatch(/Sprint 1/);
  });

  it("reports actual numeric values for sprint totals and completed work", async () => {
    const { json } = await call("taiga_stats", { sprint: "Sprint 1" });
    expect(json.total_points).toBe(19.0);
    expect(json.completed_points).toBe(8.0);
  });

  it("показывает загрузку людей в спринте", async () => {
    const sprints = await call("taiga_sprint_list");
    const stats = await call("taiga_stats", { sprint: sprints.json.items[0].name });
    expect(stats.isError).toBe(false);
    expect(Array.isArray(stats.json.load)).toBe(true);
  });

  // `mcp-sandbox` has no «Оценка» task custom field by default (see
  // resources.test.ts / search-bulk.test.ts for the suites that create and
  // delete it live) — so this needs no setup of its own, and exercises the
  // "field missing" branch exactly as a fresh project would hit it.
  it("без поля «Оценка» возвращает пустую загрузку с пояснением", async () => {
    const { json } = await call("taiga_stats", { sprint: "Sprint 1" });
    expect(json.load).toEqual([]);
    expect(json.load_note).toBe("Оценок задач в проекте нет: заведите поле «Оценка» у задач.");
  });

  it("project-wide stats never carry load", async () => {
    const { json } = await call("taiga_stats");
    expect(json.load).toBeUndefined();
    expect(json.load_note).toBeUndefined();
  });
});

// A real, numeric test of the load composition (task list -> read estimates
// -> group by assignee) needs its own «Оценка» field and its own second
// assignee — neither of which `mcp-sandbox` should be made to carry
// permanently, and creating «Оценка» there would race the identically-named
// field resources.test.ts/search-bulk.test.ts create live on that same
// shared project. So this suite creates a whole throwaway project of its
// own through the raw Taiga API and deletes it in one call in afterAll —
// milestone, story, tasks and the «Оценка» field all go with it, and no
// other suite ever touches this project id.
//
// The second assignee, "Tester Two" (tester2@example.com), is a second real
// login on the local stand itself (the stand only ships with "Local Admin";
// Taiga has no admin API to create a user, and public self-registration is
// disabled here — this account was created once directly via
// `docker compose run --rm taiga-manage shell` against `infra/taiga-docker`,
// the same way `infra/seed_test_data.py` seeds "Local Admin"). It is a
// permanent fixture of this specific local stand, not something this test
// creates or deletes — only the project and its membership are per-run.
describe("taiga_stats: реальные числа на своём временном проекте", () => {
  let projectId: number | undefined;
  const sprintName = `Load test ${Date.now()}`;

  beforeAll(async () => {
    const admin = adminClient();
    const project = await admin.post<{ id: number }>("/projects", {
      name: `taiga_stats load test ${Date.now()}`,
      description: "Temporary project for a taiga_stats load test; deleted in afterAll.",
      is_backlog_activated: true,
    });
    projectId = project.id;

    const roles = await admin.list<{ id: number; name: string }>("/roles", { project: projectId });
    const frontRole = roles.items.find((r) => r.name === "Front");
    if (!frontRole) throw new Error("no Front role on a freshly created project");
    // Adding an existing account by username requires it already be a
    // "contact" (a prior shared project) — passing its email as `username`
    // resolves straight to the existing user instead, no invite needed.
    await admin.post("/memberships", {
      project: projectId,
      role: frontRole.id,
      username: "tester2@example.com",
    });

    await admin.post("/task-custom-attributes", {
      name: "Оценка",
      project: projectId,
      type: "number",
    });

    await call("taiga_sprint_create", {
      project: projectId,
      name: sprintName,
      estimated_start: "2026-11-02",
      estimated_finish: "2026-11-15",
    });
    const story = await call("taiga_userstory_create", {
      project: projectId,
      subject: "Загрузка людей: история спринта",
      sprint: sprintName,
    });
    const storyRef = story.json.ref;

    // Local Admin: tasks in two different roles.
    await call("taiga_task_create", {
      project: projectId, subject: "Админ: фронт", user_story: storyRef,
      assigned_to: "Local Admin", role: "front", estimate: 3,
    });
    await call("taiga_task_create", {
      project: projectId, subject: "Админ: бэк", user_story: storyRef,
      assigned_to: "Local Admin", role: "back", estimate: 4,
    });
    // Tester Two: one task, no estimate.
    await call("taiga_task_create", {
      project: projectId, subject: "Тестер: без оценки", user_story: storyRef,
      assigned_to: "Tester Two", role: "ux",
    });
    // Unassigned task.
    await call("taiga_task_create", {
      project: projectId, subject: "Без исполнителя", user_story: storyRef,
      role: "design", estimate: 6,
    });
  });

  afterAll(async () => {
    if (projectId !== undefined) {
      await adminClient().remove("/projects", projectId).catch(() => {});
    }
  });

  it("считает реальные суммы по людям: две роли у одного, оценка не у всех, задача без исполнителя", async () => {
    const { json, isError } = await call("taiga_stats", { project: projectId, sprint: sprintName });
    expect(isError).toBe(false);
    expect(json.load_note).toBeUndefined();

    const byMember = new Map(
      (json.load as { member: string }[]).map((row) => [row.member, row]),
    );

    expect(byMember.get("Local Admin")).toEqual({
      member: "Local Admin",
      member_id: 5,
      points: 7,
      of_capacity: 0.18,
      unestimated_tasks: 0,
      by_role: { front: 3, back: 4 },
    });
    expect(byMember.get("Tester Two")).toEqual({
      member: "Tester Two",
      member_id: 6,
      points: 0,
      of_capacity: 0,
      unestimated_tasks: 1,
      by_role: {},
    });
    expect(byMember.get("Без исполнителя")).toEqual({
      member: "Без исполнителя",
      member_id: null,
      points: 6,
      of_capacity: 0.15,
      unestimated_tasks: 0,
      by_role: { design: 6 },
    });
    expect(json.load).toHaveLength(3);
  });
});
