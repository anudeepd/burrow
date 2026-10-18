#!/usr/bin/env python
"""keycensus — enumerate every JSON key path observed per REST endpoint across a fixture version dir.

    keycensus.py fixtures/spark/4.2.0            # writes fixtures/spark/4.2.0/rest-keys.json
    keycensus.py fixtures/spark/4.2.0 --grep scope   # which endpoints expose a key whose last segment matches

Output ``{endpoint: {keyPath: {"types": [...], "count": n, "nullable": bool}}}`` where endpoint is the request path with the
application id replaced by ``{app}`` and numeric segments by ``{n}``; array indices are dropped (``[]``), dictionaries whose
keys are dynamic (task ids, executor ids, kill reasons) use ``{key}``. This is the evidence base for the claim
"REST exposes no RDD graph": a key that is not in this file was never returned by any captured payload."""
from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict

DYNAMIC_MAPS = {"tasks", "executorSummary", "executorLogs", "killedTasksSummary", "attributes", "resources", "peakMemoryMetrics_"}


def endpoint_of(path: str) -> str:
    p = re.sub(r"/applications/[^/]+", "/applications/{app}", path)
    parts = []
    for seg in p.split("/"):
        if re.fullmatch(r"\d+", seg):
            parts.append("{n}")
        elif re.fullmatch(r"(local|application)[-_][\w-]+", seg) and seg != "{app}":
            parts.append("{app}")
        else:
            parts.append(seg)
    return "/".join(parts)


def tname(v) -> str:
    return {bool: "boolean", int: "integer", float: "number", str: "string", type(None): "null", list: "array", dict: "object"}[type(v)]


def walk(v, path, acc):
    t = tname(v)
    ent = acc.setdefault(path, {"types": set(), "count": 0})
    ent["types"].add(t)
    ent["count"] += 1
    if isinstance(v, dict):
        for k, x in v.items():
            seg = k
            if re.fullmatch(r"\d+", k) or path.rsplit(".", 1)[-1] in DYNAMIC_MAPS:
                seg = "{key}"
            walk(x, f"{path}.{seg}" if path else seg, acc)
    elif isinstance(v, list):
        for x in v:
            walk(x, f"{path}[]", acc)


def census(version_dir: str):
    per: dict[str, dict] = defaultdict(dict)
    for w in sorted(os.listdir(version_dir)):
        mf = os.path.join(version_dir, w, "MANIFEST.json")
        if not os.path.exists(mf):
            continue
        m = json.load(open(mf))
        for f in m["files"]:
            if f["kind"] != "rest" or f["status"] != 200 or not f["file"].endswith(".json"):
                continue
            q = f["request"]["query"]
            ep = endpoint_of(f["request"]["path"])
            try:
                body = json.load(open(os.path.join(version_dir, w, f["file"])))
            except ValueError:
                continue
            walk(body, "", per[ep])
    out = {}
    for ep in sorted(per):
        out[ep] = {}
        for k in sorted(per[ep]):
            e = per[ep][k]
            out[ep][k or "$"] = {"types": sorted(e["types"]), "count": e["count"], "nullable": "null" in e["types"]}
    return out


def main(argv):
    vd = argv[1]
    out = census(vd)
    if "--grep" in argv:
        pat = re.compile(argv[argv.index("--grep") + 1], re.I)
        for ep, keys in out.items():
            for k in keys:
                if pat.search(k.split(".")[-1]):
                    print(ep, k, keys[k]["types"])
        return 0
    with open(os.path.join(vd, "rest-keys.json"), "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print(len(out), "endpoints,", sum(len(v) for v in out.values()), "key paths ->", os.path.join(vd, "rest-keys.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
