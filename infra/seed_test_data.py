"""Seed the local Taiga instance with a realistic test project.

Idempotent-ish: re-running creates a project with a new slug suffix if the
default one already exists.

Usage:
    python infra/seed_test_data.py [--url http://localhost:9000] \
        [--username admin] [--password 'TaigaLocal2026!']
"""

import argparse
import sys

import requests


class Taiga:
    def __init__(self, base_url, username, password):
        self.api = base_url.rstrip("/") + "/api/v1"
        self.s = requests.Session()
        r = self.s.post(
            f"{self.api}/auth",
            json={"type": "normal", "username": username, "password": password},
            timeout=30,
        )
        r.raise_for_status()
        me = r.json()
        self.user_id = me["id"]
        self.s.headers["Authorization"] = f"Bearer {me['auth_token']}"
        print(f"  authenticated as {me['username']} (id={self.user_id})")

    def post(self, path, payload):
        r = self.s.post(f"{self.api}{path}", json=payload, timeout=30)
        if not r.ok:
            print(f"  ! POST {path} -> {r.status_code}: {r.text[:300]}", file=sys.stderr)
            r.raise_for_status()
        return r.json()

    def get(self, path, **params):
        r = self.s.get(f"{self.api}{path}", params=params, timeout=30)
        r.raise_for_status()
        return r.json()


def seed(t: Taiga, name: str, slug_hint: str):
    print("- project")
    project = t.post(
        "/projects",
        {
            "name": name,
            "description": "Sandbox project used to exercise the Taiga MCP plugin.",
            "is_backlog_activated": True,
            "is_kanban_activated": True,
            "is_issues_activated": True,
            "is_wiki_activated": True,
            "is_epics_activated": True,
            "is_private": False,
        },
    )
    pid = project["id"]
    print(f"  project id={pid} slug={project['slug']}")

    us_status = {s["name"]: s["id"] for s in t.get(f"/userstory-statuses?project={pid}")}
    task_status = {s["name"]: s["id"] for s in t.get(f"/task-statuses?project={pid}")}
    issue_status = {s["name"]: s["id"] for s in t.get(f"/issue-statuses?project={pid}")}
    priorities = {p["name"]: p["id"] for p in t.get(f"/priorities?project={pid}")}
    severities = {s["name"]: s["id"] for s in t.get(f"/severities?project={pid}")}
    types = {x["name"]: x["id"] for x in t.get(f"/issue-types?project={pid}")}
    points = {p["name"]: p["id"] for p in t.get(f"/points?project={pid}")}
    role_id = t.get(f"/roles?project={pid}")[0]["id"]

    print("- milestones")
    sprints = [
        t.post(
            "/milestones",
            {
                "project": pid,
                "name": n,
                "estimated_start": s,
                "estimated_finish": f,
            },
        )
        for n, s, f in [
            ("Sprint 1", "2026-08-24", "2026-09-06"),
            ("Sprint 2", "2026-09-07", "2026-09-20"),
        ]
    ]
    print(f"  {[s['name'] for s in sprints]}")

    print("- epics")
    epics = [
        t.post("/epics", {"project": pid, "subject": s, "color": c})
        for s, c in [("MCP integration layer", "#B22222"), ("Reporting & analytics", "#2E8B57")]
    ]

    print("- user stories")
    story_specs = [
        ("Authenticate against Taiga with login and password", sprints[0], epics[0], "Done", 5, ["auth", "mcp"]),
        ("Expose project listing as an MCP tool", sprints[0], epics[0], "Done", 3, ["mcp"]),
        ("Expose user story CRUD as MCP tools", sprints[0], epics[0], "In progress", 8, ["mcp"]),
        ("Handle token expiry transparently", sprints[0], epics[0], "In progress", 3, ["auth"]),
        ("Sprint burndown summary tool", sprints[1], epics[1], "New", 5, ["reporting"]),
        ("Backlog grooming skill", sprints[1], epics[1], "New", 8, ["skill"]),
        ("Bulk-create stories from a spec document", sprints[1], None, "New", 13, ["skill", "mcp"]),
        ("Attachment upload and download", None, None, "New", 5, ["mcp"]),
        ("Wiki page synchronisation", None, epics[1], "New", 3, ["wiki"]),
    ]
    stories = []
    for subject, sprint, epic, status, pts, tags in story_specs:
        payload = {
            "project": pid,
            "subject": subject,
            "status": us_status.get(status, list(us_status.values())[0]),
            "tags": tags,
            "description": f"Acceptance criteria for: {subject}",
        }
        if sprint:
            payload["milestone"] = sprint["id"]
        us = t.post("/userstories", payload)
        stories.append(us)
        if epic:
            t.post(f"/epics/{epic['id']}/related_userstories", {"epic": epic["id"], "user_story": us["id"]})
        pt_name = str(pts)
        if pt_name in points:
            t.s.patch(
                f"{t.api}/userstories/{us['id']}",
                json={"points": {str(role_id): points[pt_name]}, "version": us["version"]},
                timeout=30,
            )
    print(f"  {len(stories)} stories")

    print("- tasks")
    task_specs = [
        (0, "Implement POST /api/v1/auth call", "Closed"),
        (0, "Store credentials in environment variables", "Closed"),
        (2, "Design tool schema for create_user_story", "In progress"),
        (2, "Map Taiga status slugs to ids", "New"),
        (2, "Write integration tests against a local Taiga", "New"),
        (3, "Retry once on HTTP 401", "New"),
    ]
    for idx, subject, status in task_specs:
        t.post(
            "/tasks",
            {
                "project": pid,
                "user_story": stories[idx]["id"],
                "subject": subject,
                "status": task_status.get(status, list(task_status.values())[0]),
            },
        )
    print(f"  {len(task_specs)} tasks")

    print("- issues")
    issue_specs = [
        ("Token silently expires after 24h", "High", "Important", "Bug", "New"),
        ("List endpoints ignore pagination headers", "Normal", "Normal", "Bug", "In progress"),
        ("Add --verbosity flag to reduce context usage", "Low", "Minor", "Enhancement", "New"),
        ("Document self-hosted setup", "Normal", "Minor", "Question", "Closed"),
    ]
    for subject, prio, sev, typ, status in issue_specs:
        t.post(
            "/issues",
            {
                "project": pid,
                "subject": subject,
                "priority": priorities.get(prio),
                "severity": severities.get(sev),
                "type": types.get(typ),
                "status": issue_status.get(status, list(issue_status.values())[0]),
                "description": f"Reported while testing the MCP plugin: {subject}",
            },
        )
    print(f"  {len(issue_specs)} issues")

    print("- comments")
    for st, comment in [
        (stories[2], "Blocked on deciding the tool naming convention."),
        (stories[2], "Unblocked: going with taiga_<resource>_<verb>."),
        (stories[4], "Needs the milestone stats endpoint."),
    ]:
        current = t.get(f"/userstories/{st['id']}")
        t.s.patch(
            f"{t.api}/userstories/{st['id']}",
            json={"comment": comment, "version": current["version"]},
            timeout=30,
        )

    print("- wiki")
    t.post(
        "/wiki",
        {
            "project": pid,
            "slug": "home",
            "content": "# MCP sandbox\n\nThis project exists to exercise the Taiga MCP plugin.\n",
        },
    )

    return project


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:9000")
    ap.add_argument("--username", default="admin")
    ap.add_argument("--password", default="TaigaLocal2026!")
    ap.add_argument("--name", default="MCP Sandbox")
    args = ap.parse_args()

    print(f"Seeding {args.url}")
    t = Taiga(args.url, args.username, args.password)
    project = seed(t, args.name, "mcp-sandbox")
    print(f"\nDone: {args.url}/project/{project['slug']}/")


if __name__ == "__main__":
    main()
