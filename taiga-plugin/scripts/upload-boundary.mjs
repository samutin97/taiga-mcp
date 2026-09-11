#!/usr/bin/env node
// PreToolUse hook for taiga_attachment_upload: a file outside the current
// project is not forbidden, but the user has to see it before it leaves.
import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const filePath = payload?.tool_input?.file_path;
if (typeof filePath !== "string" || filePath === "") process.exit(0);

const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
const rel = relative(resolve(cwd), resolve(cwd, filePath));
const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
if (inside) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: `Файл вне текущего проекта уйдёт в Taiga: ${resolve(cwd, filePath)}`,
  },
}));
