import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const run = (script, input) =>
  spawnSync(process.execPath, [join(here, script)], { input: JSON.stringify(input), encoding: "utf8" });

test("upload-boundary: inside cwd is silent", () => {
  const r = run("upload-boundary.mjs", { tool_name: "x", cwd: here, tool_input: { file_path: join(here, "a.txt") } });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
});

test("upload-boundary: outside cwd asks and names the path", () => {
  const outside = resolve(here, "..", "..", "secret.txt");
  const r = run("upload-boundary.mjs", { tool_name: "x", cwd: here, tool_input: { file_path: outside } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /secret\.txt/);
});

test("upload-boundary: junk is silent", () => {
  for (const input of [{}, { tool_input: {} }, { tool_input: { file_path: 3 } }]) {
    const r = run("upload-boundary.mjs", input);
    assert.equal(r.status, 0); assert.equal(r.stdout, "");
  }
});

test("secret-scan: clean response is silent", () => {
  const r = run("secret-scan.mjs", { tool_name: "x", tool_response: { content: [{ type: "text", text: '{"ok":true}' }] } });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
});

test("secret-scan: signed url, bearer and jwt are flagged", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9." + "a".repeat(20) + "." + "b".repeat(20);
  for (const text of ["https://t/x?token=abcdefghij12345", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", jwt]) {
    const r = run("secret-scan.mjs", { tool_name: "x", tool_response: { content: [{ type: "text", text }] } });
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /секрет/i);
    assert.match(out.hookSpecificOutput.additionalContext, /do not quote/i);
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.doesNotMatch(r.stdout, /abcdefghij12345|abcdefghijklmnopqrstuvwxyz|aaaaaaaaaa/, "the secret itself must not be echoed");
  }
});
