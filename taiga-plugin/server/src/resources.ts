import { z } from "zod";
import type { LookupKind } from "./schema-cache.js";
import type { ResourceName } from "./projections.js";

export interface ResourceDef {
  name: ResourceName;
  path: string;
  label: string;
  /** Key used by /resolver to turn a #ref into an id. */
  resolverKey?: string;
  hasRef: boolean;
  listFilters: z.ZodRawShape;
  createFields: z.ZodRawShape;
  updateFields: z.ZodRawShape;
  /** Fields whose human-readable value must be resolved to a numeric id. */
  lookups: { field: string; kind: LookupKind }[];
  supportsAppend: boolean;
  /**
   * Fields Taiga returns as bare numeric ids, with the lookup table each one
   * resolves against. Projections need these maps to show names instead of ids.
   */
  labels?: { map: "priority" | "severity" | "type" | "member"; kind: LookupKind }[];
}

const tagsField = z
  .array(z.string())
  .optional()
  .describe("Tag names.");

export const USER_STORY: ResourceDef = {
  name: "userstory",
  path: "/userstories",
  label: "user story",
  resolverKey: "us",
  hasRef: true,
  listFilters: {
    sprint: z.string().optional().describe("Sprint (milestone) name to filter by."),
    in_backlog: z.boolean().optional()
      .describe("Only stories not assigned to any sprint."),
    status: z.string().optional().describe("Status name, e.g. 'In progress'."),
    assigned_to: z.string().optional().describe("Assignee full name."),
    epic: z.string().optional().describe("Epic subject to filter by."),
    // Verified live: Taiga's `tags` filter is OR (union), not AND — the brief's
    // draft description claimed "all", which is not what the API does.
    tags: z.array(z.string()).optional().describe("Stories carrying any of these tags."),
    is_closed: z.boolean().optional(),
  },
  createFields: {
    subject: z.string(),
    description: z.string().optional(),
    status: z.string().optional().describe("Status name; defaults to the project's first status."),
    assigned_to: z.string().optional().describe("Assignee full name."),
    sprint: z.string().optional().describe("Sprint (milestone) name."),
    // Verified live: Taiga stores points as a per-role map, not a scalar —
    // sending this value straight through crashes the server. The factory
    // resolves it to the project's primary estimation role; see resolvePoints.
    points: z
      .string()
      .optional()
      .describe(
        "Story points value, e.g. '5'. Applied to the project's primary " +
          "estimation role; other roles are left unestimated.",
      ),
    epic: z.string().optional()
      .describe("Epic subject to link this story to; empty string unlinks it."),
    tags: tagsField,
    due_date: z.string().optional().describe("ISO date, e.g. 2026-09-30."),
  },
  updateFields: {
    subject: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    assigned_to: z.string().optional(),
    sprint: z.string().optional(),
    points: z
      .string()
      .optional()
      .describe(
        "Story points value, e.g. '5'. Applied to the project's primary " +
          "estimation role; other roles keep their current estimate.",
      ),
    epic: z.string().optional()
      .describe("Epic subject to link this story to; empty string unlinks it."),
    tags: tagsField,
    due_date: z.string().optional(),
    is_blocked: z.boolean().optional(),
    blocked_note: z.string().optional(),
  },
  lookups: [
    { field: "status", kind: "userstory-status" },
    { field: "assigned_to", kind: "member" },
  ],
  supportsAppend: true,
};

export const TASK: ResourceDef = {
  name: "task",
  path: "/tasks",
  label: "task",
  resolverKey: "task",
  hasRef: true,
  listFilters: {
    sprint: z.string().optional(),
    status: z.string().optional(),
    assigned_to: z.string().optional().describe("Assignee full name."),
    user_story: z.number().optional().describe("Parent story #ref."),
    tags: z.array(z.string()).optional(),
    is_closed: z.boolean().optional(),
  },
  createFields: {
    subject: z.string(),
    description: z.string().optional(),
    user_story: z.number().optional().describe("Parent story #ref."),
    status: z.string().optional(),
    assigned_to: z.string().optional(),
    tags: tagsField,
    due_date: z.string().optional(),
  },
  updateFields: {
    subject: z.string().optional(),
    description: z.string().optional(),
    user_story: z.number().optional().describe("Parent story #ref."),
    status: z.string().optional(),
    assigned_to: z.string().optional(),
    tags: tagsField,
    due_date: z.string().optional(),
    is_blocked: z.boolean().optional(),
    blocked_note: z.string().optional(),
  },
  lookups: [
    { field: "status", kind: "task-status" },
    { field: "assigned_to", kind: "member" },
  ],
  supportsAppend: true,
};

export const ISSUE: ResourceDef = {
  name: "issue",
  path: "/issues",
  label: "issue",
  resolverKey: "issue",
  hasRef: true,
  listFilters: {
    status: z.string().optional(),
    priority: z.string().optional().describe("e.g. 'High'."),
    severity: z.string().optional().describe("e.g. 'Important'."),
    type: z.string().optional().describe("e.g. 'Bug'."),
    assigned_to: z.string().optional(),
    tags: z.array(z.string()).optional(),
    is_closed: z.boolean().optional(),
  },
  createFields: {
    subject: z.string(),
    description: z.string().optional(),
    status: z.string().optional(),
    priority: z.string().optional(),
    severity: z.string().optional(),
    type: z.string().optional(),
    assigned_to: z.string().optional(),
    tags: tagsField,
    due_date: z.string().optional(),
  },
  updateFields: {
    subject: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    priority: z.string().optional(),
    severity: z.string().optional(),
    type: z.string().optional(),
    assigned_to: z.string().optional(),
    tags: tagsField,
    due_date: z.string().optional(),
  },
  lookups: [
    { field: "status", kind: "issue-status" },
    { field: "priority", kind: "priority" },
    { field: "severity", kind: "severity" },
    { field: "type", kind: "issue-type" },
    { field: "assigned_to", kind: "member" },
  ],
  // Taiga returns priority, severity, and type as bare numeric ids with no *_extra_info; without these maps the tool shows numbers to the model.
  labels: [
    { map: "priority", kind: "priority" },
    { map: "severity", kind: "severity" },
    { map: "type", kind: "issue-type" },
  ],
  supportsAppend: true,
};

export const EPIC: ResourceDef = {
  name: "epic",
  path: "/epics",
  label: "epic",
  resolverKey: "epic",
  hasRef: true,
  listFilters: {
    status: z.string().optional(),
    assigned_to: z.string().optional(),
    tags: z.array(z.string()).optional(),
  },
  createFields: {
    subject: z.string(),
    description: z.string().optional(),
    color: z.string().optional().describe("Hex colour, e.g. #B22222."),
    status: z.string().optional(),
    assigned_to: z.string().optional(),
    tags: tagsField,
  },
  updateFields: {
    subject: z.string().optional(),
    description: z.string().optional(),
    color: z.string().optional(),
    status: z.string().optional(),
    assigned_to: z.string().optional(),
    tags: tagsField,
  },
  lookups: [
    { field: "status", kind: "epic-status" },
    { field: "assigned_to", kind: "member" },
  ],
  supportsAppend: true,
};

export const SPRINT: ResourceDef = {
  name: "sprint",
  path: "/milestones",
  label: "sprint",
  hasRef: false,
  listFilters: {
    closed: z.boolean().optional().describe("Only closed or only open sprints."),
  },
  createFields: {
    name: z.string(),
    estimated_start: z.string().describe("ISO date, e.g. 2026-09-07."),
    estimated_finish: z.string().describe("ISO date, e.g. 2026-09-20."),
  },
  updateFields: {
    name: z.string().optional(),
    estimated_start: z.string().optional(),
    estimated_finish: z.string().optional(),
    closed: z.boolean().optional(),
  },
  lookups: [],
  supportsAppend: false,
};

export const WIKI: ResourceDef = {
  name: "wiki",
  path: "/wiki",
  label: "wiki page",
  hasRef: false,
  listFilters: {},
  createFields: {
    slug: z.string().describe("e.g. 'home'."),
    content: z.string().describe("Markdown content."),
  },
  updateFields: {
    content: z.string().optional().describe("Replacement Markdown content."),
  },
  lookups: [],
  // Taiga returns created_by as a bare numeric id with no *_extra_info; without this map the tool shows a number to the model.
  labels: [{ map: "member", kind: "member" }],
  supportsAppend: false,
};

export const RESOURCES: ResourceDef[] = [
  USER_STORY,
  TASK,
  ISSUE,
  EPIC,
  SPRINT,
  WIKI,
];
