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
    status: extra("status_extra_info", "name"),
    assigned_to: extra("assigned_to_extra_info", "full_name_display"),
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
    status: extra("status_extra_info", "name"),
    assigned_to: extra("assigned_to_extra_info", "full_name_display"),
    user_story: extra("user_story_extra_info", "ref"),
    tags,
    is_closed: plain("is_closed"),
  },
  issue: {
    ref: plain("ref"),
    subject: plain("subject"),
    status: extra("status_extra_info", "name"),
    priority: labelled("priority", "priority"),
    severity: labelled("severity", "severity"),
    type: labelled("type", "type"),
    assigned_to: extra("assigned_to_extra_info", "full_name_display"),
    tags,
    is_closed: plain("is_closed"),
  },
  epic: {
    ref: plain("ref"),
    subject: plain("subject"),
    status: extra("status_extra_info", "name"),
    color: plain("color"),
    assigned_to: extra("assigned_to_extra_info", "full_name_display"),
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

  if (Array.isArray(fields)) {
    return Object.fromEntries(fields.map((field) => [field, raw[field] ?? null]));
  }

  const shape = SLIM[resource];
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
