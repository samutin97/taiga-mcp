#!/usr/bin/env node
// Regenerates the seven eval voice cases' `graders/regex.md` pattern lines
// from scripts/voice-rules.json, so the grader regex never drifts from the
// rules the hook and the server guard actually enforce. Run after editing
// voice-rules.json: `npm run gen:eval-regex` (from server/), or directly
// `node scripts/gen-eval-regex.mjs` from the plugin root. No dependencies.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalRegexPattern } from "./lib/voice-rules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evalsRoot = join(here, "..", "evals");

/** The 7 cases whose voice is graded: voice/1..6 plus the voice holdout. */
const VOICE_CASE_DIRS = ["voice/1", "voice/2", "voice/3", "voice/4", "voice/5", "voice/6", "holdout/voice"];

const pattern = evalRegexPattern();

for (const dir of VOICE_CASE_DIRS) {
  const file = join(evalsRoot, dir, "graders", "regex.md");
  const text = readFileSync(file, "utf8");
  const updated = text.replace(/^pattern: .*$/m, `pattern: ${pattern}`);
  if (updated === text && !text.includes(`pattern: ${pattern}`)) {
    throw new Error(`${file}: no "pattern:" line found to replace`);
  }
  if (updated !== text) writeFileSync(file, updated);
  console.log(`${updated === text ? "unchanged" : "updated"} evals/${dir}/graders/regex.md`);
}
