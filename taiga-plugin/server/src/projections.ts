import { TaigaError } from "./errors.js";

export type ResourceName =
  | "userstory"
  | "task"
  | "issue"
  | "epic"
  | "sprint"
  | "wiki"
  | "project";

export type FieldMode = "slim" | "full" | string[];

/** Reverse id→name maps for fields Taiga returns as bare numeric ids. */
export interface LabelMaps {
  status?: Map<number, string>;
  priority?: Map<number, string>;
  severity?: Map<number, string>;
  type?: Map<number, string>;
  member?: Map<number, string>;
}

type Getter = (raw: Record<string, unknown>, labels: LabelMaps) => unknown;

const extra = (key: string, field: string): Getter => (raw) => {
  const info = raw[key] as Record<string, unknown> | null | undefined;
  return info ? (info[field] ?? null) : null;
};

/**
 * Taiga returns these as bare numeric ids with no *_extra_info companion,
 * so the name has to come from the project's cached lookup tables.
 * Falls back to the raw id when no map was supplied.
 */
const labelled = (key: string, map: keyof LabelMaps): Getter => (raw, labels) => {
  const id = raw[key];
  if (typeof id !== "number") return null;
  return labels[map]?.get(id) ?? id;
};

/**
 * Prefer Taiga's inline *_extra_info object. The /search endpoint omits those
 * and sends a bare numeric id instead, so fall back to the project's lookup
 * table, and to the raw id if no map was supplied.
 */
const named =
  (infoKey: string, infoField: string, idKey: string, map: keyof LabelMaps): Getter =>
  (raw, labels) => {
    const info = raw[infoKey] as Record<string, unknown> | null | undefined;
    if (info && info[infoField] != null) return info[infoField];
    const id = raw[idKey];
    if (typeof id !== "number") return null;
    return labels[map]?.get(id) ?? id;
  };

/** Taiga returns tags as [name, colour] pairs; only the name is useful. */
const tags: Getter = (raw) =>
  Array.isArray(raw.tags)
    ? (raw.tags as unknown[]).map((tag) => (Array.isArray(tag) ? tag[0] : tag))
    : [];

const plain = (key: string): Getter => (raw) => raw[key] ?? null;

const SLIM: Record<ResourceName, Record<string, Getter>> = {
  userstory: {
    ref: plain("ref"),
    subject: plain("subject"),
    status: named("status_extra_info", "name", "status", "status"),
    assigned_to: named("assigned_to_extra_info", "full_name_display", "assigned_to", "member"),
    sprint: plain("milestone_name"),
    points: plain("total_points"),
    tags,
    is_blocked: plain("is_blocked"),
    is_closed: plain("is_closed"),
    total_comments: plain("total_comments"),
  },
  task: {
    ref: plain("ref"),
    subject: plain("subject"),
    status: named("status_extra_info", "name", "status", "status"),
    assigned_to: named("assigned_to_extra_info", "full_name_display", "assigned_to", "member"),
    user_story: extra("user_story_extra_info", "ref"),
    tags,
    is_closed: plain("is_closed"),
  },
  issue: {
    ref: plain("ref"),
    subject: plain("subject"),
    status: named("status_extra_info", "name", "status", "status"),
    priority: labelled("priority", "priority"),
    severity: labelled("severity", "severity"),
    type: labelled("type", "type"),
    assigned_to: named("assigned_to_extra_info", "full_name_display", "assigned_to", "member"),
    tags,
    is_closed: plain("is_closed"),
  },
  epic: {
    ref: plain("ref"),
    subject: plain("subject"),
    status: named("status_extra_info", "name", "status", "status"),
    color: plain("color"),
    assigned_to: named("assigned_to_extra_info", "full_name_display", "assigned_to", "member"),
    stories_total: (raw) =>
      (raw.user_stories_counts as Record<string, unknown> | undefined)?.total ?? null,
    stories_progress: (raw) =>
      (raw.user_stories_counts as Record<string, unknown> | undefined)?.progress ?? null,
  },
  sprint: {
    id: plain("id"),
    name: plain("name"),
    slug: plain("slug"),
    estimated_start: plain("estimated_start"),
    estimated_finish: plain("estimated_finish"),
    closed: plain("closed"),
    total_points: plain("total_points"),
    closed_points: plain("closed_points"),
  },
  wiki: {
    id: plain("id"),
    slug: plain("slug"),
    modified_date: plain("modified_date"),
    last_modifier: labelled("last_modifier", "member"),
  },
  project: {
    id: plain("id"),
    slug: plain("slug"),
    name: plain("name"),
    description: plain("description"),
    is_backlog_activated: plain("is_backlog_activated"),
    is_kanban_activated: plain("is_kanban_activated"),
    is_issues_activated: plain("is_issues_activated"),
    is_wiki_activated: plain("is_wiki_activated"),
    is_epics_activated: plain("is_epics_activated"),
  },
};

export function project(
  resource: ResourceName,
  raw: Record<string, unknown>,
  fields: FieldMode = "slim",
  labels: LabelMaps = {},
): Record<string, unknown> {
  if (fields === "full") return raw;

  const shape = SLIM[resource];

  if (Array.isArray(fields)) {
    // Run each requested name through the same getter `slim` uses. Reading
    // straight off the raw object meant `fields: ["status"]` returned a bare
    // numeric id where `slim` returned "Closed" — the same field name in two
    // different value spaces, handed to the caller most likely to be
    // narrowing its projection to save context. A name that is neither a slim
    // field nor present on the raw object is a typo, not a null.
    return Object.fromEntries(
      fields.map((field) => {
        const get = shape[field];
        if (get) return [field, get(raw, labels)];
        if (field in raw) return [field, raw[field] ?? null];
        throw new TaigaError(`"${field}" is not a field of a Taiga ${resource}.`, {
          hint: `Known fields: ${Object.keys(shape).join(", ")}. Use fields: "full" to see everything.`,
        });
      }),
    );
  }

  return Object.fromEntries(
    Object.entries(shape).map(([name, get]) => [name, get(raw, labels)]),
  );
}

export function projectMany(
  resource: ResourceName,
  rows: Record<string, unknown>[],
  fields: FieldMode = "slim",
  labels: LabelMaps = {},
): Record<string, unknown>[] {
  return rows.map((row) => project(resource, row, fields, labels));
}
