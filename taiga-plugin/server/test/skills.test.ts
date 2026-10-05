import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startClient } from "./helpers/mcp-client.js";

const SKILLS_DIR = join(import.meta.dirname, "../../skills");
const ROOT = join(import.meta.dirname, "../..");

const EXPECTED = [
  "taiga-voice", "taiga-setup", "taiga-sprint-report", "taiga-backlog-grooming",
  "taiga-stories-from-spec", "taiga-issue-triage", "taiga-worklog",
  "taiga-prioritize", "taiga-estimate", "taiga-test-plan", "taiga-backlog-health",
  "taiga-requirements", "taiga-model", "taiga-distribute", "taiga-workflow",
];
const WRITERS = ["taiga-worklog", "taiga-backlog-grooming", "taiga-stories-from-spec", "taiga-issue-triage", "taiga-prioritize", "taiga-estimate", "taiga-test-plan", "taiga-distribute", "taiga-workflow"];
const READ_ONLY = ["taiga-sprint-report", "taiga-backlog-health"];
const PORTABLE_KEYS = new Set(["name", "description", "allowed-tools", "license", "compatibility", "metadata"]);

function read(skill: string) {
  const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
  const [, front, ...rest] = text.split(/^---$/m);
  const keys = [...front.matchAll(/^([a-z-]+):/gm)].map((m) => m[1]);
  const description = front.match(/^description:\s*(.+)$/m)?.[1].trim() ?? "";
  return { text, front, body: rest.join("---"), keys, description };
}

describe("skills", () => {
  it("ships all fifteen skills", () => {
    expect(readdirSync(SKILLS_DIR).sort()).toEqual([...EXPECTED].sort());
  });

  it("uses only portable frontmatter, except user-invocable on taiga-voice", () => {
    for (const skill of EXPECTED) {
      const { keys, front } = read(skill);
      expect(front).toMatch(new RegExp(`^name:\\s*${skill}$`, "m"));
      for (const key of keys) {
        if (skill === "taiga-voice" && key === "user-invocable") continue;
        expect(PORTABLE_KEYS.has(key), `${skill} uses non-portable key ${key}`).toBe(true);
      }
    }
    expect(read("taiga-voice").front).toMatch(/^user-invocable:\s*false$/m);
  });

  // Size limits only guard against runaway growth. When a rule needs the room,
  // raise the limit instead of squeezing the rule: clarity beats token savings.
  it("describes triggers only, in the third person, within 4000 chars total", () => {
    let total = 0;
    for (const skill of EXPECTED) {
      const { description } = read(skill);
      expect(description, skill).toMatch(/^Использовать/);
      // JS \b is ASCII-only; Cyrillic needs explicit letter lookarounds.
      expect(description, skill).not.toMatch(/(?<![\p{L}])(я|мы|ты|мне|нам)(?![\p{L}])/iu);
      total += description.length;
    }
    expect(total).toBeLessThanOrEqual(4000);
  });

  it("keeps every body under 250 lines and every reference link real", () => {
    for (const skill of EXPECTED) {
      const { body } = read(skill);
      expect(body.trim().split("\n").length, skill).toBeLessThanOrEqual(250);
      if (/reference\.md/.test(body)) expect(existsSync(join(SKILLS_DIR, skill, "reference.md")), `${skill}/reference.md`).toBe(true);
    }
  });

  it("makes every writing skill load taiga-voice first", () => {
    for (const skill of WRITERS) {
      const firstLine = read(skill).body.trim().split("\n")[0];
      expect(firstLine, skill).toBe("Сначала загрузи скилл `taiga-voice`.");
    }
  });

  it("restricts read-only skills to read-only tools with the full prefix", async () => {
    const { tools } = await (await startClient()).listTools();
    const readOnly = new Set(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name));
    for (const skill of READ_ONLY) {
      const allowed = read(skill).front.match(/^allowed-tools:\s*(.+)$/m)?.[1] ?? "";
      expect(allowed, `${skill} has no allowed-tools`).not.toBe("");
      for (const entry of allowed.split(",").map((s) => s.trim())) {
        if (["Bash", "Read", "Write"].includes(entry)) continue;
        const m = entry.match(/^mcp__plugin_taiga_taiga__(taiga_[a-z_]+)$/);
        expect(m, `${skill}: ${entry} lacks the full prefix`).not.toBeNull();
        expect(readOnly.has(m![1]), `${skill}: ${entry} is not read-only`).toBe(true);
      }
    }
  });

  it("only references tools the server actually registers", async () => {
    const { tools } = await (await startClient()).listTools();
    const known = new Set(tools.map((t) => t.name));
    for (const skill of EXPECTED) {
      for (const file of ["SKILL.md", "reference.md", "voice.md", "examples.md"]) {
        const path = join(SKILLS_DIR, skill, file);
        if (!existsSync(path)) continue;
        const mentioned = readFileSync(path, "utf8").match(/taiga_[a-z]+(?:_[a-z]+)+/g) ?? [];
        for (const name of new Set(mentioned)) expect(known.has(name), `${skill}/${file} mentions unknown tool ${name}`).toBe(true);
      }
    }
  });

  it("reminds about confirmation wherever it mentions deletion", () => {
    for (const skill of EXPECTED) {
      const { text } = read(skill);
      if (/_delete/.test(text)) expect(text, `${skill} mentions delete without confirm`).toMatch(/confirm/);
    }
  });

  it("calls scripts by their real paths", () => {
    for (const skill of EXPECTED) {
      const { body } = read(skill);
      for (const m of body.matchAll(/scripts\/([a-z-]+\.mjs)/g)) {
        expect(existsSync(join(ROOT, "scripts", m[1])), `${skill} calls missing script ${m[1]}`).toBe(true);
      }
    }
  });
});
