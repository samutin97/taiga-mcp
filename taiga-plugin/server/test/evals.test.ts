import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Structural checks for the eval suite under taiga-plugin/evals/. These do not
// run `claude plugin eval` itself (that needs network + a real/mocked MCP
// server and costs money); they just enforce the shape the eval runner
// requires, and the project rules for this suite (no skill names leaked into
// prompts, no local-stand secret anywhere under evals/).

const EVALS_ROOT = path.resolve(__dirname, "../../evals");

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

  it("does not have activation cases for taiga-voice (not user-invocable)", () => {
    expect(() => statSync(path.join(EVALS_ROOT, "taiga-voice", "positive-1"))).toThrow();
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
});
