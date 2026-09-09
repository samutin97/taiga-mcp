import { describe, it, expect } from "vitest";
import { project, projectMany } from "../src/projections.js";

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

  it("tolerates missing optional fields", () => {
    const result = project("userstory", { ref: 9, subject: "x" });
    expect(result.status).toBeNull();
    expect(result.assigned_to).toBeNull();
    expect(result.tags).toEqual([]);
  });

  it("shrinks a list by at least 85 percent", () => {
    const rows = Array.from({ length: 9 }, () => rawStory);
    const rawSize = JSON.stringify(rows).length;
    const slimSize = JSON.stringify(projectMany("userstory", rows)).length;
    expect(slimSize).toBeLessThan(rawSize * 0.15);
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
