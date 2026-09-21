import type { TaigaClient } from "./client.js";
import { TaigaError } from "./errors.js";
import { attributeSummaries, type AttrResource } from "./custom-attributes.js";

export type LookupKind =
  | "userstory-status"
  | "task-status"
  | "issue-status"
  | "epic-status"
  | "priority"
  | "severity"
  | "issue-type"
  | "points"
  | "role"
  | "member";

const LOOKUP_PATHS: Record<LookupKind, string> = {
  "userstory-status": "/userstory-statuses",
  "task-status": "/task-statuses",
  "issue-status": "/issue-statuses",
  "epic-status": "/epic-statuses",
  priority: "/priorities",
  severity: "/severities",
  "issue-type": "/issue-types",
  points: "/points",
  role: "/roles",
  member: "/memberships",
};

export interface LookupEntry {
  id: number;
  name: string;
  /** Extra label used to disambiguate duplicates, e.g. a member's email. */
  qualifier?: string;
  /** Member's Taiga login. Only set for kind "member". */
  username?: string;
  /** Member's role in the project. Only set for kind "member". */
  role?: string;
}

export interface CustomFieldEntry {
  name: string;
  type: string;
}

export interface ProjectSchema {
  id: number;
  slug: string;
  name: string;
  lookups: Record<LookupKind, LookupEntry[]>;
  /** The four team-convention fields («Оценка», «Блокируется», …) live here, when set up. */
  customFields: Record<AttrResource, CustomFieldEntry[]>;
}

interface CacheOptions {
  defaultProject?: string;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class SchemaCache {
  private readonly lookups = new Map<string, { at: number; entries: LookupEntry[] }>();
  private readonly projects = new Map<string, number>();
  private readonly slugById = new Map<number, string>();
  private readonly ttlMs: number;

  constructor(
    private readonly client: TaigaClient,
    private readonly options: CacheOptions,
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  invalidate(projectId?: number): void {
    if (projectId === undefined) {
      this.lookups.clear();
      this.projects.clear();
      this.slugById.clear();
      return;
    }
    for (const key of [...this.lookups.keys()]) {
      if (key.startsWith(`${projectId}:`)) this.lookups.delete(key);
    }
    this.slugById.delete(projectId);
  }

  async resolveProject(ref?: string | number): Promise<number> {
    const value = ref ?? this.options.defaultProject;
    if (value === undefined || value === "") {
      throw new TaigaError("No Taiga project specified.", {
        hint:
          "Pass `project` explicitly, or set TAIGA_PROJECT to a project id or slug.",
      });
    }
    if (typeof value === "number") return value;
    if (/^\d+$/.test(value)) return Number(value);

    const cached = this.projects.get(value);
    if (cached !== undefined) return cached;

    const project = await this.client.get<{ id: number }>("/projects/by_slug", {
      slug: value,
    });
    this.projects.set(value, project.id);
    return project.id;
  }

  /** Project slug by id, memoised — /resolver needs the slug, not the id. */
  private async projectSlug(projectId: number): Promise<string> {
    const cached = this.slugById.get(projectId);
    if (cached !== undefined) return cached;
    const project = await this.client.get<{ slug: string }>(`/projects/${projectId}`);
    this.slugById.set(projectId, project.slug);
    return project.slug;
  }

  /** Turn `#42` into an internal object id via Taiga's resolver endpoint. */
  async resolveRef(projectId: number, resolverKey: string, ref: number): Promise<number> {
    const slug = await this.projectSlug(projectId);
    const missing = () =>
      new TaigaError(`No item #${ref} in project ${slug}.`, { status: 404 });
    let resolved: Record<string, number>;
    try {
      resolved = await this.client.get<Record<string, number>>("/resolver", {
        project: slug,
        [resolverKey]: ref,
      });
    } catch (error) {
      // Verified live: a resolver miss is HTTP 404 with an EMPTY
      // `_error_message`, so the generic HTTP error carries no usable text at
      // all. Say what was looked for and where instead of letting a blank
      // message through.
      if (error instanceof TaigaError && error.status === 404) throw missing();
      throw error;
    }
    const id = resolved[resolverKey];
    if (typeof id !== "number") throw missing();
    return id;
  }

  async entries(projectId: number, kind: LookupKind): Promise<LookupEntry[]> {
    const key = `${projectId}:${kind}`;
    const hit = this.lookups.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.entries;

    // page_size explicit: Taiga paginates these endpoints at 30 by default
    // (x-paginated-by: 30, verified live). Statuses rarely reach that, but
    // /memberships on any real team does — and a truncated roster makes
    // `assigned_to: "<name>"` fail for everyone past the first page.
    const raw = await this.client.get<Record<string, unknown>[]>(
      LOOKUP_PATHS[kind],
      { project: projectId, page_size: 1000 },
    );
    const entries: LookupEntry[] =
      kind === "member"
        ? raw
            // A pending invitation has no user yet; such a row cannot be resolved
            // to an id, and returning null here would read as "unassign".
            .filter((row) => typeof row.user === "number")
            .map((row) => ({
              id: row.user as number,
              name: String(row.full_name ?? row.email ?? ""),
              qualifier: row.email ? String(row.email) : undefined,
              username: row.username ? String(row.username) : undefined,
              role: row.role_name ? String(row.role_name) : undefined,
            }))
        : raw.map((row) => ({ id: row.id as number, name: String(row.name) }));

    this.lookups.set(key, { at: Date.now(), entries });
    return entries;
  }

  async resolveLookup(
    projectId: number,
    kind: LookupKind,
    value: string | number,
  ): Promise<number> {
    if (typeof value === "number") return value;

    const entries = await this.entries(projectId, kind);
    const needle = value.trim().toLowerCase();
    const matches = entries.filter((entry) =>
      [entry.name, entry.username, entry.qualifier]
        .filter((key): key is string => typeof key === "string" && key.length > 0)
        .some((key) => key.toLowerCase() === needle),
    );

    if (matches.length === 1) return matches[0].id;

    // Members are looked up by name, login or email, so candidates in error
    // hints are shown as "Full Name (login)" -- the login is what the caller
    // can retype to disambiguate. Other lookup kinds keep their prior label.
    const describe = (entry: LookupEntry): string =>
      kind === "member"
        ? entry.username
          ? `${entry.name} (${entry.username})`
          : entry.name
        : entry.qualifier ?? String(entry.id);

    if (matches.length > 1) {
      const options = matches.map(describe).join(", ");
      throw new TaigaError(
        `"${value}" matches more than one ${kind} in this project.`,
        { hint: `Disambiguate using one of: ${options}` },
      );
    }

    const valid = entries
      .map((entry) => (kind === "member" ? describe(entry) : entry.name))
      .join(", ");
    throw new TaigaError(`"${value}" is not a valid ${kind} in this project.`, {
      hint: `Valid values: ${valid}`,
    });
  }

  /**
   * Reverse lookup: numeric id to display name, for fields Taiga returns as
   * bare ids with no *_extra_info companion (issue priority/severity/type,
   * wiki last_modifier). Built from the same cached entries as resolveLookup.
   */
  async labelMap(projectId: number, kind: LookupKind): Promise<Map<number, string>> {
    const entries = await this.entries(projectId, kind);
    return new Map(entries.map((entry) => [entry.id, entry.name]));
  }

  async schema(projectId: number): Promise<ProjectSchema> {
    const project = await this.client.get<{ id: number; slug: string; name: string }>(
      `/projects/${projectId}`,
    );
    this.slugById.set(projectId, project.slug);
    const kinds = Object.keys(LOOKUP_PATHS) as LookupKind[];
    const collected = await Promise.all(
      kinds.map(async (kind) => [kind, await this.entries(projectId, kind)] as const),
    );
    const resources: AttrResource[] = ["task", "userstory"];
    const customFields = await Promise.all(
      resources.map(
        async (resource) => [resource, await attributeSummaries({ client: this.client }, projectId, resource)] as const,
      ),
    );
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      lookups: Object.fromEntries(collected) as ProjectSchema["lookups"],
      customFields: Object.fromEntries(customFields) as ProjectSchema["customFields"],
    };
  }
}
