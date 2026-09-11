#!/usr/bin/env node
// PreToolUse hook and CLI for the voice rules.
//   hook:  JSON on stdin ({tool_name, tool_input, ...}) → JSON decision on stdout
//   cli:   voice-gate.mjs --file <draft.md> → report on stdout, exit 0 clean / 1 soft / 2 hard
// Anything it cannot parse is not its business: silent exit 0.
import { readFileSync } from "node:fs";
import { checkArgs, checkText, formatReason } from "./lib/voice-rules.mjs";

function decide(findings) {
  if (findings.length === 0) return null;
  const hard = findings.some((f) => f.level === "hard");
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: hard ? "deny" : "ask",
      permissionDecisionReason: formatReason(findings),
    },
  };
}

function runCli(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`voice-gate: cannot read ${path}`);
    process.exit(2);
  }
  const findings = checkText(text);
  if (findings.length === 0) {
    console.log("Чисто: ни одного правила голоса не задето.");
    process.exit(0);
  }
  console.log(formatReason(findings));
  process.exit(findings.some((f) => f.level === "hard") ? 2 : 1);
}

function runHook() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const decision = decide(checkArgs(payload?.tool_input));
  if (decision) process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

const fileFlag = process.argv.indexOf("--file");
if (fileFlag !== -1 && process.argv[fileFlag + 1]) runCli(process.argv[fileFlag + 1]);
else runHook();
