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
  const reachable = await fetch(`${STAND}/api/v1/`).then((r) => r.ok).catch(() => false);
  if (!reachable) throw new Error("Local Taiga stand is not running — see infra/README.md");
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

// Acceptance defect (scenarios 6 and 9): against a real Taiga, removing the
// LAST #ref from a link custom attribute («Блокируется»/«Блокирует») sent
// `attributes_values: {}`, which the server rejects with "This field cannot
// be blank." `mcp-sandbox` has neither field by default, so this suite
// creates its own throwaway project carrying both, links two stories with
// taiga_link, removes the link, and deletes the project in afterAll.
describe("taiga_link: снятие последней блокирующей ссылки на реальном стенде", () => {
  let projectId: number | undefined;

  beforeAll(async () => {
    const admin = adminClient();
    const project = await admin.post<{ id: number }>("/projects", {
      name: `taiga_link last-ref test ${Date.now()}`,
      description: "Temporary project for a taiga_link removal test; deleted in afterAll.",
      is_backlog_activated: true,
    });
    projectId = project.id;

    await admin.post("/userstory-custom-attributes", {
      name: "Блокируется",
      project: projectId,
      type: "text",
    });
    await admin.post("/userstory-custom-attributes", {
      name: "Блокирует",
      project: projectId,
      type: "text",
    });
    // attributeIds()/attributeSummaries() cache definitions for a minute —
    // this is a brand-new project id, but reset defensively like the other
    // suites that create fields live.
    resetAttributeCache();
  });

  afterAll(async () => {
    if (projectId !== undefined) {
      await adminClient().remove("/projects", projectId).catch(() => {});
    }
    resetAttributeCache();
  });

  it("remove снимает последнюю блокировку без ошибки, флаг гаснет, и остаётся запись о разблокировке", async () => {
    const blocker = await call("taiga_userstory_create", {
      project: projectId,
      subject: "Блокирующая история",
    });
    expect(blocker.isError, blocker.raw).toBe(false);
    const blockerRef = blocker.json.ref;

    const blocked = await call("taiga_userstory_create", {
      project: projectId,
      subject: "Заблокированная история",
    });
    expect(blocked.isError, blocked.raw).toBe(false);
    const blockedRef = blocked.json.ref;

    const linked = await call("taiga_link", {
      project: projectId,
      from: blockerRef,
      to: blockedRef,
      type: "blocks",
    });
    expect(linked.isError, linked.raw).toBe(false);

    const blockedWhileLinked = await call("taiga_userstory_get", {
      project: projectId,
      ref: blockedRef,
      fields: "full",
    });
    expect(blockedWhileLinked.json.is_blocked).toBe(true);
    expect(blockedWhileLinked.json.blocked_note).toContain(`#${blockerRef}`);

    // The defect: this call used to fail against the live stand with
    // "attributes_values: This field cannot be blank." because it was the
    // last #ref in both «Блокируется» and «Блокирует».
    const removed = await call("taiga_link", {
      project: projectId,
      from: blockerRef,
      to: blockedRef,
      type: "blocks",
      remove: true,
    });
    expect(removed.isError, removed.raw).toBe(false);
    expect(removed.json.changed.sort()).toEqual(
      ["from:comment", "from:Блокирует", "to:Блокируется", "to:blocked_note", "to:is_blocked"].sort(),
    );

    const after = await call("taiga_userstory_get", {
      project: projectId,
      ref: blockedRef,
      fields: "full",
    });
    expect(after.json.is_blocked).toBe(false);
    expect(after.json.blocked_note ?? "").not.toContain(`#${blockerRef}`);

    const comments = await call("taiga_comment_list", {
      project: projectId,
      resource: "userstory",
      ref: blockerRef,
    });
    const texts = comments.json.items.map((c: { comment: string }) => c.comment);
    expect(texts).toContain(`Разблокировал #${blockedRef}`);
  });
});
