import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startClient } from "./helpers/mcp-client.js";

const SKILLS_DIR = join(import.meta.dirname, "../../skills");

const EXPECTED = [
  "taiga-setup",
  "taiga-sprint-report",
  "taiga-backlog-grooming",
  "taiga-stories-from-spec",
  "taiga-issue-triage",
  "taiga-worklog",
];

describe("skills", () => {
  it("ships all six skills", () => {
    expect(readdirSync(SKILLS_DIR).sort()).toEqual([...EXPECTED].sort());
  });

  it("gives every skill a name and a description", () => {
    for (const skill of EXPECTED) {
      const path = join(SKILLS_DIR, skill, "SKILL.md");
      expect(existsSync(path), `${skill} has no SKILL.md`).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text.startsWith("---\n")).toBe(true);
      expect(text).toMatch(new RegExp(`^name:\\s*${skill}$`, "m"));
      expect(text).toMatch(/^description:\s*\S.+/m);
    }
  });

  it("only references tools the server actually registers", async () => {
    const client = await startClient();
    const { tools } = await client.listTools();
    const known = new Set(tools.map((t) => t.name));

    for (const skill of EXPECTED) {
      const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      // Requires at least two segments after the "taiga_" prefix, so a
      // placeholder form like `taiga_<resource>_create` (which is not a real
      // tool) does not collapse to the bare, unmatchable fragment `taiga_`.
      const mentioned = text.match(/taiga_[a-z]+(?:_[a-z]+)+/g) ?? [];
      for (const name of new Set(mentioned)) {
        expect(known.has(name), `${skill} mentions unknown tool ${name}`).toBe(true);
      }
    }
  });

  it("reminds about confirmation wherever it mentions deletion", () => {
    for (const skill of EXPECTED) {
      const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      if (/_delete/.test(text)) {
        expect(text, `${skill} mentions delete without confirm`).toMatch(/confirm/);
      }
    }
  });
});
