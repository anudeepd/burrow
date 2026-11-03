#!/usr/bin/env python3
"""Keep the newest GitHub Actions runs for each workflow."""

from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

API_ROOT = "https://api.github.com"
API_VERSION = "2022-11-28"
PAGE_SIZE = 100
NEXT_LINK = re.compile(r'<([^>]+)>;\s*rel="next"')


def request(url: str, token: str, method: str = "GET") -> tuple[bytes, str | None]:
    req = Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "burrow-workflow-run-cleanup",
            "X-GitHub-Api-Version": API_VERSION,
        },
        method=method,
    )
    try:
        with urlopen(req, timeout=30) as response:
            link = response.headers.get("Link", "")
            match = NEXT_LINK.search(link)
            return response.read(), match.group(1) if match else None
    except (HTTPError, URLError) as error:
        detail = error.read().decode("utf-8", errors="replace") if isinstance(error, HTTPError) else str(error)
        raise RuntimeError(f"GitHub API {method} failed for {url}: {detail}") from error


def list_runs(repo: str, token: str) -> list[dict[str, object]]:
    url = f"{API_ROOT}/repos/{quote(repo, safe='/')}/actions/runs?per_page={PAGE_SIZE}"
    runs: list[dict[str, object]] = []
    while url:
        response, url = request(url, token)
        page = json.loads(response)
        runs.extend(page.get("workflow_runs", []))
    return runs


def main() -> int:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GH_TOKEN", "")
    if not repo or not token:
        print("GITHUB_REPOSITORY and GH_TOKEN are required.", file=sys.stderr)
        return 1

    try:
        keep_runs = int(os.environ.get("KEEP_RUNS", "1"))
    except ValueError:
        print("KEEP_RUNS must be a positive integer.", file=sys.stderr)
        return 1
    if keep_runs < 1:
        print("KEEP_RUNS must be at least 1.", file=sys.stderr)
        return 1

    dry_run = os.environ.get("DRY_RUN", "false").lower() == "true"
    current_run_id = os.environ.get("GITHUB_RUN_ID", "")
    runs = list_runs(repo, token)

    by_workflow: dict[int, list[dict[str, object]]] = defaultdict(list)
    for run in runs:
        by_workflow[int(run["workflow_id"])].append(run)

    deletions: list[dict[str, object]] = []
    for workflow_id, workflow_runs in sorted(by_workflow.items()):
        workflow_runs.sort(
            key=lambda run: (str(run.get("created_at", "")), int(run["id"])),
            reverse=True,
        )
        retained = {int(run["id"]) for run in workflow_runs[:keep_runs]}
        for run in workflow_runs:
            run_id = int(run["id"])
            status = str(run.get("status", ""))
            if status != "completed" or str(run_id) == current_run_id:
                retained.add(run_id)

        workflow_name = str(workflow_runs[0].get("name") or workflow_id)
        candidates = [run for run in workflow_runs if int(run["id"]) not in retained]
        print(
            f"{workflow_name} (workflow {workflow_id}): "
            f"keeping {len(workflow_runs) - len(candidates)} of {len(workflow_runs)} runs"
        )
        for run in candidates:
            print(
                f"  {'would delete' if dry_run else 'deleting'} run {run['id']} "
                f"from {run.get('created_at')} ({run.get('head_branch')}, "
                f"{run.get('conclusion') or run.get('status')})"
            )
        deletions.extend(candidates)

    if dry_run:
        print(f"Dry run: {len(deletions)} workflow runs would be deleted.")
        return 0

    for run in deletions:
        run_id = int(run["id"])
        url = f"{API_ROOT}/repos/{quote(repo, safe='/')}/actions/runs/{run_id}"
        request(url, token, method="DELETE")
    print(f"Deleted {len(deletions)} old workflow runs.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, KeyError, TypeError, ValueError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
