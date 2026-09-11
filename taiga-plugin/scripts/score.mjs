#!/usr/bin/env node
// RICE / WSJF scoring for taiga-prioritize. Input: JSON file
//   { "method": "rice" | "wsjf", "items": [ { "ref", "subject", ...numbers } ] }
// Output: markdown table (default) or JSON (--json), sorted by score, best first.
// The numbers are never written to Taiga — only the resulting order is.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const IMPACT = [0.25, 0.5, 1, 2, 3];

function fail(field, item) {
  throw new Error(`Invalid ${field} on item #${item.ref ?? "?"}`);
}

function num(item, field) {
  const v = Number(item[field]);
  if (!Number.isFinite(v)) fail(field, item);
  return v;
}

export function scoreRice(item) {
  const reach = num(item, "reach");
  const impact = num(item, "impact");
  if (!IMPACT.includes(impact)) fail("impact", item);
  let confidence = num(item, "confidence");
  if (confidence > 1) confidence /= 100;
  if (confidence < 0.5 || confidence > 1) fail("confidence", item);
  const effort = num(item, "effort");
  if (effort <= 0) fail("effort", item);
  return Math.round(((reach * impact * confidence) / effort) * 100) / 100;
}

export function scoreWsjf(item) {
  const parts = ["user_value", "time_criticality", "risk_reduction"].map((f) => {
    const v = num(item, f);
    if (v < 1 || v > 10) fail(f, item);
    return v;
  });
  const duration = num(item, "duration");
  if (duration <= 0) fail("duration", item);
  return Math.round(((parts[0] + parts[1] + parts[2]) / duration) * 100) / 100;
}

export function rank(input) {
  const method = input?.method;
  const score = method === "rice" ? scoreRice : method === "wsjf" ? scoreWsjf : null;
  if (!score) throw new Error(`Unknown method "${method}"; use "rice" or "wsjf"`);
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error("items must be a non-empty array");
  return input.items
    .map((item) => ({ ...item, score: score(item) }))
    .sort((a, b) => b.score - a.score)
    .map((item, i) => ({ ...item, rank: i + 1 }));
}

function table(rows) {
  const lines = ["| # | ref | subject | score |", "|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.rank} | #${r.ref ?? ""} | ${r.subject ?? ""} | ${r.score} |`);
  return lines.join("\n");
}

if (process.argv[1]) {
  let argv1 = resolve(process.argv[1]);
  let scriptPath = fileURLToPath(import.meta.url);
  if (process.platform === "win32") {
    argv1 = argv1.toLowerCase();
    scriptPath = scriptPath.toLowerCase();
  } else {
    argv1 = resolve(argv1);
    scriptPath = resolve(scriptPath);
  }
  if (argv1 === scriptPath) {
    const [file, ...flags] = process.argv.slice(2);
    try {
      const input = JSON.parse(readFileSync(file, "utf8"));
      const rows = rank(input);
      console.log(flags.includes("--json") ? JSON.stringify(rows) : table(rows));
    } catch (error) {
      console.error(`score: ${error.message}`);
      process.exit(2);
    }
  }
}
