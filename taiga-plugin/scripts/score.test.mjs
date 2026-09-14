import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scoreRice, scoreWsjf, rank } from "./score.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("RICE: reach × impact × confidence / effort", () => {
  assert.equal(scoreRice({ reach: 4000, impact: 2, confidence: 1, effort: 1 }), 8000);
  assert.equal(scoreRice({ reach: 1500, impact: 3, confidence: 75, effort: 1 }), 3375, "percent confidence accepted");
});

test("RICE: validation names the field and the item", () => {
  assert.throws(() => rank({ method: "rice", items: [{ ref: 7, reach: 1, impact: 1.5, confidence: 1, effort: 1 }] }), /impact.*#7/);
  assert.throws(() => rank({ method: "rice", items: [{ ref: 7, reach: 1, impact: 1, confidence: 1, effort: 0 }] }), /effort.*#7/);
  assert.throws(() => rank({ method: "rice", items: [{ ref: 7, reach: 1, impact: 1, confidence: 0.2, effort: 1 }] }), /confidence.*#7/);
});

test("WSJF: cost of delay / duration", () => {
  assert.equal(scoreWsjf({ user_value: 8, time_criticality: 5, risk_reduction: 2, duration: 3 }), 5);
  assert.throws(() => rank({ method: "wsjf", items: [{ ref: 1, user_value: 11, time_criticality: 1, risk_reduction: 1, duration: 1 }] }), /user_value.*#1/);
});

test("rank sorts descending and numbers from 1", () => {
  const out = rank({ method: "rice", items: [
    { ref: 1, subject: "gateway", reach: 1500, impact: 3, confidence: 0.75, effort: 1 },
    { ref: 2, subject: "chatbot", reach: 4000, impact: 2, confidence: 1, effort: 1 },
  ] });
  assert.deepEqual(out.map((r) => [r.rank, r.ref, r.score]), [[1, 2, 8000], [2, 1, 3375]]);
});

test("cli prints a table or json", () => {
  const dir = mkdtempSync(join(tmpdir(), "score-"));
  const file = join(dir, "in.json");
  writeFileSync(file, JSON.stringify({ method: "rice", items: [{ ref: 2, subject: "chatbot", reach: 4000, impact: 2, confidence: 1, effort: 1 }] }));
  const table = spawnSync(process.execPath, [join(here, "score.mjs"), file], { encoding: "utf8" });
  assert.equal(table.status, 0);
  assert.match(table.stdout, /\| 1 \| #2 \| chatbot \| 8000 \|/);
  const json = spawnSync(process.execPath, [join(here, "score.mjs"), file, "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(json.stdout)[0].score, 8000);
  const bad = spawnSync(process.execPath, [join(here, "score.mjs"), join(dir, "missing.json")], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});
