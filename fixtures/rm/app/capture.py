#!/usr/bin/env python3
"""Capture REAL ResourceManager payloads for the application-detail domain into
`fixtures/rm/app/<scenario>/`.

These files are the dev-mock source of truth for the app-detail slice (web/dev/mock-app.ts) and are byte-for-byte
what the live RM served (the SPA receives them through the /api/yarn passthrough unchanged).

Usage:
    python3 fixtures/rm/app/capture.py <scenario-dir> <appId> [--rm http://127.0.0.1:8088]

Endpoints captured (relative to /ws/v1/cluster/):
    apps?deSelects=resourceRequests            -> apps.json
    apps/{id}                                  -> app.json
    apps/{id}/appattempts                      -> appattempts.json
    apps/{id}/appattempts/{at}/containers      -> containers-<at>.json
    apps/{id}/appattempts/{at}/containers/{c}  -> container-<c>.json
    apps/{id}/{state,priority,queue,timeouts,statistics,appactivities}
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


def get(url: str) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:  # RM RemoteException etc. — keep the body
        return e.code, e.read().decode("utf-8", "replace")


def save(path: Path, body: str) -> int:
    path.write_text(body if body.endswith("\n") else body + "\n")
    return len(body)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenario")
    ap.add_argument("app_id")
    ap.add_argument("--rm", default="http://127.0.0.1:8088")
    a = ap.parse_args()

    out = HERE / a.scenario
    out.mkdir(parents=True, exist_ok=True)
    base = f"{a.rm}/ws/v1/cluster"
    written: dict[str, str] = {}

    def fetch(rel: str, name: str) -> str | None:
        status, body = get(f"{base}/{rel}")
        if status != 200:
            print(f"  ! {rel} -> HTTP {status}, skipped", file=sys.stderr)
            return None
        written[rel] = name
        print(f"  {rel} -> {name} ({save(out / name, body)} bytes)")
        return body

    fetch("apps?deSelects=resourceRequests", "apps.json")
    fetch(f"apps/{a.app_id}", "app.json")
    attempts_body = fetch(f"apps/{a.app_id}/appattempts", "appattempts.json")
    for rel in ("state", "priority", "queue", "timeouts", "statistics", "appactivities"):
        fetch(f"apps/{a.app_id}/{rel}", f"{rel}.json")

    attempts: list[str] = []
    if attempts_body:
        try:
            doc = json.loads(attempts_body)
            entries = (((doc.get("appAttempts") or {}).get("appAttempt")) or [])
            entries = entries if isinstance(entries, list) else [entries]
            attempts = [e["appAttemptId"] for e in entries if e.get("appAttemptId")]
        except (ValueError, KeyError, TypeError) as e:
            print(f"  ! could not parse attempts: {e}", file=sys.stderr)

    for at in attempts:
        body = fetch(f"apps/{a.app_id}/appattempts/{at}/containers", f"containers-{at}.json")
        if not body:
            continue
        try:
            doc = json.loads(body)
            conts = doc.get("container") or []
            conts = conts if isinstance(conts, list) else [conts]
        except ValueError:
            continue
        for c in conts[:3]:
            cid = c.get("containerId")
            if cid:
                fetch(f"apps/{a.app_id}/appattempts/{at}/containers/{cid}", f"container-{at}-{cid}.json")

    manifest = out / "MANIFEST.json"
    prev = {}
    if manifest.exists():
        try:
            prev = json.loads(manifest.read_text())
        except ValueError:
            pass
    prev.update({"appId": a.app_id, "rm": a.rm, "files": written})
    manifest.write_text(json.dumps(prev, indent=2, sort_keys=True) + "\n")
    print(f"captured {len(written)} endpoints into {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
