#!/usr/bin/env node
// Backlog health audit for taiga-backlog-health. Input: JSON file
//   { now?: "YYYY-MM-DD", options?: { stale_days, max_points, window_days, overload_ratio },
//     stories: [...], tasks: [...], sprints: [...], stats?: { speed } }
// Output: markdown report grouped by rule (default) or JSON (--json).
//
// Note (spec deviation, decision): the original spec's rule
// "several assignees in comments" is not derivable from this data (comments
// are not exported) and is replaced by `unowned-in-progress`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_OPTIONS = { stale_days: 7, max_points: 13, window_days: 30, overload_ratio: 1.2 };

// `\b` in JS regex only recognizes ASCII word characters, so it never finds a
// boundary after a Cyrillic word (every character on both sides counts as
// "non-word"). A Unicode-aware lookahead is used instead of the brief's `\b`
// so Cyrillic verbs match the same as their ASCII counterparts.
const ACTION_TITLE_RE = /^(Реализовать|Сделать|Добавить|Создать|Разработать|Внедрить|Настроить|Implement|Add|Create|Build|Develop|Set up)(?![\p{L}\p{N}])/iu;
const INITIAL_STATUS_RE = /^(new|новая|новый|backlog|бэклог)$/i;
const WAITING_TAG_RE = /^(waiting|wait|ждём|ждем|блок)/i;
const TAG_DATE_RE = /\d{4}-\d{2}-\d{2}/;

function daysBetween(from, to) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.floor((b - a) / 86400000);
}

function isInitialStatus(status) {
  return typeof status === "string" && INITIAL_STATUS_RE.test(status.trim());
}

// Number from a number, a numeric string, or the sum of an object's numeric
// values. NaN (unparseable input) means the rule stays silent for that item.
export function pointsOf(v) {
  if (v == null) return NaN;
  if (typeof v === "number" || typeof v === "string") return Number(v);
  if (typeof v === "object") {
    const values = Object.values(v);
    if (values.length === 0) return NaN;
    let sum = 0;
    for (const val of values) {
      const n = Number(val);
      if (Number.isNaN(n)) return NaN;
      sum += n;
    }
    return sum;
  }
  return NaN;
}

function checkActionTitle(story) {
  return typeof story.subject === "string" && ACTION_TITLE_RE.test(story.subject)
    ? "заголовок про действие, а не про результат"
    : null;
}

function checkBlockedNoNote(story) {
  return story.is_blocked && !story.blocked_note ? "заблокирована без причины" : null;
}

function checkStale(story, now, staleDays) {
  if (story.is_closed) return null;
  if (isInitialStatus(story.status)) return null;
  if ((story.total_comments ?? 0) !== 0) return null;
  const age = daysBetween(story.modified_date, now);
  if (Number.isNaN(age) || age <= staleDays) return null;
  return `в работе ${age} дней без движения и комментариев`;
}

function checkOversized(story, maxPoints) {
  const n = pointsOf(story.points);
  if (Number.isNaN(n)) return null;
  return n > maxPoints ? `оценка ${n} > ${maxPoints} — резать` : null;
}

function checkWaitingTag(story) {
  if (story.blocked_note) return null;
  const tags = Array.isArray(story.tags) ? story.tags : [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    if (!WAITING_TAG_RE.test(tag)) continue;
    if (TAG_DATE_RE.test(tag)) continue;
    return "тег ожидания без даты и причины";
  }
  return null;
}

function checkUnownedInProgress(task) {
  if (task.is_closed) return null;
  if (isInitialStatus(task.status)) return null;
  const assignee = task.assigned_to;
  const empty = assignee == null || assignee === "" || (Array.isArray(assignee) && assignee.length === 0);
  return empty ? "задача в работе без ответственного" : null;
}

export function audit(input) {
  const now = input?.now ?? new Date();
  const options = { ...DEFAULT_OPTIONS, ...(input?.options ?? {}) };
  const stories = Array.isArray(input?.stories) ? input.stories : [];
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  const sprints = Array.isArray(input?.sprints) ? input.sprints : [];
  const stats = input?.stats ?? {};

  const findings = [];

  for (const story of stories) {
    const push = (rule, message) => findings.push({ rule, ref: story.ref, subject: story.subject, message });

    const actionTitle = checkActionTitle(story);
    if (actionTitle) push("action-title", actionTitle);

    const blockedNoNote = checkBlockedNoNote(story);
    if (blockedNoNote) push("blocked-no-note", blockedNoNote);

    const stale = checkStale(story, now, options.stale_days);
    if (stale) push("stale", stale);

    const oversized = checkOversized(story, options.max_points);
    if (oversized) push("oversized", oversized);

    const waitingTag = checkWaitingTag(story);
    if (waitingTag) push("waiting-tag", waitingTag);
  }

  for (const task of tasks) {
    const unowned = checkUnownedInProgress(task);
    if (unowned) findings.push({ rule: "unowned-in-progress", ref: task.ref, subject: task.subject, message: unowned });
  }

  for (const sprint of sprints) {
    if (sprint.closed) continue;
    const speed = stats.speed;
    if (!(speed > 0)) continue;
    const total = Number(sprint.total_points);
    if (Number.isNaN(total)) continue;
    if (total > speed * options.overload_ratio) {
      findings.push({
        rule: "sprint-overloaded",
        sprint: sprint.name,
        message: `${total} поинтов при скорости ${speed}`,
      });
    }
  }

  {
    let created = 0;
    let closed = 0;
    for (const story of stories) {
      const createdAge = daysBetween(story.created_date, now);
      if (!Number.isNaN(createdAge) && createdAge >= 0 && createdAge <= options.window_days) created += 1;
      if (story.is_closed === true && story.finish_date) {
        const closedAge = daysBetween(story.finish_date, now);
        if (!Number.isNaN(closedAge) && closedAge >= 0 && closedAge <= options.window_days) closed += 1;
      }
    }
    if (created > closed) {
      findings.push({
        rule: "backlog-bankruptcy",
        message: `приток ${created} > выпуск ${closed} за окно`,
      });
    }
  }

  return findings;
}

function table(findings) {
  if (findings.length === 0) return "Проблем не найдено";
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  const lines = [];
  for (const [rule, items] of byRule) {
    lines.push(`## ${rule} (${items.length})`);
    for (const f of items) {
      if (f.sprint != null) {
        lines.push(`- ${f.sprint}: ${f.message}`);
      } else if (f.ref != null) {
        lines.push(`- #${f.ref} ${f.subject ?? ""}: ${f.message}`);
      } else {
        lines.push(`- ${f.message}`);
      }
    }
  }
  return lines.join("\n");
}

if (process.argv[1]) {
  let argv1 = resolve(process.argv[1]);
  let scriptPath = fileURLToPath(import.meta.url);
  if (process.platform === "win32") {
    argv1 = argv1.toLowerCase();
    scriptPath = scriptPath.toLowerCase();
  } else {
    argv1 = resolve(argv1);
    scriptPath = resolve(scriptPath);
  }
  if (argv1 === scriptPath) {
    const [file, ...flags] = process.argv.slice(2);
    try {
      const input = JSON.parse(readFileSync(file, "utf8"));
      const findings = audit(input);
      console.log(flags.includes("--json") ? JSON.stringify(findings) : table(findings));
    } catch (error) {
      console.error(`audit: ${error.message}`);
      process.exit(2);
    }
  }
}
