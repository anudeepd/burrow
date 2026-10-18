#!/usr/bin/env python3
"""burrow scenario matrix — seeds every YARN/Spark state other slices need against the live cluster.

Invoked as `cluster.py scenario seed [--only a,b,c]`; `cluster.py` passes itself in as `cluster` (passing the
module keeps a single source of truth for RM URLs, submit helpers and the RAM budget).

Everything written here is *observed from the live cluster* (RM REST + NM/JHS/SHS endpoints), never invented:
`.cluster/scenarios.json` is the ground-truth index for parity fixtures, the backend and the web slice.
Every record is refreshed from the RM one last time when the seed finishes (`observed` keeps the state samples).

Scenarios (states that must exist simultaneously)
  finished_succeeded   SPARK, SUCCEEDED, wordcount with cache + shuffle
  failed_app_exception SPARK, FAILED, task exception with diagnostics
  killed_app           SPARK, KILLED via `yarn application -kill`
  mapreduce_pi         MAPREDUCE (non-Spark), SUCCEEDED — gives the JobHistory Server real content
  distributed_shell    YARN (non-Spark), SUCCEEDED — varies applicationType
  tags_priority        SPARK, tags + non-zero priority
  node_label_gpu       SPARK, AM + executors pinned to the exclusive `gpu` label
  client_mode          SPARK, --deploy-mode client (driver on the submit host, not on YARN)
  big_log              SPARK, SUCCEEDED, ~5 MiB of ApplicationMaster stdout (multi-MB container log)
  running_ingest       SPARK, RUNNING, alice @ root.etl.ingest  (long, multi-stage)
  running_transform    SPARK, RUNNING, bob   @ root.etl.transform (long, multi-stage)
  multi_attempt        SPARK, RUNNING with 2 app attempts (the attempt-1 AM container is SIGKILLed)
  accepted_pending     SPARK, ACCEPTED — root.adhoc's 5 % maximum capacity can never hold a 768 MB AM

Not seeded (documented instead, see `notes.preemption`): preemption.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import time
from pathlib import Path

APP_ID_RE = re.compile(r"application_\d+_\d+")

# --- container sizing ---------------------------------------------------------------------------------------
# The Capacity Scheduler's cluster resource here is 3072 MB *per partition* (the DEFAULT partition contains only
# 127.0.0.4 because .2 carries the exclusive `gpu` label and .3 the non-exclusive `ssd` label), so the whole
# scenario matrix has to fit in 3 GiB: small containers matter.
# spark.driver.memory/executor.memory may not go below ~466 MB (Spark 4.2: `INVALID_DRIVER_MEMORY: System memory
# N must be at least 471859200`), but 480m heap + 32m overhead = 512 MB, which rounds to exactly 512 MB at
# yarn.scheduler.increment-allocation-mb=256 — half the size of the default 768 MB container.
SMALL = ["spark.driver.memory=480m", "spark.driver.memoryOverhead=32m",
         "spark.executor.memory=480m", "spark.executor.memoryOverhead=32m"]
TINY = SMALL + ["spark.executor.instances=1"]
# long-lived apps live in the non-exclusive `ssd` partition so they do not consume the DEFAULT partition that the
# short scenarios and the self-test need
SSD = TINY + ["spark.yarn.am.nodeLabelExpression=ssd", "spark.yarn.executor.nodeLabelExpression=ssd"]

# Field names exactly as `GET /ws/v1/cluster/apps/{id}/appattempts/{att}/containers` returns them in 3.4.3:
# the payload is `{"container":[...]}` (NOT `{"containers":{"container":[...]}}`) and the exit field is
# `containerExitStatus`. `/ws/v1/cluster/containers/{id}` does not exist in 3.4.3. Per-container
# `nodeLabelExpression` is not exposed by the RM REST API either.
CONTAINER_KEYS = ("containerId", "nodeId", "nodeHttpAddress", "containerState", "containerExitStatus",
                  "allocatedMB", "allocatedVCores", "priority", "nodeLabelExpression", "logUrl", "exposedPorts")


# --------------------------------------------------------------------------------------- RM helpers


def app_snapshot(c, app_id):
    return c.app_info(app_id) or {}


def app_attempts(c, app_id):
    d = c.try_jget(f"{c.RM_WEB}/ws/v1/cluster/apps/{app_id}/appattempts")
    return ((d or {}).get("appAttempts") or {}).get("appAttempt") or []


def snapshot_containers(c, app_id):
    """The RM only reports containers while an app is live, so capture them when it matters."""
    out = []
    for at in app_attempts(c, app_id):
        d = c.try_jget(f"{c.RM_WEB}/ws/v1/cluster/apps/{app_id}/appattempts/{at['appAttemptId']}/containers")
        if not isinstance(d, dict):
            continue
        raw = d.get("containers") if isinstance(d.get("containers"), dict) else d
        items = raw.get("container")
        if isinstance(items, dict):
            items = [items]
        for ct in items or []:
            if not isinstance(ct, dict):
                continue
            rec = {k: ct.get(k) for k in CONTAINER_KEYS}
            rec["appAttemptId"] = at["appAttemptId"]
            out.append(rec)
    out.sort(key=lambda x: x["containerId"] or "")
    return out


def wait(cond, timeout, what):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = cond()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(1)
    raise TimeoutError(f"timed out waiting for {what} (last={last!r})")


def capture_containers(c, app_id, timeout=60, min_containers=1):
    """Poll the RM until at least `min_containers` containers are visible (the RM only reports live containers)."""
    deadline = time.time() + timeout
    conts = []
    while time.time() < deadline:
        conts = snapshot_containers(c, app_id)
        if len(conts) >= min_containers:
            return conts
        time.sleep(1)
    return conts


def capture_while_running(c, app_id, timeout=600):
    """Follow the app from submission to a terminal state, accumulating every container observation.

    Needed because the RM forgets containers the moment the app finishes and a short Spark job can go
    ACCEPTED -> RUNNING -> FINISHED inside one poll interval.
    """
    deadline = time.time() + timeout
    seen = {}
    a = {}
    while time.time() < deadline:
        a = app_snapshot(c, app_id)
        for ct in snapshot_containers(c, app_id):
            prev = seen.get(ct["containerId"])
            if prev is None or ct.get("containerState") == "RUNNING":
                seen[ct["containerId"]] = ct
        if a.get("state") in {"FINISHED", "FAILED", "KILLED"}:
            break
        time.sleep(1)
    else:
        raise TimeoutError(f"{app_id} did not reach a terminal state within {timeout}s (last {a.get('state')})")
    return a, sorted(seen.values(), key=lambda x: x["containerId"] or "")


def project_attempts(atts):
    return [{
        "id": at.get("appAttemptId"), "state": at.get("appAttemptState"),
        "containerId": at.get("containerId"), "nodeId": at.get("nodeId"),
        "startTime": at.get("startTime"), "finishedTime": at.get("finishedTime"),
    } for at in atts]


def wait_state(c, app_id, states, timeout, what):
    return c.wait_app(app_id, timeout, set(states))


def wait_attempt(c, app_id, attempt, timeout, state="RUNNING", polls=3):
    """Wait until the app has `attempt` attempts, the newest matches, and it is stably in `state`."""
    deadline = time.time() + timeout
    seen = 0
    last = None
    while time.time() < deadline:
        a = app_snapshot(c, app_id)
        atts = app_attempts(c, app_id)
        last = (a.get("state"), len(atts), [x.get("appAttemptState") for x in atts])
        ok = (a.get("state") == state and len(atts) >= attempt
              and (atts[-1].get("appAttemptId") or "").endswith("_%06d" % attempt))
        seen = seen + 1 if ok else 0
        if seen >= polls:
            return a
        time.sleep(2)
    raise TimeoutError(f"{app_id}: never stably reached attempt {attempt} in state {state} (last: {last})")


def pids_with_env(fragment: str) -> list[int]:
    out = []
    me = os.getpid()
    for d in Path("/proc").iterdir():
        if not d.name.isdigit() or int(d.name) == me:
            continue
        try:
            env = (d / "environ").read_bytes()
        except OSError:
            continue
        if fragment.encode() in env:
            out.append(int(d.name))
    return out


def kill_am_container(c, app_id, message="") -> dict:
    """SIGKILL the JVM of the app's newest AM container so YARN retries with the next app attempt."""
    atts = app_attempts(c, app_id)
    if not atts:
        raise RuntimeError(f"{app_id}: no app attempts in RM")
    cid = atts[-1]["containerId"]
    pids = pids_with_env(f"CONTAINER_ID={cid}")
    if not pids:
        raise RuntimeError(f"{app_id}: no process carries CONTAINER_ID={cid} (cannot kill the AM)")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    c.log(f"killed AM {cid} of {app_id} ({message}); pids={pids}")
    return {"containerId": cid, "pids": pids}


def submit(c, workload, **kw):
    res = c.submit_spark(workload, **kw)
    c.log(f"submitted {res['name']} -> {res['appId']} (user={res['user']} queue={res['queue']} mode={res['deployMode']})")
    return res


def submit_wait(c, workload, *, capture=False, timeout=600, **kw):
    """Submit, wait for a terminal state and (with capture=True) keep the containers seen while it lived."""
    kw.pop("wait", None)
    kw.pop("wait_timeout", None)
    r = submit(c, workload, wait=False, **kw)
    conts = []
    if capture:
        a, conts = capture_while_running(c, r["appId"], timeout=timeout)
        st = {"state": a.get("state"), "finalStatus": a.get("finalStatus")}
    else:
        st = c.wait_app(r["appId"], timeout)
    return r, conts, st


def _first_new_app(c, before: set, pred, timeout: float = 240) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        new = [a for a in c.apps_list() if a["id"] not in before and pred(a)]
        if new:
            new.sort(key=lambda a: a.get("startedTime") or 0)
            return new[-1]
        time.sleep(1)
    raise TimeoutError(f"no matching new app appeared in the RM within {timeout:.0f}s")


# --------------------------------------------------------------------------------------- record builder


def _urls(c, a, atts, conts):
    app_id = a.get("id")
    user = a.get("user")
    am_cont = atts[-1].get("containerId") if atts else None
    u = {
        "rmApp": f"{c.RM_WEB}/ws/v1/cluster/apps/{app_id}",
        "rmAppAttempts": f"{c.RM_WEB}/ws/v1/cluster/apps/{app_id}/appattempts",
        "rmLegacyApp": f"{c.RM_WEB}/cluster/app/{app_id}",
        "rmProxy": f"{c.RM_WEB}/proxy/{app_id}/",
        "rmProxySparkRest": f"{c.RM_WEB}/proxy/{app_id}/api/v1/applications",
        "amContainerLogs": a.get("amContainerLogs"),
        "amContainerId": am_cont,
        "amNodeId": (atts[-1].get("nodeId") if atts else None),
        "jobHistoryAggregatedLogs": {
            ct["containerId"]: f"{c.JHS_WEB}/jobhistory/logs/{ct['nodeId']}/{ct['containerId']}"
                                f"/{ct['containerId']}/{user}"
            for ct in conts if ct.get("containerId") and ct.get("nodeId")
        },
        "jobHistoryAggregatedLogsAM": (
            f"{c.JHS_WEB}/jobhistory/logs/{atts[-1].get('nodeId')}/{am_cont}/{am_cont}/{user}"
            if am_cont and atts[-1].get("nodeId") else None),
        "nmContainerLogs": {ct["containerId"]: ct.get("logUrl") for ct in conts if ct.get("containerId")},
    }
    if a.get("applicationType") == "SPARK":
        u["sparkHistoryRest"] = f"{c.SHS_WEB}/api/v1/applications/{app_id}"
        u["sparkHistoryUi"] = f"{c.SHS_WEB}/history/{app_id}/jobs/"
    return u


def record(c, name, app_id, *, kind, note=None, extra=None, containers=None):
    a = app_snapshot(c, app_id)
    atts = app_attempts(c, app_id)
    conts = containers if containers is not None else snapshot_containers(c, app_id)
    rec = {
        "name": name,
        "kind": kind,                      # spark | mapreduce | yarn
        "appId": app_id,
        "state": a.get("state"),
        "finalStatus": a.get("finalStatus"),
        "user": a.get("user"),
        "queue": a.get("queue"),
        "applicationType": a.get("applicationType"),
        "tags": a.get("applicationTags"),
        "priority": a.get("priority"),
        "attemptCount": len(atts),
        "currentAppAttemptId": a.get("currentAppAttemptId"),
        "amNodeLabelExpression": a.get("amNodeLabelExpression"),
        "amResourceRequests": a.get("amResourceRequests"),
        "startedTime": a.get("startedTime"),
        "finishedTime": a.get("finishedTime"),
        "elapsedTime": a.get("elapsedTime"),
        "allocatedMB": a.get("allocatedMB"),
        "allocatedVCores": a.get("allocatedVCores"),
        "runningContainers": a.get("runningContainers"),
        "logAggregationStatus": a.get("logAggregationStatus"),
        "diagnostics": (a.get("diagnostics") or "")[:4000],
        "trackingUrl": a.get("trackingUrl"),
        "amContainerLogs": a.get("amContainerLogs"),
        "masterNodeId": a.get("masterNodeId"),
        "nodes": sorted({ct.get("nodeId") for ct in conts if ct.get("nodeId")}),
        "attempts": project_attempts(atts),
        "containers": conts,
        "observed": [],
        "urls": _urls(c, a, atts, conts),
    }
    if note:
        rec["note"] = note
    if extra:
        rec.update(extra)
    return rec


def refresh(c, out, wait_agg=0):
    """Re-read every record from the RM so `.cluster/scenarios.json` never carries a stale state."""
    for rec in out:
        a = app_snapshot(c, rec["appId"])
        if not a:
            continue
        if wait_agg and a.get("state") in {"FINISHED", "FAILED", "KILLED"} and a.get("logAggregationStatus") != "SUCCEEDED":
            deadline = time.time() + wait_agg
            while time.time() < deadline and (a.get("logAggregationStatus") != "SUCCEEDED"):
                time.sleep(2)
                a = app_snapshot(c, rec["appId"]) or a
        atts = app_attempts(c, rec["appId"])
        conts = snapshot_containers(c, rec["appId"])
        for k in ("state", "finalStatus", "currentAppAttemptId", "amNodeLabelExpression", "finishedTime",
                  "elapsedTime", "allocatedMB", "allocatedVCores", "runningContainers", "logAggregationStatus"):
            rec[k] = a.get(k)
        rec["attemptCount"] = len(atts)
        rec["attempts"] = project_attempts(atts)
        rec["diagnostics"] = (a.get("diagnostics") or "")[:4000]
        if conts:                      # the RM forgets containers of finished apps — keep the captured set
            rec["containers"] = conts
            rec["nodes"] = sorted({ct.get("nodeId") for ct in conts if ct.get("nodeId")})
        rec["urls"] = _urls(c, a, atts or [{}], rec["containers"])
        rec.setdefault("observed", []).append({
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "state": rec["state"], "finalStatus": rec["finalStatus"],
            "attemptCount": rec["attemptCount"], "runningContainers": rec["runningContainers"],
            "logAggregationStatus": rec["logAggregationStatus"],
        })


# --------------------------------------------------------------------------------------- scenario steps


def sc_finished_succeeded(c, out):
    r, conts, st = submit_wait(c, "wordcount_rdd", capture=True, timeout=600, user="alice", queue="root.default",
                               name="burrow-finished-wc", tags="burrow,finished",
                               args=["--lines", "6000", "--vocab", "120", "--partitions", "3", "--iterations", "1"])
    if st["state"] != "FINISHED" or st["finalStatus"] != "SUCCEEDED":
        raise RuntimeError(f"finished scenario ended {st}: {(app_snapshot(c, r['appId']).get('diagnostics') or '')[:400]}")
    out.append(record(c, "finished_succeeded", r["appId"], kind="spark", containers=conts,
                      note="SUCCEEDED Spark app; shuffle + cached RDD, event log visible in the Spark History Server"))


def remote_user_metrics_state(c, user):
    """What the *legacy* RM UI would show for the anonymous remote user `user` on /cluster/cluster: the JMX
    per-user root QueueMetrics bean (QueueMetrics.getUserMetrics) and the rendered 'User Metrics for' heading."""
    import urllib.parse
    q = urllib.parse.quote("Hadoop:service=ResourceManager,name=QueueMetrics,q0=root,user=" + user, safe="=:,*")
    code, body, _ = c.http_get(f"{c.RM_WEB}/jmx?qry={q}")
    beans = json.loads(body).get("beans", []) if code == 200 else []
    code2, html, _ = c.http_get(f"{c.RM_WEB}/cluster/cluster")
    heading = f"User Metrics for {user}"
    return {"jmxUserBean": bool(beans), "appsSubmitted": beans[0].get("AppsSubmitted") if beans else None,
            "legacyHtmlHasUserMetrics": code2 == 200 and heading in html.decode("utf-8", "replace")}


def sc_remote_user_metrics(c, out):
    # The legacy /cluster/cluster page renders "User Metrics for <request.getRemoteUser()>" iff the scheduler's root
    # QueueMetrics has a per-user map (MetricsOverviewTable.java:157-160 -> UserMetricsInfo -> QueueMetrics
    # .getUserMetrics, which is null unless yarn.scheduler.capacity.user-metrics.enable=true (opt-in, BURROW_USER_METRICS=1).
    # Browsers/curl hit the RM unauthenticated under simple auth => remote user "dr.who". Giving dr.who a real app
    # makes the block carry non-zero numbers (Apps Submitted/Completed, containers) instead of an all-zero row.
    r, conts, st = submit_wait(c, "wordcount_rdd", capture=True, timeout=600, user="dr.who", queue="root.default",
                               name="burrow-drwho",
                               args=["--lines", "2000", "--vocab", "50", "--partitions", "2", "--iterations", "1"])
    if st["state"] != "FINISHED" or st["finalStatus"] != "SUCCEEDED":
        raise RuntimeError(f"remote_user_metrics scenario ended {st}: {(app_snapshot(c, r['appId']).get('diagnostics') or '')[:400]}")
    obs = remote_user_metrics_state(c, "dr.who")
    if not (obs["jmxUserBean"] and obs["legacyHtmlHasUserMetrics"]):
        raise RuntimeError(f"dr.who owns {r['appId']} but the legacy UI shows no user metrics: {obs} "
                           "(is yarn.scheduler.capacity.user-metrics.enable=true in the running RM's config?)")
    out.append(record(c, "remote_user_metrics", r["appId"], kind="spark", containers=conts,
                      extra={"facts": {"remoteUser": "dr.who", "remoteUserHasQueueMetrics": True,
                                       "legacyClusterHtmlHasUserMetrics": True, "observed": obs}},
                      note="short Spark app owned by dr.who, the anonymous remote user of every unauthenticated "
                           "request under simple auth: makes the legacy /cluster/cluster 'User Metrics for dr.who' "
                           "table (and its JMX q0=root,user=dr.who bean) exist. Requires "
                           "yarn.scheduler.capacity.user-metrics.enable=true"))


def app_local_log_marker(c, app_id, needle):
    """Search the NodeManagers' local container logs for `needle` (they survive thanks to
    yarn.nodemanager.delete.debug-delay-sec=900)."""
    hits = []
    for d in sorted((c.DATA).glob(f"nm*-logs/{app_id}/*")):
        for f in ("stderr", "stdout"):
            p = d / f
            try:
                if p.exists() and needle in p.read_text(errors="replace"):
                    hits.append(str(p))
            except OSError:
                continue
    return hits


def sc_failed_app_exception(c, out):
    r, _, st = submit_wait(c, "failing_job", timeout=600, user="carol", queue="root.etl.transform",
                           name="burrow-failed-job", attempts=1,
                           args=["--mode", "task", "--good-jobs", "1"])
    if st["finalStatus"] != "FAILED":
        raise RuntimeError(f"failed scenario ended {st}")
    a = app_snapshot(c, r["appId"])
    diag = a.get("diagnostics") or ""
    marker = "burrow deliberate failure"
    hits = [] if marker in diag else app_local_log_marker(c, r["appId"], marker)
    if marker not in diag and not hits:
        raise RuntimeError(f"no failure marker in RM diagnostics nor in the NM container logs: {diag[:300]!r}")
    out.append(record(c, "failed_app_exception", r["appId"], kind="spark",
                      note="tasks raise ValueError -> job aborted -> the AM unregisters with FAILED, so the RM "
                           "reports state=FINISHED + finalStatus=FAILED (the legacy UI's 'Failed' category is "
                           "driven by finalStatus, not by state); the Python traceback is in the AM container log",
                      extra={"failureMarkerInDiagnostics": marker in diag,
                             "failureMarkerContainerLogs": hits}))


def sc_killed_app(c, out):
    r = submit(c, "long_running", user="bob", queue="root.etl.transform", name="burrow-killed-long",
               conf=TINY, args=["--duration", "900", "--task-ms", "200"])
    wait_attempt(c, r["appId"], 1, 600)
    time.sleep(8)  # let it execute stages so the app has meaningful history
    conts = capture_containers(c, r["appId"], timeout=30)
    c.kill_app(r["appId"], user="bob")
    st = wait_state(c, r["appId"], {"KILLED", "FINISHED", "FAILED"}, 180, "terminal")
    if st["state"] != "KILLED" or st["finalStatus"] != "KILLED":
        raise RuntimeError(f"killed scenario ended {st}")
    out.append(record(c, "killed_app", r["appId"], kind="spark", containers=conts,
                      note="killed with `yarn application -kill` while RUNNING"))


def sc_mapreduce_pi(c, out):
    """Non-Spark YARN app #1: MapReduce `pi` — gives the JobHistory Server a real job."""
    jar = c.HADOOP_HOME / "share/hadoop/mapreduce/hadoop-mapreduce-examples-3.4.3.jar"
    # QUIRK: with HADOOP_USER_NAME the submitter ("alice") differs from the OS user, and JobSubmissionFiles
    # refuses to reuse an existing staging dir owned by someone else
    # ("The ownership on the staging directory ... is not as expected"). On a local FS the dir is always owned by
    # the OS user, so a *pre-existing* <staging>/<user>/.staging only ever breaks the 2nd MR job — drop it first.
    shutil.rmtree(c.DATA / "mr-staging" / "alice", ignore_errors=True)
    before = {a["id"] for a in c.apps_list()}
    r = c.run_cli(["jar", str(jar), "pi", "2", "12"], user="alice", timeout=420, tool="hadoop")
    if r.returncode:
        raise RuntimeError(f"mapreduce pi failed: {(r.stdout + r.stderr)[-800:]}")
    app_id = _first_new_app(c, before, lambda x: x.get("applicationType") == "MAPREDUCE")["id"]
    st = c.wait_app(app_id, 300)
    if st["finalStatus"] != "SUCCEEDED":
        raise RuntimeError(f"mapreduce pi app {app_id} -> {st}: {(app_snapshot(c, app_id).get('diagnostics') or '')[:400]}")
    out.append(record(c, "mapreduce_pi", app_id, kind="mapreduce",
                      note="non-Spark MapReduce job; the JobHistory Server (19888) serves its job/attempt/task REST + logs"))


def sc_distributed_shell(c, out):
    """Non-Spark YARN app #2: distributed shell — applicationType YARN."""
    jar = c.HADOOP_HOME / "share/hadoop/yarn/hadoop-yarn-applications-distributedshell-3.4.3.jar"
    before = {a["id"] for a in c.apps_list()}
    r = c.run_cli(["jar", str(jar), "org.apache.hadoop.yarn.applications.distributedshell.Client",
                   "--jar", str(jar),
                   "--num_containers", "2", "--container_memory", "256", "--container_vcores", "1",
                   "--master_memory", "512", "--shell_command", "sleep 20", "--timeout", "300000",
                   "--queue", "default", "--appname", "burrow-distributedshell",
                   "--application_tags", "burrow,distributedshell"],
                  user="carol", timeout=420, tool="yarn")
    blob = r.stdout + r.stderr
    if r.returncode:
        raise RuntimeError(f"distributed shell failed: {blob[-800:]}")
    app_id = _first_new_app(c, before, lambda x: x.get("applicationType") == "YARN")["id"]
    st = c.wait_app(app_id, 300)
    if st["finalStatus"] != "SUCCEEDED":
        raise RuntimeError(f"distributed shell {app_id} -> {st}")
    out.append(record(c, "distributed_shell", app_id, kind="yarn",
                      note="non-Spark distributed shell; Application Type = YARN, 2 containers running `sleep 20`"))


def sc_tags_priority(c, out):
    r, conts, st = submit_wait(c, "sql_join_agg", capture=True, timeout=600, user="bob", queue="root.default",
                               name="burrow-tagged", tags="burrow,parity,adhoc", priority=7,
                               conf=["spark.executor.instances=1"], args=["--rows", "60000", "--keys", "120"])
    if st["finalStatus"] != "SUCCEEDED":
        raise RuntimeError(f"tagged app -> {st}")
    out.append(record(c, "tags_priority", r["appId"], kind="spark", containers=conts,
                      note="applicationTags='burrow,parity,adhoc' + priority=7 (yarn.cluster.max-application-priority=10)"))


def sc_node_label_gpu(c, out):
    r = submit(c, "wordcount_rdd", user="alice", queue="root.default", name="burrow-label-gpu",
               label="gpu", am_label="gpu",
               args=["--lines", "3000", "--vocab", "60", "--partitions", "2", "--iterations", "0"])
    a, conts = capture_while_running(c, r["appId"], timeout=600)
    if a.get("finalStatus") != "SUCCEEDED":
        raise RuntimeError(f"gpu-label app -> {a.get('state')}/{a.get('finalStatus')}: "
                           f"{(a.get('diagnostics') or '')[:300]}")
    if len(conts) < 2:
        raise RuntimeError(f"captured only {len(conts)} containers while the gpu app was RUNNING")
    if a.get("amNodeLabelExpression") != "gpu":
        raise RuntimeError(f"amNodeLabelExpression is {a.get('amNodeLabelExpression')!r}, expected 'gpu'")
    nodes = sorted({ct["nodeId"] for ct in conts})
    if nodes != ["127.0.0.2:8041"]:
        raise RuntimeError(f"gpu app ran on {nodes}, expected only the gpu node 127.0.0.2:8041")
    out.append(record(c, "node_label_gpu", r["appId"], kind="spark", containers=conts,
                      note=f"amNodeLabelExpression=gpu (spark.yarn.am.nodeLabelExpression) and all {len(conts)} "
                           f"containers ran on {nodes} (spark.yarn.executor.nodeLabelExpression=gpu). The `gpu` "
                           f"label is exclusive, so an unlabelled container can never land there — but the RM's "
                           f"per-container REST payload does not expose nodeLabelExpression in 3.4.3, so "
                           f"placement + amNodeLabelExpression are the observable proof"))


def sc_client_mode(c, out):
    r, conts, st = submit_wait(c, "wordcount_rdd", capture=True, timeout=600, user="alice", queue="root.default",
                               name="burrow-client-mode", deploy_mode="client",
                               args=["--lines", "3000", "--vocab", "60", "--partitions", "2", "--iterations", "0"])
    if st["finalStatus"] != "SUCCEEDED":
        raise RuntimeError(f"client-mode app -> {st}: {(app_snapshot(c, r['appId']).get('diagnostics') or '')[:300]}")
    out.append(record(c, "client_mode", r["appId"], kind="spark", containers=conts,
                      note="--deploy-mode client: the driver is a local process on the submit host, only executors "
                           "are YARN containers; trackingUrl points at the local driver UI (not proxied)"))


def am_local_log_sizes(c, app_id, container_id):
    """(file, bytes, path) for the NodeManager's local copy of a container's stdout/stderr."""
    out = []
    for d in sorted((c.DATA).glob(f"nm*-logs/{app_id}/{container_id}")):
        for f in ("stdout", "stderr"):
            p = d / f
            try:
                if p.exists():
                    out.append((f, p.stat().st_size, str(p)))
            except OSError:
                continue
    return out


def sc_big_log(c, out):
    """A real Spark app whose ApplicationMaster writes ~5 MB to stdout — the multi-MB log the viewer needs."""
    mb = 5
    r = submit(c, "log_spam", user="alice", queue="root.default", name="burrow-biglog", conf=TINY,
               args=["--megabytes", str(mb), "--line-bytes", "220", "--rows", "4000"])
    a, conts = capture_while_running(c, r["appId"], timeout=600)
    if a.get("finalStatus") != "SUCCEEDED":
        raise RuntimeError(f"big_log app -> {a.get('state')}/{a.get('finalStatus')}: "
                           f"{(a.get('diagnostics') or '')[:300]}")
    atts = app_attempts(c, r["appId"])
    am = atts[-1].get("containerId") or ""
    sizes = wait(lambda: (am_local_log_sizes(c, r["appId"], am) or None), 60,
                 f"the AM container log of {r['appId']} to appear")
    am_stdout = next((n for f, n, _ in sizes if f == "stdout"), 0)
    if am_stdout < mb * 1024 * 1024:
        raise RuntimeError(f"AM stdout is only {am_stdout} bytes; expected >= {mb} MiB")
    paths = {f: p for f, _n, p in sizes}
    out.append(record(c, "big_log", r["appId"], kind="spark", containers=conts,
                      note=f"drives ~{mb} MiB through the ApplicationMaster's stdout so the log viewer has a "
                           f"multi-MB container log to page through (NM and JHS both serve it, in HTML with a "
                           f"byte range); files are purged 900 s after the app finishes",
                      extra={"amContainerId": am,
                             "amLogBytes": {f: n for f, n, _p in sizes},
                             "amLogPaths": paths,
                             "amNodeId": atts[-1].get("nodeId")}))


def sc_running_ingest(c, out):
    r = submit(c, "long_running", user="alice", queue="root.etl.ingest", name="burrow-running-ingest",
               tags="burrow,running", conf=SSD, am_label="ssd", label="ssd",
               args=["--duration", "2400", "--task-ms", "250", "--rows", "30000"])
    wait_attempt(c, r["appId"], 1, 900)
    out.append(record(c, "running_ingest", r["appId"], kind="spark",
                      note="long multi-stage app, alice @ root.etl.ingest (nested queue)"))


def sc_running_transform(c, out):
    r = submit(c, "long_running", user="bob", queue="root.etl.transform", name="burrow-running-transform",
               tags="burrow,running", conf=SSD, am_label="ssd", label="ssd",
               args=["--duration", "2400", "--task-ms", "250", "--rows", "30000"])
    wait_attempt(c, r["appId"], 1, 900)
    out.append(record(c, "running_transform", r["appId"], kind="spark",
                      note="long multi-stage app, bob @ root.etl.transform"))


def sc_multi_attempt(c, out):
    r = submit(c, "long_running", user="alice", queue="root.default", name="burrow-multi-attempt",
               attempts=3, conf=TINY,
               args=["--duration", "1800", "--task-ms", "200", "--rows", "20000"])
    wait_attempt(c, r["appId"], 1, 900)
    time.sleep(8)
    kill_am_container(c, r["appId"], message="force app attempt 2")
    wait_attempt(c, r["appId"], 2, 900)
    out.append(record(c, "multi_attempt", r["appId"], kind="spark",
                      note="the AM container of attempt 1 was SIGKILLed; YARN re-ran the app as attempt 2 "
                           "(spark.yarn.maxAppAttempts=3). Containers of attempt 1 are gone."))


def sc_accepted_pending(c, out):
    # root.adhoc.maximum-capacity is 5 % on purpose (≈153 MB of the 3072 MB DEFAULT partition, ≈460 MB even if
    # measured against the 9216 MB capability) while the smallest usable Spark AM container is 768 MB — so the app
    # is armed with the *default* 768 MB AM request and can never be given one. See QUEUES in cluster.py.
    r = submit(c, "long_running", user="carol", queue="root.adhoc", name="burrow-accepted", args=["--duration", "1800"])
    deadline = time.time() + 150
    a = None
    while time.time() < deadline:
        a = app_snapshot(c, r["appId"])
        if a.get("state") in {"RUNNING", "FINISHED", "FAILED", "KILLED"}:
            raise RuntimeError(f"accepted scenario unexpectedly became {a.get('state')}: "
                               f"{(a.get('diagnostics') or '')[:400]}")
        time.sleep(3)
        if time.time() > deadline - 100 and a.get("state") == "ACCEPTED":
            break
    if (a or {}).get("state") != "ACCEPTED":
        raise RuntimeError(f"accepted scenario is {a and a.get('state')}")
    out.append(record(c, "accepted_pending", r["appId"], kind="spark",
                      note="stays ACCEPTED forever: root.adhoc.maximum-capacity is 5 % — far too small to ever "
                           "permit a 768 MB AM container — so the app is never given an ApplicationMaster (the RM "
                           "reports ACCEPTED with no attempt container and a 'waiting for resources' diagnostic)"))


STEPS = [
    ("finished_succeeded", sc_finished_succeeded),
    ("remote_user_metrics", sc_remote_user_metrics),
    ("failed_app_exception", sc_failed_app_exception),
    ("killed_app", sc_killed_app),
    ("mapreduce_pi", sc_mapreduce_pi),
    ("distributed_shell", sc_distributed_shell),
    ("tags_priority", sc_tags_priority),
    ("node_label_gpu", sc_node_label_gpu),
    ("client_mode", sc_client_mode),
    ("big_log", sc_big_log),
    ("running_ingest", sc_running_ingest),
    ("running_transform", sc_running_transform),
    ("multi_attempt", sc_multi_attempt),
    ("accepted_pending", sc_accepted_pending),
]

# Not seeded by default: they need non-stock RM configuration (see cluster.py USER_METRICS / README §4).
OPT_IN = {"remote_user_metrics"}

PREEMPTION_NOTE = (
    "Not seeded. CapacityScheduler preemption needs (a) a leaf queue holding resources above its guaranteed "
    "capacity, (b) another leaf with a pending container, (c) the preemption monitor "
    "(yarn.resourcemanager.monitor.capacity.preemption.monitoring_interval, 3 s) to select a victim and "
    "(d) the victim to survive yarn.scheduler.capacity.preemption.max_wait_before_kill (15 s). With 3 NMs of "
    "3 GiB and 768 MB Spark AMs this is reachable, but it needs a sustained two-queue over-capacity pattern for "
    ">20 s and the observable result is just another KILLED app whose RM JSON carries preemptedResourceMB>0 — "
    "a field already exercised by killed_app. Reproduce: keep a long app RUNNING in root.etl.ingest, put a second "
    "one in root.etl.transform, then `rmadmin -refreshQueues` after setting "
    "yarn.scheduler.capacity.root.etl.ingest.capacity=90 / ...transform.capacity=10 and poll "
    "/ws/v1/cluster/apps?states=KILLED for preemptedResourceMB>0."
)


def _missing(c, recs):
    """Scenarios from a previous seed whose apps are gone (RM restarted) or in the wrong state."""
    missing = set()
    for s in recs:
        a = app_snapshot(c, s["appId"])
        if not a or a.get("state") != s["state"]:
            missing.add(s["name"])
    return missing


def seed(c, only=None):
    wanted = [x.strip() for x in only.split(",") if x.strip()] if only else [
        n for n, _ in STEPS if n not in OPT_IN or c.USER_METRICS]
    unknown = sorted(set(wanted) - {n for n, _ in STEPS})
    if unknown:
        c.die(f"unknown scenario(s) {unknown}; known: {[n for n, _ in STEPS]}")

    info = c.rm_info() or {}
    cluster_ts = info.get("startedOn")
    prev = {}
    if c.SCENARIOS.exists():
        try:
            doc = json.loads(c.SCENARIOS.read_text())
            if doc.get("clusterTimestamp") == cluster_ts:
                prev = {s["name"]: s for s in doc.get("scenarios", [])}
            else:
                c.log("scenarios.json is from an older RM instance; re-seeding")
        except Exception:  # noqa: BLE001
            prev = {}

    if prev and not only:
        missing = _missing(c, list(prev.values()))
        if not missing:
            c.log(f"all {len(prev)} scenarios still present in the RM; refreshing scenarios.json")
            out = list(prev.values())
            refresh(c, out, wait_agg=0)
            _write(c, out, cluster_ts, partial=False)
            print(json.dumps(json.loads(c.SCENARIOS.read_text()), indent=2))
            return
        c.log(f"re-seeding {sorted(missing)} (missing/stale in the RM)")

    out = [s for s in (prev.values() if prev else []) if s["name"] not in wanted]
    t0 = time.time()
    produced = []
    for name, fn in STEPS:
        if name not in wanted:
            continue
        c.log(f"--- scenario {name} ---")
        ts = time.time()
        fn(c, produced)
        c.log(f"--- scenario {name} ok in {time.time() - ts:.0f}s ---")
        _write(c, out + produced, cluster_ts, partial=True)

    final = out + produced
    c.log("refreshing every record from the RM (waits for log aggregation)")
    refresh(c, final, wait_agg=60)
    _write(c, final, cluster_ts, partial=False)
    doc = json.loads(c.SCENARIOS.read_text())
    c.log(f"seeded {len(doc['scenarios'])} scenarios in {time.time() - t0:.0f}s -> {c.SCENARIOS}")
    print(json.dumps(doc, indent=2))


def _write(c, out, cluster_ts, partial):
    info = c.rm_info() or {}
    ep = json.loads(c.ENDPOINTS.read_text()) if c.ENDPOINTS.exists() else {}
    doc = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "partial": partial,
        "clusterTimestamp": cluster_ts,
        "rmStartedOn": info.get("startedOn"),
        "scheduler": c.read_scheduler(),
        "rmWeb": c.RM_WEB,
        "sparkHistoryWeb": c.SHS_WEB,
        "jobHistoryWeb": c.JHS_WEB,
        "hadoopVersion": info.get("hadoopVersion"),
        "users": c.USERS + [c.USER],
        "queues": ep.get("queues", []),
        "nodeLabels": ep.get("nodeLabels", []),
        "scenarios": sorted(out, key=lambda s: s["name"]),
        "notes": {
            "preemption": PREEMPTION_NOTE,
            "labels": {
                "gpu": "exclusive label on 127.0.0.2 -> only containers with that label expression are placed there",
                "ssd": "non-exclusive label on 127.0.0.3 -> the node stays in the DEFAULT partition",
                "none": "127.0.0.4 has no label (always in the DEFAULT partition)",
            },
            "accepted": "root.adhoc.maximum-capacity=5 % (< 768 MB) -> the AM can never be assigned -> apps stay "
                        "ACCEPTED forever",
            "remoteUserMetrics": "OPT-IN scenario remote_user_metrics (seeded only with BURROW_USER_METRICS=1 or --only "
                                 "remote_user_metrics; needs yarn.scheduler.capacity.user-metrics.enable=true in the "
                                 "RM's capacity-scheduler.xml = RM restart). Stock config: legacy /cluster/cluster "
                                 "never renders 'User Metrics for <user>' on CapacityScheduler. When seeded it carries "
                                 "facts.remoteUserHasQueueMetrics=true (dr.who owns an app, bean q0=root,user=dr.who)",
            "logAggregation": "yarn.log-aggregation-enable=true; logs land in .cluster/state/data/app-logs and are "
                              "served by the JHS at /jobhistory/logs/<node>/<container>/<container>/<user>",
            "sparkEventLog": f"{c.DATA}/spark-events (SHS scans it every 3 s)",
            "containers": "the RM only reports containers while an app is live; records keep the set captured while "
                          "RUNNING and `observed` keeps the state samples taken while seeding",
        },
    }
    c.SCENARIOS.write_text(json.dumps(doc, indent=2) + "\n")
