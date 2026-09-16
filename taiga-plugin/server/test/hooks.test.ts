import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startClient } from "./helpers/mcp-client.js";
import { RULES } from "../../scripts/lib/voice-rules.mjs";

const ROOT = join(import.meta.dirname, "../..");
const hooks = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"));
const PREFIX = "mcp__plugin_taiga_taiga__";

/**
 * A tool needs the voice gate when it writes (not readOnlyHint) and its
 * top-level input carries at least one text field the voice rules check
 * (scripts/voice-rules.json's `fields`). `taiga_bulk_create` is the one
 * declared exception: its text fields live inside each `items[]` element,
 * not as top-level schema properties, so this shape-based derivation can't
 * see them — the hook still has to cover it.
 */
function derivedTextWriters(tools: { name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: unknown }[]): string[] {
  const derived = tools
    .filter((t) => t.annotations?.readOnlyHint !== true)
    .filter((t) => {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      return props.some((p) => RULES.fields.includes(p));
    })
    .map((t) => t.name);
  return [...new Set([...derived, "taiga_bulk_create"])].sort();
}

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

  it("aims the voice gate at exactly the text-writing tools derived from the schemas", async () => {
    const { tools } = await (await startClient()).listTools();
    const names = tools.map((t) => t.name);
    const expected = derivedTextWriters(tools);
    const [voice, upload] = hooks.hooks.PreToolUse;
    expect(matched(voice.matcher, names)).toEqual(expected);
    expect(matched(upload.matcher, names)).toEqual(["taiga_attachment_upload"]);
    expect(matched(hooks.hooks.PostToolUse[0].matcher, names)).toHaveLength(43);
  });
});
