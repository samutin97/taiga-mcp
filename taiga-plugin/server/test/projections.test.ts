import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { project, projectMany } from "../src/projections.js";

/** A real Taiga user story, captured from a live 6.9.0 instance: 53 fields. */
const realStory = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/userstory.json"), "utf8"),
) as Record<string, unknown>;

const rawStory = {
  id: 501,
  ref: 3,
  subject: "Authenticate with login and password",
  version: 7,
  backlog_order: 1,
  kanban_order: 2,
  sprint_order: 3,
  epic_order: 4,
  status_extra_info: { name: "In progress", color: "#aaa" },
  assigned_to_extra_info: { full_name_display: "Ivan Petrov", id: 91 },
  milestone_name: "Sprint 1",
  total_points: 5,
  tags: [["auth", "#fff"], ["mcp", null]],
  is_blocked: false,
  is_closed: false,
  total_comments: 2,
  total_watchers: 0,
  description: "long text",
};

describe("projections", () => {
  it("keeps only the slim fields by default", () => {
    const result = project("userstory", rawStory);
    expect(result).toEqual({
      ref: 3,
      subject: "Authenticate with login and password",
      status: "In progress",
      assigned_to: "Ivan Petrov",
      assigned_users: [],
      sprint: "Sprint 1",
      points: 5,
      tags: ["auth", "mcp"],
      is_blocked: false,
      is_closed: false,
      total_comments: 2,
    });
  });

  it("returns everything in full mode", () => {
    const result = project("userstory", rawStory, "full");
    expect(result).toEqual(rawStory);
  });

  it("honours an explicit field list", () => {
    expect(project("userstory", rawStory, ["ref", "subject"])).toEqual({
      ref: 3,
      subject: "Authenticate with login and password",
    });
  });

  // An explicit field list used to read straight off the raw Taiga object, so
  // the same field name meant a name under `slim` and a bare numeric id here —
  // the very ids this plugin exists to hide, handed to the caller most likely
  // to be narrowing its projection to save context.
  it("gives an explicit field list the same values slim would, not bare ids", () => {
    const rawIssue = {
      id: 1,
      ref: 21,
      subject: "Bug in login",
      status_extra_info: { name: "Closed" },
      priority: 41,
      severity: 51,
      type: 61,
      tags: [["a", "#fff"]],
    };
    const labels = {
      priority: new Map([[41, "Normal"]]),
      severity: new Map([[51, "Important"]]),
      type: new Map([[61, "Bug"]]),
    };

    const explicit = project("issue", rawIssue, ["ref", "priority", "status"], labels);
    const slim = project("issue", rawIssue, "slim", labels);

    expect(explicit).toEqual({ ref: 21, priority: "Normal", status: "Closed" });
    expect(explicit.priority).toBe(slim.priority);
    expect(explicit.status).toBe(slim.status);
  });

  it("falls back to the raw value for a field with no slim getter", () => {
    expect(project("userstory", rawStory, ["description", "version"])).toEqual({
      description: "long text",
      version: 7,
    });
  });

  it("names an unknown field instead of silently returning null", () => {
    expect(() => project("userstory", rawStory, ["subjcet"])).toThrow(/subjcet/);
  });

  describe("explicit field lists and prototype keys", () => {
    it("rejects prototype keys as unknown fields, not as data", () => {
      for (const key of ["constructor", "hasOwnProperty", "__proto__"]) {
        expect(() => project("userstory", rawStory, [key])).toThrow(/not a field of a Taiga userstory/);
      }
    });

    it("explains when a real field is missing from this endpoint's response", () => {
      const listRow = { ...rawStory };
      delete (listRow as Record<string, unknown>).description;
      expect(() => project("userstory", listRow, ["description"])).toThrow(
        /"description" exists on a Taiga userstory but this endpoint does not return it/,
      );
      expect(() => project("userstory", listRow, ["description"])).toThrow(/taiga_userstory_get/);
    });

    it("still returns a detail-only field when the response carries it", () => {
      expect(project("userstory", rawStory, ["description"])).toEqual({
        description: rawStory.description,
      });
    });

    it("distinguishes detail-only fields per resource: task without generated_user_stories", () => {
      const rawTask = { ref: 1, subject: "Task", id: 1 };
      expect(() => project("task", rawTask, ["generated_user_stories"])).toThrow(
        /not a field of a Taiga task/,
      );
    });

    it("distinguishes detail-only fields per resource: issue with generated_user_stories as detail-only", () => {
      const rawIssue = { ref: 21, subject: "Issue", id: 1 };
      expect(() => project("issue", rawIssue, ["generated_user_stories"])).toThrow(
        /"generated_user_stories" exists on a Taiga issue but this endpoint does not return it/,
      );
      expect(() => project("issue", rawIssue, ["generated_user_stories"])).toThrow(/taiga_issue_get/);
    });
  });

  it("tolerates missing optional fields", () => {
    const result = project("userstory", { ref: 9, subject: "x" });
    expect(result.status).toBeNull();
    expect(result.assigned_to).toBeNull();
    expect(result.tags).toEqual([]);
  });

  it("shrinks a list by at least 85 percent", () => {
    const rows = Array.from({ length: 9 }, () => realStory);
    const rawSize = JSON.stringify(rows).length;
    const slimSize = JSON.stringify(projectMany("userstory", rows)).length;
    expect(slimSize).toBeLessThan(rawSize * 0.15);
  });

  it("projects a real Taiga story to the slim key set", () => {
    const result = project("userstory", realStory);
    expect(Object.keys(result).sort()).toEqual(
      [
        "assigned_to",
        "assigned_users",
        "is_blocked",
        "is_closed",
        "points",
        "ref",
        "sprint",
        "status",
        "subject",
        "tags",
        "total_comments",
      ].sort(),
    );
  });

  // Tests for labelled fields (corrections)
  it("projects issue with labelled fields when labels are provided", () => {
    const rawIssue = {
      id: 1,
      ref: 42,
      subject: "Bug in login",
      status_extra_info: { name: "New" },
      priority: 41,
      severity: 51,
      type: 61,
      assigned_to_extra_info: { full_name_display: "John Doe" },
      tags: [],
      is_closed: false,
    };

    const labels = {
      priority: new Map([[41, "High"]]),
      severity: new Map([[51, "Important"]]),
      type: new Map([[61, "Bug"]]),
    };

    const result = project("issue", rawIssue, "slim", labels);
    expect(result.priority).toBe("High");
    expect(result.severity).toBe("Important");
    expect(result.type).toBe("Bug");
  });

  it("falls back to raw id when labels are not provided", () => {
    const rawIssue = {
      id: 1,
      ref: 42,
      subject: "Bug in login",
      status_extra_info: { name: "New" },
      priority: 41,
      severity: 51,
      type: 61,
      assigned_to_extra_info: { full_name_display: "John Doe" },
      tags: [],
      is_closed: false,
    };

    const result = project("issue", rawIssue, "slim");
    expect(result.priority).toBe(41);
    expect(result.severity).toBe(51);
    expect(result.type).toBe(61);
  });

  it("projects wiki page with labelled last_modifier when labels are provided", () => {
    const rawWiki = {
      id: 1,
      slug: "home",
      modified_date: "2024-01-01T00:00:00Z",
      last_modifier: 5,
    };

    const labels = {
      member: new Map([[5, "Local Admin"]]),
    };

    const result = project("wiki", rawWiki, "slim", labels);
    expect(result.last_modifier).toBe("Local Admin");
  });

  // Correction 2 (Task 10 review): /search sends a bare numeric `status`/
  // `assigned_to` with no *_extra_info companion, so `status`/`assigned_to`
  // must fall back to the project's lookup table just like priority/severity/
  // type already do — but the normal CRUD path's *_extra_info must still win
  // when both are present, since that's the richer, already-resolved value.
  it("falls back to the status lookup table when status_extra_info is absent", () => {
    const rawStory = {
      ref: 3,
      subject: "Story without status_extra_info",
      status: 12,
      tags: [],
    };

    const result = project("userstory", rawStory, "slim", {
      status: new Map([[12, "In progress"]]),
    });
    expect(result.status).toBe("In progress");
  });

  it("prefers status_extra_info over a conflicting bare status id", () => {
    const rawStory = {
      ref: 3,
      subject: "Story with both status shapes",
      status_extra_info: { name: "Done" },
      // Deliberately conflicting: if the fallback were applied too eagerly
      // (ignoring status_extra_info), this id would win and the projected
      // status would come back as "Not started", not "Done".
      status: 99,
      tags: [],
    };

    const result = project("userstory", rawStory, "slim", {
      status: new Map([[99, "Not started"]]),
    });
    expect(result.status).toBe("Done");
  });

  it("returns null for missing priority field in issue", () => {
    const rawIssue = {
      id: 1,
      ref: 42,
      subject: "Bug in login",
      status_extra_info: { name: "New" },
      // priority is absent
      severity: 51,
      type: 61,
      assigned_to_extra_info: { full_name_display: "John Doe" },
      tags: [],
      is_closed: false,
    };

    const result = project("issue", rawIssue, "slim");
    expect(result.priority).toBeNull();
  });
});
