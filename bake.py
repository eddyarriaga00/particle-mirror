#!/usr/bin/env python3
"""Snapshot a user's public GitHub repos and commits into data.json (needs the gh CLI).
Usage: python3 bake.py <github-username>"""
import json, subprocess, sys, datetime

def api(path):
    out = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else []

user = sys.argv[1]
repos = []
for r in api(f"users/{user}/repos?per_page=100&sort=pushed&type=owner"):
    if r.get("private") or r.get("fork"):
        continue
    commits = api(f"repos/{user}/{r['name']}/commits?per_page=100")
    if not isinstance(commits, list):
        commits = []
    repos.append({
        "name": r["name"], "desc": r.get("description") or "", "lang": r.get("language") or "",
        "url": r["html_url"], "created": r["created_at"], "pushed": r["pushed_at"],
        "commits": [{"sha": c["sha"][:7], "msg": c["commit"]["message"].split("\n")[0][:140],
                     "date": c["commit"]["author"]["date"], "url": c["html_url"]} for c in commits],
    })
data = {"user": user, "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "repos": repos}
json.dump(data, open("data.json", "w"), separators=(",", ":"))
print(len(repos), "repos,", sum(len(r["commits"]) for r in repos), "commits")
for r in repos: print(" ", r["name"], r["lang"], len(r["commits"]))
