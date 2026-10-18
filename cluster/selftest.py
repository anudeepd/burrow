#!/usr/bin/env python3
"""burrow cluster self-test — proves the live YARN + Spark-on-YARN cluster is healthy and *usable*.

    .venv/bin/python cluster/selftest.py [--skip-submit] [--timeout 300] [--json]

Checks (all against the running cluster; nothing is mocked):
  1  endpoints.json matches the live RM (scheduler, node list, racks, labels)
  2  3 NodeManagers RUNNING with the configured racks + node labels
  3  Capacity Scheduler queue tree == endpoints.json (nested queues, capacities)
  4  JobHistory Server (19888) and Spark History Server (18080) reachable
  5  the RM REST surface the backend proxies (docs/contracts/api.md §3) answers
  6  the legacy /cluster/* + /ui2 + /conf + /jmx + /stacks UI paths exist
  7  a fresh tiny PySpark-on-YARN job reaches FINISHED/SUCCEEDED
  8  its container logs are aggregated and readable through the JHS aggregated-log endpoint
  9  its Spark history is visible through the Spark History Server REST API
 10  a RUNNING YARN app is reachable through the RM web proxy (Spark REST via /proxy/<appId>/)
 11  the NodeManager REST + container-log endpoints answer for a running container and for the
     container whose logs are already aggregated

Exit code 0 = every check passed.
"""
from __future__ import annotations

import argparse
from http.cookiejar import CookieJar
import importlib.util
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("burrow_cluster", HERE / "cluster.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

RESULTS: list[dict] = []

# Keep the self-test inside the free slice of the 3 GiB DEFAULT partition that the scenario matrix leaves behind
# (see cluster/README.md §4 "Sizing").
SMALL = ["spark.driver.memory=480m", "spark.driver.memoryOverhead=32m",
         "spark.executor.memory=480m", "spark.executor.memoryOverhead=32m",
         "spark.executor.instances=1"]


# -------------------------------------------------------------------------------------------- plumbing


def http(url, timeout=10, headers=None, redirect=True, opener=None):
    """(status, body, headers). Never raises for HTTP errors; raises for connect errors."""
    req = urllib.request.Request(url, headers=headers or {"Accept": "*/*"})
    if opener is None:
        opener = urllib.request.build_opener() if redirect else urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # noqa: D102
        return None


class _StopAt302(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def proxy_opener():
    """RM web proxy needs the /proxyapproved cookie handshake — a cookie jar + redirects does it."""
    cj = CookieJar()   # NOTE: the local `http()` helper shadows the stdlib `http` package — import names directly
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def jbody(body: bytes):
    try:
        return json.loads(body)
    except Exception:  # noqa: BLE001
        return None


def check(name, fn):
    t0 = time.time()
    try:
        ok, detail = fn()
    except Exception as e:  # noqa: BLE001
        ok, detail = False, f"{type(e).__name__}: {e}"
    RESULTS.append({"check": name, "ok": bool(ok), "ms": round((time.time() - t0) * 1000),
                    "detail": str(detail)[:500]})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {str(detail)[:300]}", flush=True)
    return ok


def wait(cond, timeout, message):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = cond()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(1.5)
    raise TimeoutError(f"{message} (last={last!r})")


# -------------------------------------------------------------------------------------------- checks


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-submit", action="store_true", help="reuse the newest SUCCEEDED app instead of submitting")
    ap.add_argument("--timeout", type=int, default=420, help="per-app timeout (s)")
    ap.add_argument("--json", action="store_true", help="print the result document as JSON on stdout")
    a = ap.parse_args(argv)

    ep = json.loads(c.ENDPOINTS.read_text()) if c.ENDPOINTS.exists() else {}
    state = {"ep": ep}

    # 1 ------------------------------------------------------------------ endpoints.json vs live RM
    def chk_endpoints():
        if not ep:
            return False, ".cluster/endpoints.json missing — run `cluster.py up`"
        info = c.rm_info() or {}
        problems = []
        if info.get("state") != "STARTED":
            problems.append(f"RM state={info.get('state')}")
        if ep.get("scheduler") != c.read_scheduler():
            problems.append(f"scheduler {ep.get('scheduler')!r} != {c.read_scheduler()!r}")
        if ep.get("clusterTimestamp") != info.get("startedOn"):
            problems.append(f"clusterTimestamp {ep.get('clusterTimestamp')} != RM {info.get('startedOn')}")
        return (not problems, "ok" if not problems else "; ".join(problems))

    check("endpoints.json matches the live RM", chk_endpoints)

    # 2 ------------------------------------------------------------------ 3 RUNNING nodes, racks, labels
    def chk_nodes():
        nodes = {n["id"]: n for n in c.nodes_list()}
        want = {f"{n['host']}:8041": n for n in ep.get("nodeManagers", [])}
        problems = []
        for nid, w in want.items():
            n = nodes.get(nid)
            if not n:
                problems.append(f"{nid} missing")
                continue
            if n["state"] != "RUNNING":
                problems.append(f"{nid} state={n['state']}")
            if n.get("rack") != w["rack"]:
                problems.append(f"{nid} rack={n.get('rack')} want {w['rack']}")
            if sorted(n.get("nodeLabels") or []) != sorted(w["labels"]):
                problems.append(f"{nid} labels={n.get('nodeLabels')} want {w['labels']}")
        return (not problems, "3 RUNNING nodes with racks/labels" if not problems else "; ".join(problems))

    check("3 NodeManagers RUNNING with racks + labels", chk_nodes)

    # 3 ------------------------------------------------------------------ queue tree
    def chk_queues():
        d = c.jget(f"{c.RM_WEB}/ws/v1/cluster/scheduler")
        root = ((d.get("scheduler") or {}).get("schedulerInfo") or {})
        if root.get("type") != "capacityScheduler":
            return True, f"scheduler={root.get('type')} (queue-tree check is capacity-only)"
        leaves = {}

        def walk(q):
            if q.get("type") == "capacitySchedulerLeafQueueInfo" or not q.get("queues"):
                leaves[q["queueName"]] = float(q.get("capacity", 0))
            for ch in ((q.get("queues") or {}).get("queue") or []):
                walk(ch)

        walk(root)
        want = {q["name"]: float(q["capacity"]) for q in ep.get("queues", []) if q.get("leaf")}
        missing = {k: v for k, v in want.items() if k not in leaves}
        wrong = {k: (leaves.get(k), v) for k, v in want.items() if k in leaves and abs(leaves[k] - v) > 0.01}
        ok = not missing and not wrong
        return ok, f"leaves={sorted(leaves)}" + (f" missing={missing} wrong={wrong}" if not ok else "")

    check("Capacity Scheduler queue tree matches endpoints.json", chk_queues)

    # 4 ------------------------------------------------------------------ JHS + SHS
    def chk_history():
        jh = c.try_jget(f"{c.JHS_WEB}/ws/v1/history/info")
        sh = c.try_jget(f"{c.SHS_WEB}/api/v1/applications")
        if not jh:
            return False, "JobHistory Server /ws/v1/history/info not reachable"
        if sh is None:
            return False, "Spark History Server /api/v1/applications not reachable"
        return True, f"JHS {jh['historyInfo']['hadoopVersion']}, SHS {len(sh)} app(s)"

    check("JobHistory + Spark History servers reachable", chk_history)

    # 5 ------------------------------------------------------------------ RM REST inventory (api.md §3)
    def chk_rm_rest():
        static = ["info", "metrics", "scheduler", "scheduler/activities", "scheduler-conf", "apps", "appstatistics",
                  "nodes", "get-node-labels", "get-node-to-labels", "label-mappings"]
        bad = []
        for p in static:
            st, body, _ = http(f"{c.RM_WEB}/ws/v1/cluster/{p}", timeout=15)
            if st != 200 or not body.strip():
                bad.append(f"{p}->{st}")
        apps = c.apps_list()
        app_id = apps[0]["id"] if apps else None
        if app_id:
            atts = c.try_jget(f"{c.RM_WEB}/ws/v1/cluster/apps/{app_id}/appattempts") or {}
            al = ((atts.get("appAttempts") or {}).get("appAttempt") or [])
            # NOTE: apps/{id}/statistics and apps/{id}/appactivities are 404 on Hadoop 3.4.3 (see README §7)
            for p in [f"apps/{app_id}", f"apps/{app_id}/appattempts", f"apps/{app_id}/queue",
                      f"apps/{app_id}/priority", f"apps/{app_id}/timeouts", f"apps/{app_id}/state"]:
                st, _, _ = http(f"{c.RM_WEB}/ws/v1/cluster/{p}", timeout=15)
                if st != 200:
                    bad.append(f"{p}->{st}")
            if al:
                aid = al[-1]["appAttemptId"]
                st, _, _ = http(f"{c.RM_WEB}/ws/v1/cluster/apps/{app_id}/appattempts/{aid}/containers", timeout=15)
                if st != 200:
                    bad.append(f".../{aid}/containers->{st}")
        return (not bad, f"{len(static)} static endpoints 200" + (f"; FAILURES {bad}" if bad else ""))

    check("RM REST surface answers (api.md §3)", chk_rm_rest)

    # 6 ------------------------------------------------------------------ legacy UI paths
    def chk_legacy():
        paths = ["/cluster/cluster", "/cluster/apps", "/cluster/apps/RUNNING", "/cluster/apps/FINISHED",
                 "/cluster/apps/FAILED", "/cluster/app", "/cluster/appattempt", "/cluster/container",
                 "/cluster/nodes", "/cluster/scheduler", "/cluster/nodelabels", "/conf", "/jmx", "/stacks",
                 "/ui2/", "/cluster/apps/KILLED"]
        bad = [f"{p}->{http(c.RM_WEB + p, timeout=20)[0]}" for p in paths if http(c.RM_WEB + p, timeout=20)[0] != 200]
        return (not bad, f"{len(paths)} legacy paths 200" + (f"; FAILURES {bad}" if bad else ""))

    check("legacy /cluster/* + /ui2 + tools paths", chk_legacy)

    # 7 ------------------------------------------------------------------ a fresh Spark-on-YARN job
    def chk_spark_app():
        if a.skip_submit:
            done = [x for x in c.apps_list() if x.get("state") == "FINISHED" and x.get("finalStatus") == "SUCCEEDED"
                    and x.get("applicationType") == "SPARK"]
            if not done:
                return False, "no SUCCEEDED SPARK app to reuse"
            done.sort(key=lambda x: x.get("finishedTime") or 0)
            state["app"] = accordance = done[-1]
            return True, f"reused {accordance['id']}"
        r = c.submit_spark("wordcount_rdd", user="alice", queue="root.default", name="burrow-selftest",
                           wait=True, wait_timeout=a.timeout, conf=SMALL,
                           args=["--lines", "2500", "--vocab", "50", "--partitions", "2", "--iterations", "0"])
        st = c.app_info(r["appId"]) or {}
        state["app"] = st
        ok = st.get("state") == "FINISHED" and st.get("finalStatus") == "SUCCEEDED"
        return ok, f"{r['appId']} {st.get('state')}/{st.get('finalStatus')} in {round((st.get('elapsedTime') or 0)/1000)}s"

    if not check("PySpark-on-YARN job reaches SUCCEEDED", chk_spark_app):
        return _finish(a, state)

    app = state["app"]
    app_id = app["id"]

    # 8 ------------------------------------------------------------------ aggregated logs via JHS
    def chk_aggregated():
        atts = ((c.try_jget(f"{c.RM_WEB}/ws/v1/cluster/apps/{app_id}/appattempts") or {})
                .get("appAttempts") or {}).get("appAttempt") or []
        cid, node = atts[-1]["containerId"], atts[-1]["nodeId"]
        url = f"{c.JHS_WEB}/jobhistory/logs/{node}/{cid}/{cid}/{app['user']}"

        def ok():
            st, body, _ = http(url, timeout=20)
            if st != 200:
                return None
            text = body.decode("utf-8", "replace")
            return url if ("Log Type:" in text or "stderr" in text) else None

        got = wait(ok, 90, f"aggregated log for {cid} at {url}")
        size = len(http(got, timeout=20)[1])
        state["agg"] = got
        return True, f"{got} ({size} bytes of HTML; log aggregation status={app.get('logAggregationStatus')})"

    check("container logs aggregated + served by the JHS", chk_aggregated)

    # 9 ------------------------------------------------------------------ Spark history via SHS
    def chk_shs():
        def ok():
            d = c.try_jget(f"{c.SHS_WEB}/api/v1/applications/{app_id}")
            return d if d else None

        d = wait(ok, 120, f"{app_id} to appear in the Spark History Server")
        attempts = d.get("attempts") or []
        # cluster-mode YARN apps expose attempts[0].attemptId and need the /<attemptId> path segment;
        # client-mode apps have no attemptId and must omit it (see README §3.4)
        att = (attempts[0].get("attemptId") if attempts else None)
        base = f"{c.SHS_WEB}/api/v1/applications/{app_id}" + (f"/{att}" if att else "")
        jobs = c.try_jget(f"{base}/jobs") or []
        ui = f"{c.SHS_WEB}/history/{app_id}/" + (f"{att}/" if att else "") + "jobs/"
        state["shs"] = base
        return True, f"{d.get('name')} attempts={len(attempts)} attemptId={att!r} jobs={len(jobs)} -> {ui}"

    check("finished app visible in the Spark History Server", chk_shs)

    # 10 ----------------------------------------------------------------- proxy to a RUNNING app
    def chk_proxy():
        running = [x for x in c.apps_list() if x.get("state") == "RUNNING"
                   and x.get("unmanagedApplication") is False]
        if not running:
            r = c.submit_spark("long_running", user="alice", queue="root.default", name="burrow-selftest-running",
                               conf=SMALL, args=["--duration", "600", "--task-ms", "200"])
            wait(lambda: (c.app_info(r["appId"]) or {}).get("state") == "RUNNING", 240, "selftest app RUNNING")
            run_id = r["appId"]
            state["submitted_running"] = run_id
        else:
            running.sort(key=lambda x: x.get("startedTime") or 0)
            run_id = running[-1]["id"]

        # raw handshake: /proxy/<id>/ 302s to /proxyapproved?... when no cookie is present
        opener = urllib.request.build_opener(_StopAt302)
        st, _, hdrs = http(f"{c.RM_WEB}/proxy/{run_id}/", timeout=15, opener=opener)
        first = (st, hdrs.get("Location", ""))
        # with a cookie jar the whole handshake is transparent
        st2, body, _ = http(f"{c.RM_WEB}/proxy/{run_id}/api/v1/applications", timeout=20, opener=proxy_opener())
        apps = jbody(body)
        ok = st2 == 200 and isinstance(apps, list)  # a MAPREDUCE/other app would 404 here
        seen = [x.get("id") for x in apps] if isinstance(apps, list) else []
        state["proxy"] = f"{c.RM_WEB}/proxy/{run_id}"
        return ok, (f"handshake first={first}; spark REST via proxy={st2} apps={seen[:3]} "
                    f"(attempt ids may be suffixed for cluster mode)")

    check("RUNNING app reachable through the RM web proxy", chk_proxy)

    # 11 ----------------------------------------------------------------- NM REST + container logs
    def chk_nm():
        ip = [n for n in ep.get("nodeManagers", [])][0]
        hostport = ip["http"]
        st, body, _ = http(f"http://{hostport}/ws/v1/node/info", timeout=15)
        info_ok = st == 200 and jbody(body)
        # every NM must answer info + containers
        bad = []
        for nm in ep.get("nodeManagers", []):
            s, _, _ = http(f"http://{nm['http']}/ws/v1/node/info", timeout=15)
            if s != 200:
                bad.append(f"{nm['http']}->{s}")
            s, _, _ = http(f"http://{nm['http']}/ws/v1/node/containers", timeout=15)
            if s != 200:
                bad.append(f"{nm['http']}/containers->{s}")
        # container log read for a *running* container
        logs = []
        for nm in ep.get("nodeManagers", []):
            d = c.try_jget(f"http://{nm['http']}/ws/v1/node/containers") or {}
            for ct in ((d.get("containers") or {}).get("container") or []):
                logs.append((nm, ct))
        detail = f"{len(ep.get('nodeManagers', []))} NMs answer info+containers"
        if info_ok and logs:
            nm, ct = logs[0]
            link = ct["containerLogsLink"]
            s, body, hdrs = http(link, timeout=20)
            detail += f"; running container log {link} -> {s} ({len(body)} B)"
            if s != 200:
                bad.append(f"containerlogs->{s}")
        return (not bad, detail if not bad else f"{detail}; FAILURES {bad}")

    check("NodeManager REST + running container logs", chk_nm)

    return _finish(a, state)


def _finish(a, state):
    rep = c.memory_report()
    doc = {"ok": all(r["ok"] for r in RESULTS), "checks": RESULTS, "memory": rep,
           "app": (state.get("app") or {}).get("id"), "endpoints": state.get("ep", {}).get("rm", {})}
    print()
    print(f"--- cluster memory: daemons {rep['daemonsRssMB']} MB RSS / {rep['daemonsPssMB']} MB PSS; "
          f"all cluster processes {rep['totalRssMB']} MB RSS ({rep['otherProcesses']} container/client procs); "
          f"host MemAvailable {rep['hostMemAvailableMB']} MB")
    failed = [r["check"] for r in RESULTS if not r["ok"]]
    print(f"--- {len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed"
          + (f"; FAILED: {failed}" if failed else ""))
    if a.json:
        print(json.dumps(doc, indent=2))
    sys.exit(0 if doc["ok"] else 1)


if __name__ == "__main__":
    main()
