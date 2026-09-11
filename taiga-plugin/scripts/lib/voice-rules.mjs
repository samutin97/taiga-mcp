// Voice rules for text the plugin writes into Taiga. One source of truth
// (../voice-rules.json), two consumers: the PreToolUse hook (voice-gate.mjs)
// and the MCP server's TAIGA_VOICE_GUARD. No dependencies, plain Node ≥ 20.11.
import rules from "../voice-rules.json" with { type: "json" };

export const RULES = rules;

const QUOTE_MAX = 60;

function compileOne(level, rule) {
  try {
    return { id: rule.id, reason: rule.reason, level, re: new RegExp(rule.pattern, rule.flags ?? "u") };
  } catch (error) {
    throw new Error(`voice rule "${rule.id}" does not compile: ${error.message}`);
  }
}

export function compileRules(source = RULES) {
  return {
    fields: [...(source.fields ?? [])],
    hard: (source.hard ?? []).map((r) => compileOne("hard", r)),
    soft: (source.soft ?? []).map((r) => compileOne("soft", r)),
  };
}

let defaultCompiled;
function compiled(c) {
  return c ?? (defaultCompiled ??= compileRules());
}

function quoteOf(match) {
  const text = match.replace(/\s+/g, " ").trim();
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1)}…` : text;
}

/** Every rule hit in one string; a rule with the `g`-less regex reports each occurrence via matchAll. */
export function checkText(text, c) {
  if (typeof text !== "string" || text === "") return [];
  const rules = compiled(c);
  const findings = [];
  for (const rule of [...rules.hard, ...rules.soft]) {
    const global = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`);
    for (const m of text.matchAll(global)) {
      findings.push({ level: rule.level, id: rule.id, reason: rule.reason, quote: quoteOf(m[0]), field: "" });
      if (m[0] === "") break;
    }
  }
  return findings;
}

/** Walk the text-bearing fields of a tool call: top level and each items[] element. */
export function checkArgs(args, c) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const rules = compiled(c);
  const out = [];
  const visit = (obj, prefix) => {
    for (const field of rules.fields) {
      for (const f of checkText(obj[field], rules)) out.push({ ...f, field: `${prefix}${field}` });
    }
  };
  visit(args, "");
  if (Array.isArray(args.items)) {
    args.items.forEach((item, i) => {
      if (item && typeof item === "object" && !Array.isArray(item)) visit(item, `items[${i}].`);
    });
  }
  return out;
}

export function formatReason(findings) {
  const lines = findings.map((f) => `— ${f.reason}${f.field ? ` (${f.field})` : ""}: «${f.quote}»`);
  const hard = findings.some((f) => f.level === "hard");
  const head = hard
    ? "Текст выдаёт, что его писал инструмент. Так в Taiga не пишу:"
    : "Текст не похож на мой. Проверь и перепиши или подтверди:";
  return [head, ...lines].join("\n");
}
