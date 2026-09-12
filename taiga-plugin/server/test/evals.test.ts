import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Structural checks for the eval suite under taiga-plugin/evals/. These do not
// run `claude plugin eval` itself (that needs network + a real/mocked MCP
// server and costs money); they just enforce the shape the eval runner
// requires, and the project rules for this suite (no skill names leaked into
// prompts, no local-stand secret anywhere under evals/, every negative case
// actually asserts absence, every voice case's regex matches the rules file).

const EVALS_ROOT = path.resolve(__dirname, "../../evals");
const VOICE_RULES_PATH = path.resolve(__dirname, "../../scripts/voice-rules.json");

const INVOCABLE_SKILLS = [
  "taiga-setup",
  "taiga-sprint-report",
  "taiga-backlog-grooming",
  "taiga-stories-from-spec",
  "taiga-issue-triage",
  "taiga-worklog",
  "taiga-prioritize",
  "taiga-estimate",
  "taiga-test-plan",
  "taiga-backlog-health",
];

/** The 7 cases whose voice is graded: voice/1..6 plus the voice holdout. */
const VOICE_CASE_DIRS = [
  "voice/1",
  "voice/2",
  "voice/3",
  "voice/4",
  "voice/5",
  "voice/6",
  "holdout/voice",
];

/** Every directory under `dir` (recursively) that directly contains a prompt.md. */
function findCaseDirs(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  if (entries.includes("prompt.md")) out.push(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findCaseDirs(full));
  }
  return out;
}

/** Every file under `dir`, recursively. */
function findAllFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findAllFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Minimal frontmatter reader for this suite's grader/prompt files: they are
 * always `---\nkey: value\n...\n---\nbody`, one key-value pair per line, no
 * nested structures — good enough to pull out the plain scalars the eval
 * runner itself parses (see task-20-report.md §2 for the accepted schema).
 */
function parseFrontmatter(filePath: string): Record<string, string> {
  const text = readFileSync(filePath, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}

/**
 * The exact combined regex the eval runner should see in every voice case's
 * graders/regex.md, rebuilt here straight from scripts/voice-rules.json so a
 * change to either the source rules or a copy under evals/ that lets them
 * drift apart fails this test. Anchors get the same widening the generator
 * applies:
 *  - fix round 1, Critical 2a: the evidence (`focus:`/`target: mock_calls`)
 *    is a JSON trace, so every physical "line" starts with `{"tool":...` — a
 *    bare `^` never reaches the start of a field value; widened to
 *    "start of string, right after a real newline, or right after an
 *    opening JSON-string quote".
 *  - fix round 2, Critical 2a: a newline *inside* a JSON string value is not
 *    a raw newline byte — JSON escapes it to the literal two characters
 *    `\`+`n` — so a banned pattern on its own paragraph inside a
 *    multi-paragraph `description` ("Сейчас руками.\n\nКритерии приёмки: …")
 *    still needs a third alternative: that literal two-character escape.
 */
function expectedVoiceRegexPattern(): string {
  const rules = JSON.parse(readFileSync(VOICE_RULES_PATH, "utf8"));
  const ruleSet = [
    ...rules.hard,
    ...rules.soft.filter((r: { id: string }) =>
      ["heading-label", "as-a-user", "emoji"].includes(r.id),
    ),
  ];
  const widenAnchor = (pattern: string) =>
    pattern.replace(/^\^\[ \\t\]\*/, '(?:^|\\\\n|\\n|")[ \\t]*');
  return ruleSet.map((r: { pattern: string }) => `(?:${widenAnchor(r.pattern)})`).join("|");
}

/** Build a one-call JSON evidence blob the way `mock_calls` actually renders it. */
function jsonTraceEvidence(description: string): string {
  return JSON.stringify({
    tool: "mcp__plugin_taiga_taiga__taiga_userstory_create",
    input: { project: "mcp-sandbox", subject: "x", description },
    output: { ref: 9001 },
  });
}

describe("evals suite structure", () => {
  it("has a positive-1 and a negative-1 case for every invocable skill", () => {
    for (const skill of INVOCABLE_SKILLS) {
      for (const kind of ["positive-1", "negative-1"]) {
        const dir = path.join(EVALS_ROOT, skill, kind);
        expect(statSync(dir).isDirectory(), `${skill}/${kind} must exist`).toBe(true);
        expect(
          statSync(path.join(dir, "prompt.md")).isFile(),
          `${skill}/${kind}/prompt.md must exist`,
        ).toBe(true);
      }
    }
  });

  it("does not require activation cases for taiga-voice (not user-invocable)", () => {
    // taiga-voice is loaded by the other skills, never invoked directly by a
    // user — it has no "someone asks for it" phrasing to test, so neither a
    // positive-1 (nothing would trigger it) nor a negative-1 (nothing to
    // prove doesn't trigger) is required. This only fixes the earlier,
    // asymmetric check that looked at positive-1 alone.
    for (const kind of ["positive-1", "negative-1"]) {
      expect(() => statSync(path.join(EVALS_ROOT, "taiga-voice", kind))).toThrow();
    }
  });

  it("has exactly six numbered voice cases", () => {
    const voiceDir = path.join(EVALS_ROOT, "voice");
    const entries = readdirSync(voiceDir).filter((e) =>
      statSync(path.join(voiceDir, e)).isDirectory(),
    );
    expect(entries.sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("has three holdout cases: stories-from-spec, prioritize, voice", () => {
    const holdoutDir = path.join(EVALS_ROOT, "holdout");
    const entries = readdirSync(holdoutDir).filter((e) =>
      statSync(path.join(holdoutDir, e)).isDirectory(),
    );
    expect(entries.sort()).toEqual(["prioritize", "stories-from-spec", "voice"]);
  });

  it("gives every case a prompt.md and at least one grader file", () => {
    const caseDirs = findCaseDirs(EVALS_ROOT);
    expect(caseDirs.length).toBeGreaterThan(0);
    for (const dir of caseDirs) {
      const graderDir = path.join(dir, "graders");
      expect(statSync(graderDir).isDirectory(), `${dir}/graders must exist`).toBe(true);
      const graderFiles = readdirSync(graderDir).filter((f) => f.endsWith(".md"));
      expect(graderFiles.length, `${dir}/graders must have >=1 .md file`).toBeGreaterThan(0);
    }
  });

  it("never names a skill inside a prompt.md (activation must read like a real user)", () => {
    const caseDirs = findCaseDirs(EVALS_ROOT);
    for (const dir of caseDirs) {
      const text = readFileSync(path.join(dir, "prompt.md"), "utf8");
      expect(text.includes("taiga-"), `${dir}/prompt.md must not contain "taiga-"`).toBe(false);
    }
  });

  it("never leaks the local stand credential anywhere under evals/", () => {
    for (const file of findAllFiles(EVALS_ROOT)) {
      if (file.includes(`${path.sep}results${path.sep}`)) continue; // gitignored, may hold trace paths
      const text = readFileSync(file, "utf8");
      expect(text.includes("TaigaLocal"), `${file} must not contain "TaigaLocal"`).toBe(false);
      expect(text.includes("localhost:9000"), `${file} must not contain "localhost:9000"`).toBe(
        false,
      );
    }
  });

  it("every positive-1's skill grader names its own skill", () => {
    for (const skill of INVOCABLE_SKILLS) {
      const fm = parseFrontmatter(
        path.join(EVALS_ROOT, skill, "positive-1", "graders", "skill.md"),
      );
      expect(fm.type, `${skill}/positive-1/graders/skill.md type`).toBe("tool_used");
      expect(fm.tool, `${skill}/positive-1/graders/skill.md tool`).toBe("Skill");
      expect(fm.input_match, `${skill}/positive-1/graders/skill.md input_match`).toBe(skill);
    }
  });

  it("every negative-1's skill grader names its own skill and requires min:0, max:0", () => {
    for (const skill of INVOCABLE_SKILLS) {
      const fm = parseFrontmatter(
        path.join(EVALS_ROOT, skill, "negative-1", "graders", "skill.md"),
      );
      expect(fm.type, `${skill}/negative-1/graders/skill.md type`).toBe("tool_used");
      expect(fm.tool, `${skill}/negative-1/graders/skill.md tool`).toBe("Skill");
      expect(fm.input_match, `${skill}/negative-1/graders/skill.md input_match`).toBe(skill);
      expect(fm.min, `${skill}/negative-1/graders/skill.md min`).toBe("0");
      expect(fm.max, `${skill}/negative-1/graders/skill.md max`).toBe("0");
    }
  });

  it("every negative-1 also has a no-taiga-skill-at-all guard (min:0, max:0)", () => {
    for (const skill of INVOCABLE_SKILLS) {
      const fm = parseFrontmatter(
        path.join(EVALS_ROOT, skill, "negative-1", "graders", "no-taiga-skill.md"),
      );
      expect(fm.type).toBe("tool_used");
      expect(fm.tool).toBe("Skill");
      expect(fm.input_match).toBe("taiga-");
      expect(fm.min).toBe("0");
      expect(fm.max).toBe("0");
    }
  });

  it("the 7 voice cases' regex grader equals the pattern derived from scripts/voice-rules.json", () => {
    const expected = expectedVoiceRegexPattern();
    for (const dir of VOICE_CASE_DIRS) {
      const fm = parseFrontmatter(path.join(EVALS_ROOT, dir, "graders", "regex.md"));
      expect(fm.pattern, `${dir}/graders/regex.md pattern`).toBe(expected);
    }
  });

  it("the voice regex actually matches a banned pattern on its own paragraph inside a JSON string value", () => {
    // This is the fix-round-2 regression: the round-1 anchor (start of
    // string / real newline / after an opening quote) still missed a
    // banned pattern that starts its own paragraph *inside* a single
    // multi-paragraph description, because JSON escapes an embedded
    // newline to the literal two characters `\`+`n`, not a raw newline
    // byte — so a bare "after a real newline" alternative never lines up
    // with it.
    const re = new RegExp(expectedVoiceRegexPattern(), "imu");

    const headingAfterEmbeddedNewline = jsonTraceEvidence(
      "Сейчас руками.\n\nКритерии приёмки: раз, два",
    );
    expect(re.test(headingAfterEmbeddedNewline), "heading-label after an embedded newline").toBe(
      true,
    );

    const asAUserAfterEmbeddedNewline = jsonTraceEvidence(
      "Сейчас руками.\n\nКак менеджер, я хочу заводить сам, чтобы не ждать",
    );
    expect(
      re.test(asAUserAfterEmbeddedNewline),
      "as-a-user after an embedded newline",
    ).toBe(true);

    const clean = jsonTraceEvidence(
      "Просто короткая заметка без всяких рубрик и шаблонов, обычным языком.",
    );
    expect(re.test(clean), "a clean description must not match").toBe(false);
  });

  it("every voice case requires that something was actually written", () => {
    for (const dir of VOICE_CASE_DIRS) {
      const fm = parseFrontmatter(path.join(EVALS_ROOT, dir, "graders", "wrote.md"));
      expect(fm.type, `${dir}/graders/wrote.md type`).toBe("tool_used");
      expect(fm.min, `${dir}/graders/wrote.md min`).toBe("1");
      expect(fm.tool, `${dir}/graders/wrote.md tool`).toMatch(/^mcp__plugin_taiga_taiga__taiga_/);
    }
  });
});
