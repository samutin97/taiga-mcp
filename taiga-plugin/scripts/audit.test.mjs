import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { audit } from "./audit.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const base = { now: "2026-09-11", stats: { speed: 20 }, sprints: [], tasks: [], stories: [] };
// created_date outside the 30-day window on purpose: otherwise every single
// open story would trip backlog-bankruptcy (1 created, 0 closed) in every test.
const story = (o) => ({ ref: 1, subject: "Логин работает", status: "In progress", is_closed: false, is_blocked: false, blocked_note: "", points: 3, tags: [], created_date: "2026-07-01", modified_date: "2026-09-10", finish_date: null, total_comments: 1, ...o });
const rules = (input) => audit(input).map((f) => f.rule);

test("action-title", () => {
  assert.deepEqual(rules({ ...base, stories: [story({ subject: "Реализовать логин" })] }), ["action-title"]);
  assert.deepEqual(rules({ ...base, stories: [story({ subject: "Логин работает без поддержки" })] }), []);
});
test("blocked-no-note", () => {
  assert.deepEqual(rules({ ...base, stories: [story({ is_blocked: true })] }), ["blocked-no-note"]);
  assert.deepEqual(rules({ ...base, stories: [story({ is_blocked: true, blocked_note: "ждём доступ" })] }), []);
});
test("stale", () => {
  assert.deepEqual(rules({ ...base, stories: [story({ modified_date: "2026-08-20", total_comments: 0 })] }), ["stale"]);
  assert.deepEqual(rules({ ...base, stories: [story({ modified_date: "2026-08-20", total_comments: 2 })] }), []);
  assert.deepEqual(rules({ ...base, stories: [story({ status: "New", modified_date: "2026-08-20", total_comments: 0 })] }), []);
});
test("oversized weighs each role on its own, never their sum", () => {
  assert.deepEqual(rules({ ...base, stories: [story({ points_by_role: { Front: 40 } })] }), ["oversized"]);
  assert.deepEqual(rules({ ...base, stories: [story({ points_by_role: { Front: 8, Back: "21" } })] }), ["oversized"]);
  // Two comfortable halves worked in parallel — 16 in total, nothing to cut.
  assert.deepEqual(rules({ ...base, stories: [story({ points_by_role: { Front: 8, Back: 8 } })] }), []);
  assert.deepEqual(rules({ ...base, stories: [story({ points_by_role: { Front: 20 } })] }), []);
  // No breakdown, or nothing numeric in it: the rule stays silent rather than
  // guessing from the total, which sums roles that never compete for one person.
  assert.deepEqual(rules({ ...base, stories: [story({ points: 99 })] }), []);
  assert.deepEqual(rules({ ...base, stories: [story({ points_by_role: {} })] }), []);
});
test("sprint-overloaded", () => {
  assert.deepEqual(rules({ ...base, sprints: [{ name: "S1", closed: false, total_points: 30 }] }), ["sprint-overloaded"]);
  assert.deepEqual(rules({ ...base, sprints: [{ name: "S1", closed: false, total_points: 22 }] }), []);
  assert.deepEqual(rules({ ...base, stats: {}, sprints: [{ name: "S1", closed: false, total_points: 99 }] }), [], "no speed, no verdict");
});
test("backlog-bankruptcy", () => {
  const fresh = (ref) => story({ ref, created_date: "2026-09-01" });
  assert.deepEqual(rules({ ...base, stories: [fresh(1), fresh(2)] }), ["backlog-bankruptcy"]);
  assert.deepEqual(rules({ ...base, stories: [fresh(1), story({ ref: 2, created_date: "2026-07-01", is_closed: true, finish_date: "2026-09-02" })] }), []);
});
test("backlog-bankruptcy: a reopened story does not count as closed", () => {
  const fresh = (ref) => story({ ref, created_date: "2026-09-01" });
  const reopened = story({ ref: 2, created_date: "2026-07-01", is_closed: false, finish_date: "2026-09-02" });
  assert.deepEqual(rules({ ...base, stories: [fresh(1), reopened] }), ["backlog-bankruptcy"]);
  const actuallyClosed = story({ ref: 2, created_date: "2026-07-01", is_closed: true, finish_date: "2026-09-02" });
  assert.deepEqual(rules({ ...base, stories: [fresh(1), actuallyClosed] }), []);
});
test("unowned-in-progress", () => {
  const task = (o) => ({ ref: 9, subject: "t", status: "In progress", is_closed: false, assigned_to: null, ...o });
  assert.deepEqual(rules({ ...base, tasks: [task({})] }), ["unowned-in-progress"]);
  assert.deepEqual(rules({ ...base, tasks: [task({ assigned_to: "Дмитрий" })] }), []);
  assert.deepEqual(rules({ ...base, tasks: [task({ status: "New" })] }), []);
});
test("waiting-tag", () => {
  assert.deepEqual(rules({ ...base, stories: [story({ tags: ["waiting for design"] })] }), ["waiting-tag"]);
  assert.deepEqual(rules({ ...base, stories: [story({ tags: ["waiting 2026-09-15"] })] }), []);
});
test("findings carry ref and a message", () => {
  const [f] = audit({ ...base, stories: [story({ ref: 42, is_blocked: true })] });
  assert.equal(f.ref, 42); assert.match(f.message, /заблокирована/);
});

test("cli: table output groups by rule, --json parses, missing file exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-"));
  const file = join(dir, "in.json");
  writeFileSync(file, JSON.stringify({ ...base, stories: [story({ is_blocked: true })] }));
  const table = spawnSync(process.execPath, [join(here, "audit.mjs"), file], { encoding: "utf8" });
  assert.equal(table.status, 0);
  assert.match(table.stdout, /## blocked-no-note \(1\)/);

  const json = spawnSync(process.execPath, [join(here, "audit.mjs"), file, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed[0].rule, "blocked-no-note");

  const bad = spawnSync(process.execPath, [join(here, "audit.mjs"), join(dir, "missing.json")], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});
