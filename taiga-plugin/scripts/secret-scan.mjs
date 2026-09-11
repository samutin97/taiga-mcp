#!/usr/bin/env node
// PostToolUse hook for every Taiga tool: if a response carries something that
// looks like a credential, tell the user and tell the model not to repeat it.
// PostToolUse cannot block; the server already strips known signed URLs
// (attachments), so this is the net for whatever it did not foresee.
import { readFileSync } from "node:fs";

const PATTERNS = [
  { name: "signed URL (?token=)", re: /[?&]token=[A-Za-z0-9._~-]{8,}/ },
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const text = JSON.stringify(payload?.tool_response ?? "");
const hits = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
if (hits.length === 0) process.exit(0);

process.stdout.write(JSON.stringify({
  systemMessage: `В ответе Taiga (${payload.tool_name ?? "инструмент"}) встретился секрет: ${hits.join(", ")}. Проверьте, не попал ли он в транскрипт.`,
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: `The last tool response contained a credential-like value (${hits.join(", ")}). Do not quote it, do not write it anywhere, and do not include it in Taiga text.`,
  },
}));
