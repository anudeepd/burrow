#!/usr/bin/env python3
"""burrow test cluster — a REAL single-host YARN + Spark-on-YARN cluster (ground truth for parity tests).

    .venv/bin/python cluster/cluster.py setup [--scheduler capacity|fair|fifo]
    .venv/bin/python cluster/cluster.py up    [--scheduler capacity|fair|fifo] [--keep-history] [--force]
    .venv/bin/python cluster/cluster.py down  [--purge]
    .venv/bin/python cluster/cluster.py status
    .venv/bin/python cluster/cluster.py submit <workload> [--user U --queue Q ...] [--wait] [-- workload args]
    .venv/bin/python cluster/cluster.py scenario seed
    .venv/bin/python cluster/cluster.py logs <daemon> [-n N] [-f]

Python stdlib only. Every network wait and subprocess has a timeout.
"""
from __future__ import annotations

import argparse
import getpass
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CLUSTER_DIR = ROOT / ".cluster"
STATE = CLUSTER_DIR / "state"
DATA = STATE / "data"
LOGS = STATE / "logs"
PIDS = STATE / "pids.json"
ENDPOINTS = CLUSTER_DIR / "endpoints.json"
SCENARIOS = CLUSTER_DIR / "scenarios.json"
JAVA_HOME = (CLUSTER_DIR / "jdk17").resolve()
HADOOP_HOME = (CLUSTER_DIR / "hadoop").resolve()
VENV_PY = ROOT / ".venv" / "bin" / "python"
USER = getpass.getuser()

RM = "127.0.0.1"
RM_WEB = f"http://{RM}:8088"
JHS_WEB = f"http://{RM}:19888"
SHS_WEB = f"http://{RM}:18080"
NM_IPS = ["127.0.0.2", "127.0.0.3", "127.0.0.4"]
NM_RACKS = ["/rack1", "/rack1", "/rack2"]
NM_LABELS = {"127.0.0.2": ["gpu"], "127.0.0.3": ["ssd"], "127.0.0.4": []}
NODE_LABELS = [("gpu", True), ("ssd", False)]  # (name, exclusive)
USERS = ["alice", "bob", "carol"]
MIN_AVAILABLE_MB = 5000
USER_METRICS = os.environ.get("BURROW_USER_METRICS", "") not in ("", "0", "false")
HEAPS = {"RM_HEAP": 512, "NM_HEAP": 384, "JHS_HEAP": 256, "SHS_HEAP": 384}

SCHEDULER_CLASSES = {
    "capacity": "org.apache.hadoop.yarn.server.resourcemanager.scheduler.capacity.CapacityScheduler",
    "fair": "org.apache.hadoop.yarn.server.resourcemanager.scheduler.fair.FairScheduler",
    "fifo": "org.apache.hadoop.yarn.server.resourcemanager.scheduler.fifo.FifoScheduler",
}

# --- queue tree (single source of truth for Capacity + Fair configs and endpoints.json) -------------------------------
# path, capacity %, max-capacity %, max-am-resource-percent, submit ACL, admin ACL, extra props
QUEUES = [
    dict(path="root", capacity=100, maxCapacity=100, submit=" ", admin=USER),
    dict(path="root.default", capacity=30, maxCapacity=100, amPercent=0.5, submit="*", admin=USER, ordering="fifo"),
    dict(path="root.etl", capacity=65, maxCapacity=100, submit=" ", admin=f"{USER},alice"),
    dict(path="root.etl.ingest", capacity=60, maxCapacity=100, amPercent=0.5, submit="alice,bob", admin=f"{USER},alice",
         ordering="fair", priority=5),
    dict(path="root.etl.transform", capacity=40, maxCapacity=100, amPercent=0.5, submit="bob,carol", admin=f"{USER},bob"),
    # adhoc: a deliberately tiny queue (5 % => ~153 MB of the 3072 MB DEFAULT partition) so that no 768 MB Spark
    # AM container can ever be assigned here — every app submitted to it stays ACCEPTED forever, which is the
    # `accepted_pending` scenario (an ApplicationMaster that is never granted).
    dict(path="root.adhoc", capacity=5, maxCapacity=5, amPercent=0.05, submit="*", admin=USER),
]
LEAVES = [q["path"] for q in QUEUES if not any(o["path"].startswith(q["path"] + ".") for o in QUEUES)]


def log(msg: str) -> None:
    print(f"[cluster] {msg}", file=sys.stderr, flush=True)


def die(msg: str, code: int = 1):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


# --- tiny HTTP helpers -----------------------------------------------------------------------------------------------
def http_get(url: str, timeout: float = 5, headers: dict | None = None) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def jget(url: str, timeout: float = 5):
    code, body, _ = http_get(url, timeout, {"Accept": "application/json"})
    if code != 200:
        raise RuntimeError(f"GET {url} -> {code}: {body[:200]!r}")
    return json.loads(body)


def try_jget(url: str, timeout: float = 3):
    try:
        return jget(url, timeout)
    except Exception:
        return None


def wait_for(pred, timeout: float, what: str, interval: float = 1.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = pred()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(interval)
    raise TimeoutError(f"timed out after {timeout:.0f}s waiting for {what} (last: {last!r})")


# --- environment ----------------------------------------------------------------------------------------------------
def spark_home() -> Path:
    r = subprocess.run([str(VENV_PY), "-c", "import pyspark,os;print(os.path.dirname(pyspark.__file__))"],
                       capture_output=True, text=True, timeout=60)
    if r.returncode:
        die(f"pyspark missing from .venv: {r.stderr}")
    return Path(r.stdout.strip())


def mem_available_mb() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    return 0


def base_env(conf: Path | None = None) -> dict:
    sh = spark_home()
    conf = conf or (STATE / "conf")
    env = dict(os.environ)
    env.update(
        JAVA_HOME=str(JAVA_HOME), HADOOP_HOME=str(HADOOP_HOME), HADOOP_PREFIX=str(HADOOP_HOME),
        HADOOP_CONF_DIR=str(conf), YARN_CONF_DIR=str(conf), SPARK_HOME=str(sh),
        SPARK_CONF_DIR=str(STATE / "spark-conf"), BURROW_CLUSTER="1",
    )
    env["PATH"] = f"{JAVA_HOME}/bin:{HADOOP_HOME}/bin:{env.get('PATH', '')}"
    env.pop("HADOOP_USER_NAME", None)
    return env


def read_scheduler() -> str:
    f = STATE / "scheduler"
    return f.read_text().strip() if f.exists() else "capacity"


# --- config rendering -----------------------------------------------------------------------------------------------
def prop(name: str, value) -> str:
    v = str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"  <property><name>{name}</name><value>{v}</value></property>"


def render_tpl(name: str, tokens: dict) -> str:
    text = (HERE / "templates" / name).read_text()
    for k, v in tokens.items():
        text = text.replace(f"@@{k}@@", str(v))
    left = re.findall(r"@@[A-Z_]+@@", text)
    if left:
        raise RuntimeError(f"unrendered tokens in {name}: {left}")
    return text


def capacity_scheduler_xml() -> str:
    P = "yarn.scheduler.capacity."
    props = [
        (P + "maximum-applications", 10000), (P + "maximum-am-resource-percent", 0.3),
        (P + "resource-calculator", "org.apache.hadoop.yarn.util.resource.DefaultResourceCalculator"),
        (P + "node-locality-delay", 0), (P + "queue-mappings-override.enable", "false"),
        (P + "root.queues", ",".join(q["path"].split(".")[-1] for q in QUEUES if q["path"].count(".") == 1)),
        (P + "root.etl.queues", "ingest,transform"),
    ]
    if USER_METRICS:
        # OPT-IN (env BURROW_USER_METRICS=1, needs an RM restart). Stock CapacityScheduler builds root QueueMetrics with
        # users=null (QueueMetrics.forQueue(.., enableUserMetrics=false)), so no per-user beans exist and the legacy
        # /cluster/cluster never renders "User Metrics for <remote user>" (MetricsOverviewTable.java:157-160).
        # FairScheduler always has it. Keep it OFF for the stock-parity cluster.
        props.append((P + "user-metrics.enable", "true"))
    for lbl, _ in NODE_LABELS:
        props.append((P + f"root.accessible-node-labels.{lbl}.capacity", 100))
        props.append((P + f"root.accessible-node-labels.{lbl}.maximum-capacity", 100))
    for parent in {q["path"] for q in QUEUES if any(o["path"].startswith(q["path"] + ".") for o in QUEUES)} | {"root"}:
        kids = [q for q in QUEUES if q["path"] != parent and q["path"].rsplit(".", 1)[0] == parent]
        if kids:
            assert sum(k["capacity"] for k in kids) == 100, (
                f"children of {parent} must sum to 100, got {sum(k['capacity'] for k in kids)}: "
                f"{[(k['path'], k['capacity']) for k in kids]}")
    for q in QUEUES:
        qp = P + q["path"] + "."
        props += [(qp + "state", "RUNNING"), (qp + "acl_submit_applications", q["submit"]),
                  (qp + "acl_administer_queue", q["admin"])]
        if q["path"] == "root":
            continue
        # CapacityScheduler REQUIRES the capacities of a parent's children to sum to exactly 100 (0 also
        # allowed) — "Illegal capacity sum of 0.75 for children of queue root for label=." otherwise
        assert 0 <= q["capacity"] <= q["maxCapacity"], f"{q['path']}: capacity > maxCapacity"
        props += [(qp + "capacity", q["capacity"]), (qp + "maximum-capacity", q["maxCapacity"]),
                  (qp + "user-limit-factor", 3)]
        if "amPercent" in q:
            props.append((qp + "maximum-am-resource-percent", q["amPercent"]))
        if "ordering" in q:
            props.append((qp + "ordering-policy", q["ordering"]))
        if "priority" in q:
            props.append((qp + "default-application-priority", q["priority"]))
        # every queue may use every label; capacity mirrors its default-partition share
        props.append((qp + "accessible-node-labels", "*"))
        for lbl, _ in NODE_LABELS:
            props.append((qp + f"accessible-node-labels.{lbl}.capacity", q["capacity"]))
            props.append((qp + f"accessible-node-labels.{lbl}.maximum-capacity", q["maxCapacity"]))
    body = "\n".join(prop(k, v) for k, v in props)
    return f'<?xml version="1.0"?>\n<configuration>\n{body}\n</configuration>\n'


def fair_scheduler_xml() -> str:
    def acl(s: str) -> str:
        s = s.strip()
        return "*" if s == "*" else (" " if not s else s.replace(",", ",") + " ")
    return f"""<?xml version="1.0"?>
<allocations>
  <queue name="default"><weight>3</weight><schedulingPolicy>fair</schedulingPolicy><aclSubmitApps>*</aclSubmitApps><aclAdministerApps>{USER}</aclAdministerApps></queue>
  <queue name="etl">
    <weight>4</weight><schedulingPolicy>fair</schedulingPolicy><aclSubmitApps> </aclSubmitApps><aclAdministerApps>{USER},alice</aclAdministerApps>
    <queue name="ingest"><weight>6</weight><minResources>512 mb,1 vcores</minResources><schedulingPolicy>fair</schedulingPolicy><aclSubmitApps>alice,bob</aclSubmitApps><maxRunningApps>10</maxRunningApps></queue>
    <queue name="transform"><weight>4</weight><schedulingPolicy>fifo</schedulingPolicy><aclSubmitApps>bob,carol</aclSubmitApps></queue>
  </queue>
  <queue name="adhoc"><weight>3</weight><maxResources>60% memory, 60% cpu</maxResources><maxRunningApps>1</maxRunningApps><aclSubmitApps>*</aclSubmitApps></queue>
  <queuePlacementPolicy><rule name="specified" create="false"/><rule name="default"/></queuePlacementPolicy>
</allocations>
"""


def sched_props(scheduler: str, conf: Path) -> tuple[str, str]:
    """(scheduler props, label props) XML snippets for yarn-site."""
    labels = []
    if scheduler == "capacity":
        labels = [
            prop("yarn.node-labels.enabled", "true"),
            prop("yarn.node-labels.configuration-type", "centralized"),
            prop("yarn.node-labels.fs-store.root-dir", f"file://{DATA}/node-labels"),
            prop("yarn.scheduler.configuration.store.class", "memory"),  # => /ws/v1/cluster/scheduler-conf works
        ]
        sp = [prop("yarn.scheduler.capacity.queue-mappings-override.enable", "false")]
    elif scheduler == "fair":
        sp = [prop("yarn.scheduler.fair.allocation.file", f"{conf}/fair-scheduler.xml"),
              prop("yarn.scheduler.fair.user-as-default-queue", "false"),
              prop("yarn.scheduler.fair.assignmultiple", "false"),
              prop("yarn.scheduler.fair.sizebasedweight", "false")]
    else:
        sp = []
    return "\n".join(sp), "\n".join(labels)


def nm_props(i: int) -> str:
    ip = NM_IPS[i]
    n = i + 1
    return "\n".join([
        prop("yarn.nodemanager.hostname", ip),
        prop("yarn.nodemanager.address", f"{ip}:8041"),
        prop("yarn.nodemanager.localizer.address", f"{ip}:8040"),
        prop("yarn.nodemanager.webapp.address", f"{ip}:8042"),
        prop("yarn.nodemanager.local-dirs", f"{DATA}/nm{n}-local"),
        prop("yarn.nodemanager.log-dirs", f"{DATA}/nm{n}-logs"),
        prop("yarn.nodemanager.admin-env", "MALLOC_ARENA_MAX=$MALLOC_ARENA_MAX"),
        # NOTE: do NOT add SPARK_LOCAL_IP=<ip> to yarn.nodemanager.admin-env. YARN's Apps.addToEnvironment
        # APPENDS to an existing value with ':' (Apps.java), and Spark's AM propagates every SPARK_* env var
        # from its own environment to the executor containers -> executors would get
        # SPARK_LOCAL_IP="127.0.0.x:127.0.0.x" and die with
        # `UnknownHostException: 127.0.0.x:127.0.0.x: invalid IPv6 address literal` (SparkExitCode 1, then
        # "Max number of executor failures (4) reached"). Spark's own address detection is used instead.
        prop("mapreduce.shuffle.port", 13562 + i),
    ])


def spark_defaults(sh: Path) -> str:
    py = VENV_PY
    return f"""# burrow test cluster — rendered by cluster.py setup
spark.master                              yarn
spark.eventLog.enabled                    true
spark.eventLog.dir                        file://{DATA}/spark-events
spark.history.fs.logDirectory             file://{DATA}/spark-events
spark.history.fs.update.interval          3s
spark.history.ui.port                     18080
spark.yarn.historyServer.address          {RM}:18080
spark.yarn.jars                           local:{sh}/jars/*
spark.yarn.stagingDir                     file://{DATA}/staging
spark.yarn.submit.waitAppCompletion       false
spark.driver.memory                       512m
spark.driver.memoryOverhead               256m
spark.driver.cores                        1
spark.executor.memory                     512m
spark.executor.memoryOverhead             256m
spark.executor.cores                      1
spark.executor.instances                  2
spark.yarn.am.memory                      512m
spark.yarn.am.memoryOverhead              256m
spark.sql.shuffle.partitions              8
spark.default.parallelism                 4
spark.ui.showConsoleProgress              false
spark.pyspark.python                      {py}
spark.pyspark.driver.python               {py}
spark.yarn.appMasterEnv.PYSPARK_PYTHON    {py}
spark.yarn.appMasterEnv.JAVA_HOME         {JAVA_HOME}
spark.executorEnv.PYSPARK_PYTHON          {py}
spark.executorEnv.JAVA_HOME               {JAVA_HOME}
spark.executor.extraJavaOptions           -XX:+UseSerialGC
spark.driver.extraJavaOptions             -XX:+UseSerialGC
"""


def setup(scheduler: str = "capacity", wipe_data: bool = False) -> None:
    """Render all configuration from templates into .cluster/state (idempotent)."""
    if scheduler not in SCHEDULER_CLASSES:
        die(f"unknown scheduler {scheduler}")
    for p in (JAVA_HOME / "bin" / "java", HADOOP_HOME / "bin" / "yarn", VENV_PY):
        if not p.exists():
            die(f"missing prerequisite {p}")
    sh = spark_home()
    if wipe_data and DATA.exists():
        shutil.rmtree(DATA)
    for d in ["app-logs", "spark-events", "staging", "jhs/intermediate", "jhs/done", "mr-staging", "hadoop-tmp", "submit"]:
        (DATA / d).mkdir(parents=True, exist_ok=True)
    for i in range(3):
        (DATA / f"nm{i + 1}-local").mkdir(parents=True, exist_ok=True)
        (DATA / f"nm{i + 1}-logs").mkdir(parents=True, exist_ok=True)
    (DATA / "node-labels").mkdir(parents=True, exist_ok=True)
    for d in ["rm", "nm1", "nm2", "nm3", "jhs", "shs", "submit"]:
        (LOGS / d).mkdir(parents=True, exist_ok=True)
    (STATE / "scheduler").write_text(scheduler + "\n")

    confs = {"conf": None, "conf-nm1": 0, "conf-nm2": 1, "conf-nm3": 2}
    for name, nm in confs.items():
        c = STATE / name
        c.mkdir(parents=True, exist_ok=True)
        sp, lp = sched_props(scheduler, STATE / "conf")
        tok = dict(DATA=DATA, CONF=c, JAVA_HOME=JAVA_HOME, HADOOP_HOME=HADOOP_HOME, USER=USER,
                   SCHEDULER_CLASS=SCHEDULER_CLASSES[scheduler], SCHED_PROPS=sp, LABEL_PROPS=lp,
                   NM_PROPS=nm_props(nm) if nm is not None else "",
                   SHUFFLE_PORT=13562 + (nm or 0), **HEAPS)
        (c / "core-site.xml").write_text(render_tpl("core-site.xml", tok))
        (c / "yarn-site.xml").write_text(render_tpl("yarn-site.xml", tok))
        (c / "mapred-site.xml").write_text(render_tpl("mapred-site.xml", tok))
        (c / "hadoop-env.sh").write_text(render_tpl("hadoop-env.sh", tok))
        (c / "log4j.properties").write_text(render_tpl("log4j.properties", tok))
        topo = c / "topology.sh"
        topo.write_text((HERE / "templates" / "topology.sh").read_text())
        topo.chmod(0o755)
        (c / "capacity-scheduler.xml").write_text(capacity_scheduler_xml())
        (c / "fair-scheduler.xml").write_text(fair_scheduler_xml())
    # client conf for Spark / yarn CLI == conf (RM-side); fair-scheduler path points at conf/
    sc = STATE / "spark-conf"
    sc.mkdir(parents=True, exist_ok=True)
    (sc / "spark-defaults.conf").write_text(spark_defaults(sh))
    (sc / "log4j2.properties").write_text(
        "rootLogger.level = warn\nrootLogger.appenderRef.stdout.ref = console\n"
        "appender.console.type = Console\nappender.console.name = console\nappender.console.target = SYSTEM_ERR\n"
        "appender.console.layout.type = PatternLayout\nappender.console.layout.pattern = %d{yy/MM/dd HH:mm:ss} %p %c{1}: %m%n\n"
        "logger.client.name = org.apache.spark.deploy.yarn.Client\nlogger.client.level = info\n"
        "logger.yarnapp.name = org.apache.spark.deploy.yarn\nlogger.yarnapp.level = info\n")
    log(f"rendered configuration under {STATE} (scheduler={scheduler})")


# --- daemons --------------------------------------------------------------------------------------------------------
def daemon_specs() -> dict:
    sh = spark_home()
    specs = {
        "rm": dict(cmd=[str(HADOOP_HOME / "bin/yarn"), "resourcemanager"], conf="conf", logfile="resourcemanager.log"),
        "jhs": dict(cmd=[str(HADOOP_HOME / "bin/mapred"), "historyserver"], conf="conf", logfile="historyserver.log"),
    }
    for i in range(3):
        specs[f"nm{i + 1}"] = dict(cmd=[str(HADOOP_HOME / "bin/yarn"), "nodemanager"], conf=f"conf-nm{i + 1}",
                                   logfile="nodemanager.log")
    specs["shs"] = dict(cmd=[str(sh / "bin/spark-class"), "org.apache.spark.deploy.history.HistoryServer"], conf="conf",
                        logfile="history-server.log", spark=True)
    return specs


def load_pids() -> dict:
    return json.loads(PIDS.read_text()) if PIDS.exists() else {}


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:  # zombie?
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


def start_daemon(name: str, spec: dict) -> int:
    conf = STATE / spec["conf"]
    env = base_env(conf)
    logdir = LOGS / re.sub(r"\d+$", "", name) if not name.startswith("nm") else LOGS / name
    if name == "rm":
        logdir = LOGS / "rm"
    logdir.mkdir(parents=True, exist_ok=True)
    piddir = STATE / "pid" / name
    shutil.rmtree(piddir, ignore_errors=True)
    piddir.mkdir(parents=True, exist_ok=True)
    env.update(HADOOP_LOG_DIR=str(logdir), HADOOP_LOGFILE=spec["logfile"], HADOOP_ROOT_LOGGER="INFO,RFA",
               HADOOP_IDENT_STRING=USER, HADOOP_PID_DIR=str(piddir))
    if spec.get("spark"):
        env.update(SPARK_LOG_DIR=str(logdir), SPARK_DAEMON_MEMORY=f"{HEAPS['SHS_HEAP']}m", SPARK_LOCAL_IP=RM,
                   SPARK_DAEMON_JAVA_OPTS="-XX:+UseSerialGC -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=48m "
                                          f"-Dlog4j2.configurationFile=file:{STATE}/spark-conf/log4j2.properties")
    out = open(logdir / f"{name}.out", "ab")
    p = subprocess.Popen(spec["cmd"], env=env, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         start_new_session=True, cwd=str(STATE))
    return p.pid


def save_pids(pids: dict) -> None:
    PIDS.write_text(json.dumps(pids, indent=2))


def proc_info(pid: int) -> dict | None:
    try:
        rss = pss = 0
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                rss = int(line.split()[1])
        try:
            for line in Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines():
                if line.startswith("Pss:"):
                    pss = int(line.split()[1])
        except OSError:
            pass
        return {"pid": pid, "rssMB": round(rss / 1024, 1), "pssMB": round(pss / 1024, 1)}
    except OSError:
        return None


def cluster_processes() -> list[dict]:
    """All live processes belonging to this cluster: daemons, containers, submit clients, client-mode drivers."""
    me = os.getpid()
    out = []
    state_s = str(STATE)
    for d in Path("/proc").iterdir():
        if not d.name.isdigit() or int(d.name) == me:
            continue
        pid = int(d.name)
        try:
            cmd = (d / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            hit = state_s in cmd
            if not hit:
                try:
                    hit = os.readlink(d / "cwd").startswith(state_s)
                except OSError:
                    pass
            if not hit:
                try:
                    env = (d / "environ").read_bytes()
                    hit = b"BURROW_CLUSTER=1" in env
                except OSError:
                    pass
            if hit and not cmd.startswith(sys.executable) and "cluster/cluster.py" not in cmd and "selftest.py" not in cmd \
                    and "scenarios.py" not in cmd:
                st = (d / "stat").read_text().rsplit(")", 1)[1].split()[0]
                if st != "Z":
                    info = proc_info(pid) or {"pid": pid, "rssMB": 0, "pssMB": 0}
                    info["cmd"] = cmd[:200]
                    out.append(info)
        except OSError:
            continue
    return out


def kill_pids(pids: list[int], sig: int) -> None:
    for pid in pids:
        try:
            os.killpg(pid, sig) if os.getpgid(pid) == pid else os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


# --- health ---------------------------------------------------------------------------------------------------------
def rm_info():
    d = try_jget(f"{RM_WEB}/ws/v1/cluster/info")
    return (d or {}).get("clusterInfo")


def nodes_list() -> list:
    d = try_jget(f"{RM_WEB}/ws/v1/cluster/nodes")
    return ((d or {}).get("nodes") or {}).get("node") or []


def apps_list(**q) -> list:
    qs = "&".join(f"{k}={v}" for k, v in q.items())
    d = try_jget(f"{RM_WEB}/ws/v1/cluster/apps" + (f"?{qs}" if qs else ""), 10)
    return ((d or {}).get("apps") or {}).get("app") or []


def app_info(app_id: str) -> dict | None:
    d = try_jget(f"{RM_WEB}/ws/v1/cluster/apps/{app_id}", 5)
    return (d or {}).get("app")


def run_cli(args: list[str], user: str | None = None, timeout: int = 60, tool: str = "yarn") -> subprocess.CompletedProcess:
    env = base_env()
    if user:
        env["HADOOP_USER_NAME"] = user
    env["HADOOP_CLIENT_OPTS"] = "-XX:+UseSerialGC -Xmx200m " + " ".join(
        f"--add-opens=java.base/{p}=ALL-UNNAMED" for p in ["java.lang", "java.util", "java.io", "java.net", "java.nio", "sun.nio.ch"])
    return subprocess.run([str(HADOOP_HOME / "bin" / tool), *args], env=env, capture_output=True, text=True, timeout=timeout)


def setup_labels() -> None:
    spec = ",".join(f"{n}(exclusive={'true' if ex else 'false'})" for n, ex in NODE_LABELS)
    r = run_cli(["rmadmin", "-addToClusterNodeLabels", spec], user=USER)
    if r.returncode and "already" not in (r.stderr + r.stdout):
        die(f"addToClusterNodeLabels failed: {r.stderr[-500:]}")
    mapping = " ".join(f"{ip}={','.join(l)}" for ip, l in NM_LABELS.items() if l)
    r = run_cli(["rmadmin", "-replaceLabelsOnNode", mapping], user=USER)
    if r.returncode:
        die(f"replaceLabelsOnNode failed: {r.stderr[-500:]}")


def write_endpoints(scheduler: str) -> dict:
    sh = spark_home()
    info = rm_info() or {}
    nodes = {n["nodeHostName"]: n for n in nodes_list()}
    ep = {
        "hadoopVersion": info.get("hadoopVersion", "3.4.3"),
        "sparkVersion": json.loads((STATE / "spark-version.json").read_text())["version"] if (STATE / "spark-version.json").exists() else _spark_version(),
        "javaHome": str(JAVA_HOME),
        "rm": {"webapp": RM_WEB, "admin": f"{RM}:8033", "rpc": f"{RM}:8032"},
        "nodeManagers": [
            {"id": f"{ip}:8041", "webapp": f"http://{ip}:8042", "rack": NM_RACKS[i], "labels": NM_LABELS[ip],
             "host": ip, "http": f"{ip}:8042"}
            for i, ip in enumerate(NM_IPS)
        ],
        "jobHistory": {"webapp": JHS_WEB},
        "sparkHistory": {"webapp": SHS_WEB, "eventLogDir": str(DATA / "spark-events")},
        "users": USERS + [USER],
        "queues": ([{"path": q["path"], "name": q["path"].split(".")[-1], "leaf": q["path"] in LEAVES,
                     "capacity": q["capacity"], "maxCapacity": q["maxCapacity"]} for q in QUEUES]
                   if scheduler == "capacity" else
                   [{"path": p, "name": p.split(".")[-1], "leaf": True} for p in LEAVES]
                   if scheduler == "fair" else
                   [{"path": "default", "name": "default", "leaf": True}]),
        "nodeLabels": [{"name": n, "exclusive": ex} for n, ex in NODE_LABELS] if scheduler == "capacity" else [],
        "scheduler": scheduler,
        "env": {"HADOOP_CONF_DIR": str(STATE / "conf"), "YARN_CONF_DIR": str(STATE / "conf"),
                "JAVA_HOME": str(JAVA_HOME), "SPARK_HOME": str(sh), "SPARK_CONF_DIR": str(STATE / "spark-conf"),
                "HADOOP_HOME": str(HADOOP_HOME)},
        "startedAt": (STATE / "started-at").read_text().strip() if (STATE / "started-at").exists() else _now_iso(),
        "clusterTimestamp": info.get("startedOn"),
        "osUser": USER,
    }
    _ = nodes
    ENDPOINTS.write_text(json.dumps(ep, indent=2) + "\n")
    return ep


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _spark_version() -> str:
    r = subprocess.run([str(VENV_PY), "-c", "import pyspark;print(pyspark.__version__)"], capture_output=True, text=True, timeout=60)
    return r.stdout.strip()


# --- commands -------------------------------------------------------------------------------------------------------
def cmd_setup(a) -> None:
    setup(a.scheduler or read_scheduler())


def cmd_up(a) -> None:
    pids = load_pids()
    running = {k for k, v in pids.items() if alive(v)}
    if running:
        if a.scheduler and a.scheduler != read_scheduler():
            die(f"cluster already running ({sorted(running)}) with scheduler={read_scheduler()}; run `down` first")
        if len(running) == len(daemon_specs()):
            log("cluster already running; refreshing endpoints.json")
            print(json.dumps(write_endpoints(read_scheduler()), indent=2))
            return
        die(f"partially running cluster {sorted(running)}; run `down` first")
    avail = mem_available_mb()
    if avail < MIN_AVAILABLE_MB and not a.force:
        die(f"only {avail} MB RAM available (< {MIN_AVAILABLE_MB} MB needed for RM+3NM+JHS+SHS and a few Spark apps). "
            f"Free memory (or pass --force) and retry.")
    stray = cluster_processes()
    if stray:
        die(f"stray cluster processes exist (pids {[s['pid'] for s in stray][:10]}); run `down` first")
    scheduler = a.scheduler or "capacity"
    setup(scheduler, wipe_data=not a.keep_history)
    (STATE / "started-at").write_text(_now_iso())
    (STATE / "spark-version.json").write_text(json.dumps({"version": _spark_version()}))
    for p in LOGS.glob("*/*"):
        if p.is_file():
            p.unlink()
    specs = daemon_specs()
    pids = {}
    t0 = time.time()
    try:
        pids["rm"] = start_daemon("rm", specs["rm"])
        save_pids(pids)
        info = wait_for(lambda: (rm_info() or {}).get("state") == "STARTED" and rm_info(), 90, "RM STARTED")
        log(f"RM STARTED in {time.time() - t0:.0f}s ({info['resourceManagerVersion']})")
        for n in ["nm1", "nm2", "nm3", "jhs", "shs"]:
            pids[n] = start_daemon(n, specs[n])
        save_pids(pids)
        if scheduler == "capacity":
            setup_labels()
        wait_for(lambda: len([n for n in nodes_list() if n["state"] == "RUNNING"]) == 3, 120, "3 RUNNING nodes")
        wait_for(lambda: try_jget(f"{JHS_WEB}/ws/v1/history/info"), 90, "JobHistory Server")
        wait_for(lambda: try_jget(f"{SHS_WEB}/api/v1/applications") is not None, 90, "Spark History Server")
        for n, pid in pids.items():
            if not alive(pid):
                raise RuntimeError(f"daemon {n} died; see {LOGS}/{n}")
    except Exception as e:  # noqa: BLE001
        log(f"startup failed: {e}")
        cmd_down(argparse.Namespace(purge=False))
        die(str(e))
    ep = write_endpoints(scheduler)
    log(f"cluster up in {time.time() - t0:.0f}s; endpoints written to {ENDPOINTS}")
    print(json.dumps(ep, indent=2))


def cmd_down(a) -> None:
    pids = load_pids()
    live = [pid for pid in pids.values() if alive(pid)]
    # stop apps' clients/drivers first so containers are not respawned, then NMs/RM/JHS/SHS
    other = [p["pid"] for p in cluster_processes() if p["pid"] not in live]
    kill_pids(other, signal.SIGTERM)
    kill_pids(live, signal.SIGTERM)
    deadline = time.time() + 40
    while time.time() < deadline and any(alive(p) for p in live):
        time.sleep(0.5)
    kill_pids([p for p in live if alive(p)], signal.SIGKILL)
    time.sleep(1)
    for _ in range(3):  # containers / python workers orphaned by NM exit
        left = cluster_processes()
        if not left:
            break
        kill_pids([p["pid"] for p in left], signal.SIGTERM)
        time.sleep(2)
        kill_pids([p["pid"] for p in cluster_processes()], signal.SIGKILL)
        time.sleep(1)
    left = cluster_processes()
    if PIDS.exists():
        PIDS.unlink()
    if ENDPOINTS.exists():
        ENDPOINTS.unlink()
    if SCENARIOS.exists() and not left:
        SCENARIOS.unlink()
    if a.purge and STATE.exists():
        shutil.rmtree(STATE)
    if left:
        die(f"stray processes remain after down: {[(p['pid'], p['cmd'][:80]) for p in left]}")
    log("cluster down; no cluster processes remain")


def memory_report() -> dict:
    procs = cluster_processes()
    pids = load_pids()
    by_daemon = {}
    for n, pid in pids.items():
        pi = proc_info(pid) if alive(pid) else None
        by_daemon[n] = pi
    daemon_pids = set(pids.values())
    other = [p for p in procs if p["pid"] not in daemon_pids]
    return {
        "daemons": by_daemon,
        "daemonsRssMB": round(sum((v or {}).get("rssMB", 0) for v in by_daemon.values()), 1),
        "daemonsPssMB": round(sum((v or {}).get("pssMB", 0) for v in by_daemon.values()), 1),
        "otherProcesses": len(other),
        "otherRssMB": round(sum(p["rssMB"] for p in other), 1),
        "otherPssMB": round(sum(p["pssMB"] for p in other), 1),
        "totalRssMB": round(sum(p["rssMB"] for p in procs), 1),
        "totalPssMB": round(sum(p["pssMB"] for p in procs), 1),
        "hostMemAvailableMB": mem_available_mb(),
    }


def cmd_status(a) -> None:
    pids = load_pids()
    info = rm_info()
    st = {
        "scheduler": read_scheduler(),
        "daemons": {n: {"pid": pid, "alive": alive(pid)} for n, pid in pids.items()},
        "rm": {"state": (info or {}).get("state"), "haState": (info or {}).get("haState"),
               "hadoopVersion": (info or {}).get("hadoopVersion")} if info else None,
        "nodes": [{"id": n["id"], "state": n["state"], "rack": n["rack"], "labels": n.get("nodeLabels", []),
                   "usedMemoryMB": n.get("usedMemoryMB"), "availMemoryMB": n.get("availMemoryMB")} for n in nodes_list()],
        "jobHistory": bool(try_jget(f"{JHS_WEB}/ws/v1/history/info")),
        "sparkHistory": try_jget(f"{SHS_WEB}/api/v1/applications") is not None,
        "apps": {},
        "memory": memory_report(),
    }
    for app in apps_list():
        st["apps"][app["state"]] = st["apps"].get(app["state"], 0) + 1
    st["healthy"] = bool(info and info.get("state") == "STARTED" and len(st["nodes"]) == 3
                         and all(n["state"] == "RUNNING" for n in st["nodes"]) and st["jobHistory"] and st["sparkHistory"]
                         and all(v["alive"] for v in st["daemons"].values()))
    print(json.dumps(st, indent=2))
    sys.exit(0 if st["healthy"] else 1)


def cmd_logs(a) -> None:
    specs = daemon_specs()
    if a.daemon not in specs:
        die(f"unknown daemon {a.daemon}; one of {sorted(specs)}")
    d = LOGS / a.daemon
    cands = sorted(d.glob("*.log")) + sorted(d.glob("*.out"))
    if not cands:
        die(f"no logs in {d}")
    f = cands[0]
    lines = f.read_text(errors="replace").splitlines()[-a.n:]
    print("\n".join(lines))
    if a.follow:
        end = time.time() + a.timeout
        with open(f, errors="replace") as fh:
            fh.seek(0, 2)
            while time.time() < end:
                line = fh.readline()
                if line:
                    print(line, end="", flush=True)
                else:
                    time.sleep(0.3)


# --- submit ---------------------------------------------------------------------------------------------------------
APP_ID_RE = re.compile(r"application_\d+_\d+")
TERMINAL = {"FINISHED", "FAILED", "KILLED"}


def resolve_queue(q: str | None) -> str | None:
    if not q:
        return None
    sched = read_scheduler()
    if sched == "fifo":
        return "default"
    if sched == "capacity":
        # CapacityScheduler resolves queue names via CSQueueStore.getMap, which only holds the *full* path
        # ("root.etl.ingest") and the *short* leaf name ("ingest") — NOT "etl.ingest". Use the full path.
        return q if q.startswith("root.") else f"root.{q}"
    full = [p for p in LEAVES if p == q or p.endswith("." + q) or p == "root." + q]
    return full[0] if full else q


def workload_path(name: str) -> Path:
    p = HERE / "workloads" / (name if name.endswith(".py") else f"{name}.py")
    if not p.exists():
        die(f"unknown workload {name}; available: {sorted(x.stem for x in (HERE / 'workloads').glob('*.py') if not x.stem.startswith('_'))}")
    return p


def submit_spark(workload: str, *, user: str = "alice", queue: str | None = None, tags: str | None = None,
                 priority: int | None = None, deploy_mode: str = "cluster", label: str | None = None,
                 am_label: str | None = None, name: str | None = None, attempts: int | None = None,
                 conf: list[str] | None = None, args: list[str] | None = None, wait: bool = False,
                 wait_timeout: int = 600, id_timeout: int = 120) -> dict:
    wl = workload_path(workload)
    name = name or f"{wl.stem}-{int(time.time()) % 100000}"
    cmd = [str(spark_home() / "bin/spark-submit"), "--master", "yarn", "--deploy-mode", deploy_mode, "--name", name]
    q = resolve_queue(queue)
    if q:
        cmd += ["--queue", q]
    c = list(conf or [])
    if tags:
        c.append(f"spark.yarn.tags={tags}")
    if priority is not None:
        c.append(f"spark.yarn.priority={priority}")
    if attempts is not None:
        c.append(f"spark.yarn.maxAppAttempts={attempts}")
    if label:
        c.append(f"spark.yarn.executor.nodeLabelExpression={label}")
    if am_label:
        c.append(f"spark.yarn.am.nodeLabelExpression={am_label}")
    for kv in c:
        cmd += ["--conf", kv]
    cmd += ["--py-files", str(wl.parent / "_common.py"), str(wl), *(args or [])]
    env = base_env()
    env["HADOOP_USER_NAME"] = user
    if deploy_mode == "client":
        # driver runs on this host: keep it on loopback so the RM proxy and the executors can always reach it
        env["SPARK_LOCAL_IP"] = "127.0.0.1"
        env["SPARK_SUBMIT_OPTS"] = "-XX:+UseSerialGC"
        i = cmd.index(str(wl))
        cmd[i:i] = ["--conf", "spark.driver.host=127.0.0.1", "--conf", "spark.driver.bindAddress=127.0.0.1"]
    else:
        env["SPARK_DRIVER_MEMORY"] = "256m"   # heap of the spark-submit JVM itself (the driver lives in the AM container)
        env["SPARK_SUBMIT_OPTS"] = "-XX:+UseSerialGC -XX:TieredStopAtLevel=1"
    (DATA / "submit").mkdir(parents=True, exist_ok=True)
    logf = DATA / "submit" / f"{name}-{int(time.time() * 1000)}.log"
    with open(logf, "wb") as out:
        proc = subprocess.Popen(cmd, env=env, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                start_new_session=True, cwd=str(STATE))
    app_id = None
    deadline = time.time() + id_timeout
    while time.time() < deadline:
        m = APP_ID_RE.search(logf.read_text(errors="replace"))
        if m:
            app_id = m.group(0)
            break
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    if not app_id:
        tail = "\n".join(logf.read_text(errors="replace").splitlines()[-25:])
        die(f"no application id obtained from spark-submit for {name} (exit={proc.poll()}):\n{tail}")
    res = {"appId": app_id, "name": name, "user": user, "queue": queue, "deployMode": deploy_mode, "tags": tags,
           "priority": priority, "label": label, "attempts": attempts, "submitPid": proc.pid, "submitLog": str(logf),
           "workload": wl.stem, "args": args or []}
    if wait:
        res["finalState"] = wait_app(app_id, wait_timeout)
    return res


def wait_app(app_id: str, timeout: int, states: set | None = None) -> dict:
    """Wait until the app is in a terminal state (or one of `states`). Returns {state, finalStatus}."""
    states = states or TERMINAL
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        a = app_info(app_id)
        if a:
            last = a
            if a["state"] in states:
                return {"state": a["state"], "finalStatus": a["finalStatus"]}
        time.sleep(2)
    raise TimeoutError(f"{app_id} did not reach {sorted(states)} within {timeout}s (last: {last and last['state']})")


def kill_app(app_id: str, user: str = USER) -> None:
    r = run_cli(["application", "-kill", app_id], user=user, timeout=90)
    if r.returncode:
        raise RuntimeError(f"yarn application -kill {app_id} failed: {r.stderr[-300:]}")


def cmd_submit(a) -> None:
    extra = a.workload_args
    res = submit_spark(a.workload, user=a.user, queue=a.queue, tags=a.tags, priority=a.priority,
                       deploy_mode=a.deploy_mode, label=a.label, am_label=a.am_label, name=a.name, attempts=a.attempts,
                       conf=a.conf, args=extra, wait=a.wait, wait_timeout=a.timeout)
    print(json.dumps(res, indent=2))


def cmd_scenario(a) -> None:
    import scenarios  # sibling module
    if a.action == "seed":
        scenarios.seed(sys.modules[__name__], only=a.only)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="cluster.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("setup", help="render configs from templates (idempotent)")
    p.add_argument("--scheduler", choices=SCHEDULER_CLASSES)
    p.set_defaults(fn=cmd_setup)
    p = sub.add_parser("up", help="start RM + 3 NM + JHS + SHS and wait healthy")
    p.add_argument("--scheduler", choices=SCHEDULER_CLASSES)
    p.add_argument("--keep-history", action="store_true", help="do not wipe data/ (event logs, aggregated logs)")
    p.add_argument("--force", action="store_true", help="ignore the free-RAM check")
    p.set_defaults(fn=cmd_up)
    p = sub.add_parser("down", help="stop everything and verify no stray processes")
    p.add_argument("--purge", action="store_true", help="also delete .cluster/state")
    p.set_defaults(fn=cmd_down)
    p = sub.add_parser("status", help="JSON status; exit 1 if unhealthy")
    p.set_defaults(fn=cmd_status)
    p = sub.add_parser("submit", help="submit a PySpark workload to YARN")
    p.add_argument("workload")
    p.add_argument("--user", default="alice")
    p.add_argument("--queue")
    p.add_argument("--tags")
    p.add_argument("--priority", type=int)
    p.add_argument("--deploy-mode", choices=["cluster", "client"], default="cluster")
    p.add_argument("--label", help="spark.yarn.executor.nodeLabelExpression")
    p.add_argument("--am-label", help="spark.yarn.am.nodeLabelExpression")
    p.add_argument("--name")
    p.add_argument("--attempts", type=int)
    p.add_argument("--conf", action="append", default=[])
    p.add_argument("--wait", action="store_true")
    p.add_argument("--timeout", type=int, default=600)
    p.set_defaults(fn=cmd_submit)
    p = sub.add_parser("scenario", help="scenario matrix")
    p.add_argument("action", choices=["seed"])
    p.add_argument("--only", help="comma separated scenario names")
    p.set_defaults(fn=cmd_scenario)
    p = sub.add_parser("logs", help="tail a daemon log")
    p.add_argument("daemon")
    p.add_argument("-n", type=int, default=50)
    p.add_argument("-f", "--follow", action="store_true")
    p.add_argument("--timeout", type=int, default=60)
    p.set_defaults(fn=cmd_logs)
    argv = list(sys.argv[1:] if argv is None else argv)
    extra = []
    if "--" in argv:  # everything after `--` goes to the workload verbatim
        i = argv.index("--")
        argv, extra = argv[:i], argv[i + 1:]
    a = ap.parse_args(argv)
    a.workload_args = extra
    a.fn(a)


if __name__ == "__main__":
    main()
