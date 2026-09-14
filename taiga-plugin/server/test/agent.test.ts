import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startClient } from "./helpers/mcp-client.js";

const ROOT = join(import.meta.dirname, "../..");
const text = readFileSync(join(ROOT, "agents/taiga-reporter.md"), "utf8");
const front = text.split("---")[1];
const field = (name: string) => front.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1].trim() ?? "";

describe("taiga-reporter agent", () => {
  it("has name, description, model and a bounded turn count", () => {
    expect(field("name")).toBe("taiga-reporter");
    expect(field("description")).toMatch(/proactively|проактивно/i);
    expect(field("model")).toBe("sonnet");
    expect(Number(field("maxTurns"))).toBeLessThanOrEqual(30);
  });

  it("lists only read-only Taiga tools plus Read/Write/Bash", async () => {
    const { tools } = await (await startClient()).listTools();
    const readOnly = new Set(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => `mcp__plugin_taiga_taiga__${t.name}`));
    const listed = field("tools").split(",").map((s) => s.trim());
    for (const tool of listed) {
      if (["Read", "Write", "Bash"].includes(tool)) continue;
      expect(readOnly.has(tool), `${tool} is not a read-only Taiga tool`).toBe(true);
    }
    expect(listed).toContain("mcp__plugin_taiga_taiga__taiga_stats");
  });

  it("preloads skills that exist", () => {
    const skills = field("skills").replace(/[\[\]]/g, "").split(",").map((s) => s.trim());
    expect(skills).toEqual(["taiga-sprint-report", "taiga-backlog-health"]);
    for (const s of skills) expect(existsSync(join(ROOT, "skills", s, "SKILL.md"))).toBe(true);
  });
});
