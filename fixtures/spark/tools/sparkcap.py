"""sparkcap — capture Spark REST + UI HTML into fixtures/spark/<sparkVersion>/<workload>/.

Library used by ``run_workload.py``. Every file written is recorded in MANIFEST.json with the exact request
(path + query), HTTP status, content type, size and capture time.

Layout::

    <out>/<sparkVersion>/<workload>/
        MANIFEST.json
        rest/<phase>.<name>.json      # raw bytes of the REST response body (not re-serialised)
        html/<phase>.<name>.html      # raw bytes of the UI page
        dag-job-N.json, dag-stage-N-M.json   # golden outputs of dagparse.py (written by dagparse.py --regen)

``phase`` is ``live`` (captured while jobs were RUNNING), ``final`` (all work done, UI still up) or ``history``
(served by the Spark History Server replaying the event log).
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import io

UI_ROOT_ENV = "YS_SPARK_UI"


def pick(items: list, cap: int) -> list:
    """Keep at most ``cap`` items: the first half and the last half (streaming apps produce hundreds of jobs)."""
    if len(items) <= cap:
        return items
    h = cap // 2
    return items[:h] + items[-(cap - h):]


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds")


class Capture:
    def __init__(self, out_dir: str, base: str, meta: dict, prefix: str = ""):
        """``base`` = ``http://127.0.0.1:4140`` (no trailing slash). ``prefix`` is the UI root prefix
        (``/history/<appId>`` for the history server, ``""`` for the live UI)."""
        self.out = out_dir
        self.base = base.rstrip("/")
        self.prefix = prefix
        self.meta = dict(meta)
        self.files: list[dict] = []
        self.app_id: str | None = None
        self.attempt: str | None = None  # attempt segment for REST when the app has attemptId
        os.makedirs(os.path.join(out_dir, "rest"), exist_ok=True)
        os.makedirs(os.path.join(out_dir, "html"), exist_ok=True)

    # ---- raw http ---------------------------------------------------------------------------------------
    def get(self, path_and_query: str, timeout: float = 30.0):
        url = self.base + path_and_query
        req = urllib.request.Request(url, headers={"Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def jget(self, rest_path: str, query: str = ""):
        """Poll helper: GET /api/v1/<rest_path> and return parsed JSON (None on non-200)."""
        q = ("?" + query) if query else ""
        st, _, body = self.get("/api/v1/" + rest_path.lstrip("/") + q)
        if st != 200:
            return None
        try:
            return json.loads(body)
        except ValueError:
            return None

    # ---- discovery --------------------------------------------------------------------------------------
    def discover_app(self, timeout: float = 30.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                apps = self.jget("applications")
            except Exception:
                apps = None
            if apps:
                self.app_id = apps[0]["id"]
                atts = apps[0].get("attempts") or []
                self.attempt = atts[0].get("attemptId") if atts else None
                return self.app_id
            time.sleep(0.3)
        raise RuntimeError("no application visible at " + self.base)

    def app_path(self) -> str:
        return f"applications/{self.app_id}" + (f"/{self.attempt}" if self.attempt else "")

    # ---- recording ---------------------------------------------------------------------------------------
    def _record(self, kind, phase, name, path, query, status, ctype, body, ext):
        rel = f"{kind}/{phase}.{name}.{ext}"
        with open(os.path.join(self.out, rel), "wb") as f:
            f.write(body)
        ent = {
            "file": rel,
            "kind": kind,
            "phase": phase,
            "request": {"method": "GET", "path": path, "query": query},
            "status": status,
            "contentType": ctype,
            "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest()[:16],
            "capturedAt": _now_iso(),
        }
        self.files.append(ent)
        return ent

    def rest(self, phase: str, name: str, rest_path: str, query: str = "", app_scoped: bool = True):
        """GET {prefix}/api/v1/[applications/<id>[/<att>]/]<rest_path>?query and store the body verbatim."""
        # NB: the history server serves /api/v1 at its root (not under /history/<id>), unlike the HTML pages.
        rp = rest_path.lstrip("/")
        if app_scoped:
            p = "/api/v1/" + self.app_path() + (("/" + rp) if rp else "")
        else:
            p = "/api/v1/" + rp
        full = p + (("?" + query) if query else "")
        st, hd, body = self.get(full)
        ctype = hd.get("Content-Type", hd.get("content-type", ""))
        if "zip" in ctype or "octet" in ctype:
            names = []
            try:
                names = zipfile.ZipFile(io.BytesIO(body)).namelist()
            except Exception:
                pass
            body = json.dumps({"_binary": True, "contentType": ctype, "size": len(body), "zipEntries": names},
                              indent=2).encode()
            return self._record("rest", phase, name, p, query, st, ctype, body, "json")
        ext = "json" if "json" in ctype or body[:1] in (b"{", b"[") else "txt"
        return self._record("rest", phase, name, p, query, st, ctype, body, ext)

    def html(self, phase: str, name: str, ui_path: str, query: str = ""):
        """GET a UI page (``ui_path`` relative to the UI root, with trailing slash) and store the body verbatim."""
        p = self.prefix + "/" + ui_path.lstrip("/")
        full = p + (("?" + query) if query else "")
        st, hd, body = self.get(full)
        ctype = hd.get("Content-Type", hd.get("content-type", ""))
        return self._record("html", phase, name, p, query, st, ctype, body, "html")

    def raw(self, phase: str, name: str, path: str, query: str = ""):
        """GET an arbitrary root-relative path (no app scoping) and store it as rest/<phase>.<name>.<ext>."""
        full = path + (("?" + query) if query else "")
        st, hd, body = self.get(full)
        ctype = hd.get("Content-Type", hd.get("content-type", ""))
        ext = "json" if "json" in ctype else "txt"
        return self._record("rest", phase, name, path, query, st, ctype, body, ext)

    def read_json_file(self, rel: str):
        with open(os.path.join(self.out, rel), "rb") as f:
            return json.loads(f.read())

    # ---- the crawl ---------------------------------------------------------------------------------------
    def snapshot(self, phase: str, *, env: bool = False, details_cap: int = 8, html: bool = True,
                 sql_pages: bool = True, streaming: str | None = None, quirks: bool = False,
                 item_cap: int = 40):
        """Capture every endpoint of contract section 4 plus the UI pages that carry data REST lacks.

        ``details_cap`` limits how many stage attempts get the large ``details`` / ``withSummaries`` variants.
        ``item_cap``: max jobs / stage attempts / SQL executions that get individual REST+HTML captures.
        ``quirks``: also capture error shapes / huge-but-boring responses (thread dump, unknown ids, bad sortBy, metrics).
        ``streaming``: ``"dstream"`` → /streaming/* REST + /streaming/ pages; ``"structured"`` → /StreamingQuery/ pages.
        """
        assert self.app_id, "discover_app() first"
        R = lambda name, path, q="", **kw: self.rest(phase, name, path, q, **kw)
        H = lambda name, path, q="": self.html(phase, name, path, q) if html else None

        R("applications", "applications", app_scoped=False)
        R("application", "")  # applications/<id>[/<att>]
        R("applications.running", "applications", "status=running", app_scoped=False)
        R("applications.completed", "applications", "status=completed", app_scoped=False)
        R("applications.limit1", "applications", "limit=1", app_scoped=False)
        R("version", "version", app_scoped=False)

        # --- jobs
        R("jobs", "jobs")
        R("jobs.status-running", "jobs", "status=running")
        R("jobs.status-succeeded", "jobs", "status=succeeded")
        R("jobs.status-failed", "jobs", "status=failed")
        jobs = self.read_json_file(f"rest/{phase}.jobs.json")
        jobs_c = pick(sorted(jobs, key=lambda x: x["jobId"]), item_cap)
        for j in jobs_c:
            R(f"job-{j['jobId']}", f"jobs/{j['jobId']}")

        # --- stages
        R("stages", "stages")
        R("stages.details", "stages", "details=true")
        R("stages.withSummaries", "stages", "withSummaries=true")
        R("stages.status-failed", "stages", "status=failed")
        R("stages.status-skipped", "stages", "status=skipped")
        R("stages.status-pending", "stages", "status=pending")
        R("stages.status-active", "stages", "status=active")
        R("stages.status-complete", "stages", "status=complete")
        R("stages.details.taskStatus-failed", "stages", "details=true&taskStatus=FAILED")
        R("stages.quantiles", "stages", "withSummaries=true&quantiles=0.1,0.9")
        stages = self.read_json_file(f"rest/{phase}.stages.json")
        stages = pick(sorted(stages, key=lambda x: (x["stageId"], x["attemptId"])), item_cap)
        n_detail = 0
        for s in stages:
            sid, att = s["stageId"], s["attemptId"]
            tag = f"stage-{sid}-{att}"
            R(tag, f"stages/{sid}/{att}")
            if att == 0:
                R(f"stage-{sid}", f"stages/{sid}")
            heavy = n_detail < details_cap or s.get("numFailedTasks", 0) > 0 or s.get("status") in ("ACTIVE", "FAILED")
            if heavy:
                n_detail += 1
                R(f"{tag}.details", f"stages/{sid}/{att}", "details=true")
                R(f"{tag}.withSummaries", f"stages/{sid}/{att}", "withSummaries=true")
                R(f"{tag}.details.quantiles", f"stages/{sid}/{att}", "details=true&withSummaries=true&quantiles=0.1,0.5,0.9")
                R(f"{tag}.taskSummary", f"stages/{sid}/{att}/taskSummary")
                R(f"{tag}.taskSummary.quantiles", f"stages/{sid}/{att}/taskSummary", "quantiles=0.05,0.95")
                R(f"{tag}.taskList", f"stages/{sid}/{att}/taskList")
                R(f"{tag}.taskList.page", f"stages/{sid}/{att}/taskList", "offset=1&length=3&sortBy=-runtime")
                R(f"{tag}.taskList.sortBy-runtime", f"stages/{sid}/{att}/taskList", "length=3&sortBy=runtime")
                if quirks:
                    R(f"{tag}.taskList.sortBy-invalid", f"stages/{sid}/{att}/taskList", "length=3&sortBy=DURATION")
                if s.get("numFailedTasks", 0) > 0:
                    R(f"{tag}.taskList.status-failed", f"stages/{sid}/{att}/taskList", "status=FAILED")
                R(f"{tag}.taskList.status-success", f"stages/{sid}/{att}/taskList", "length=2&status=SUCCESS")
                if s.get("status") == "ACTIVE":
                    R(f"{tag}.taskList.status-running", f"stages/{sid}/{att}/taskList", "status=RUNNING")
            else:
                R(f"{tag}.taskSummary", f"stages/{sid}/{att}/taskSummary")
                R(f"{tag}.taskList", f"stages/{sid}/{att}/taskList")

        # --- executors / storage / env / metrics
        R("executors", "executors")
        R("allexecutors", "allexecutors")
        if quirks:
            R("executors.driver.threads", "executors/driver/threads")
            R("executors.0.threads", "executors/0/threads")
        R("storage.rdd", "storage/rdd")
        for r in self.read_json_file(f"rest/{phase}.storage.rdd.json") or []:
            R(f"storage.rdd-{r['id']}", f"storage/rdd/{r['id']}")
        if quirks:
            R("storage.rdd-9999", "storage/rdd/9999")  # unknown id → error shape
        if env:
            R("environment", "environment")
        R("logs", "logs")
        if quirks:
            R("nonexistent", "nonexistent")
            self.raw(phase, "metrics.json", "/metrics/json/")
            self.raw(phase, "metrics.prometheus", "/metrics/executors/prometheus/")
            self.raw(phase, "metrics.applicationsprometheus", "/metrics/applications/prometheus/")

        # --- SQL
        R("sql", "sql")
        R("sql.details", "sql", "details=true&planDescription=true")
        R("sql.nodetails", "sql", "details=false&planDescription=false")
        R("sql.page", "sql", "offset=1&length=2")
        sqls = self.read_json_file(f"rest/{phase}.sql.json")
        if isinstance(sqls, list):
            sqls = pick(sorted(sqls, key=lambda x: x["id"]), item_cap)
            for i, q in enumerate(sqls):
                eid = q["id"]
                R(f"sql-{eid}", f"sql/{eid}")
                if i < details_cap:
                    R(f"sql-{eid}.nodetails", f"sql/{eid}", "details=false&planDescription=false")
        if quirks:
            R("sql-9999", "sql/9999")

        # --- streaming (DStream)
        if streaming == "dstream":
            R("streaming.statistics", "streaming/statistics")
            R("streaming.receivers", "streaming/receivers")
            R("streaming.batches", "streaming/batches")
            batches = self.read_json_file(f"rest/{phase}.streaming.batches.json")
            if isinstance(batches, list) and batches:
                b = batches[-1]["batchId"]
                R(f"streaming.batch-{b}", f"streaming/batches/{b}")
                R(f"streaming.batch-{b}.operations", f"streaming/batches/{b}/operations")
                R(f"streaming.batch-{b}.operations-0", f"streaming/batches/{b}/operations/0")
            if quirks:
                R("streaming.batches.nonexistent", "streaming/batches/999999")
        elif quirks:
            R("streaming.statistics", "streaming/statistics")  # no DStream context: error shape

        if not html:
            return
        # --- HTML
        H("jobs-list", "jobs/")
        for j in jobs_c:
            H(f"job-{j['jobId']}", "jobs/job/", f"id={j['jobId']}")
        if quirks:
            H("job-9999", "jobs/job/", "id=9999")
        H("stages-list", "stages/")
        for s in stages:
            H(f"stage-{s['stageId']}-{s['attemptId']}", "stages/stage/", f"id={s['stageId']}&attempt={s['attemptId']}")
        if quirks:
            H("stage-9999-0", "stages/stage/", "id=9999&attempt=0")
            H("stages-pool", "stages/pool/", "poolname=default")
        H("storage", "storage/")
        for r in self.read_json_file(f"rest/{phase}.storage.rdd.json") or []:
            H(f"storage-rdd-{r['id']}", "storage/rdd/", f"id={r['id']}")
        if env:
            H("environment", "environment/")
        H("executors", "executors/")
        H("sql-list", "SQL/")
        if isinstance(sqls, list) and sql_pages:
            for q in sqls:
                H(f"sql-{q['id']}", "SQL/execution/", f"id={q['id']}")
        if streaming == "dstream":
            H("streaming", "streaming/")
            if isinstance(batches, list) and batches:
                H(f"streaming-batch-{batches[-1]['batchId']}", "streaming/batch/", f"id={batches[-1]['batchId']}")
        if streaming == "structured":
            H("streamingquery", "StreamingQuery/")

    def write_manifest(self, extra: dict | None = None):
        m = dict(self.meta)
        m["appId"] = self.app_id
        m["attempt"] = self.attempt
        m["files"] = self.files
        if extra:
            m.update(extra)
        with open(os.path.join(self.out, "MANIFEST.json"), "w") as f:
            json.dump(m, f, indent=2)
            f.write("\n")
