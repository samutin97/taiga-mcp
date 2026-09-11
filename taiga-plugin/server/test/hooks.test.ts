import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startClient } from "./helpers/mcp-client.js";

const ROOT = join(import.meta.dirname, "../..");
const hooks = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));
const PREFIX = "mcp__plugin_taiga_taiga__";

const TEXT_WRITERS = [
  ...["userstory", "task", "issue", "epic", "wiki"].flatMap((r) => [`taiga_${r}_create`, `taiga_${r}_update`]),
  "taiga_comment_add",
  "taiga_bulk_create",
].sort();

function matched(matcher: string, names: string[]) {
  const re = new RegExp(`^(?:${matcher})$`);
  return names.filter((n) => re.test(PREFIX + n)).sort();
}

describe("hooks.json", () => {
  it("runs every hook as node with a quoted plugin-root path", () => {
    const all = [...hooks.hooks.PreToolUse, ...hooks.hooks.PostToolUse].flatMap((g: { hooks: { command: string; timeout: number }[] }) => g.hooks);
    expect(all).toHaveLength(3);
    for (const h of all) {
      const m = h.command.match(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z-]+\.mjs)"$/);
      expect(m, h.command).not.toBeNull();
      expect(existsSync(join(ROOT, "scripts", m![1]))).toBe(true);
      expect(h.timeout).toBe(10);
    }
  });

  it("aims the voice gate at exactly the twelve text-writing tools", async () => {
    const { tools } = await (await startClient()).listTools();
    const names = tools.map((t) => t.name);
    const [voice, upload] = hooks.hooks.PreToolUse;
    expect(matched(voice.matcher, names)).toEqual(TEXT_WRITERS);
    expect(matched(upload.matcher, names)).toEqual(["taiga_attachment_upload"]);
    expect(matched(hooks.hooks.PostToolUse[0].matcher, names)).toHaveLength(42);
  });
});
