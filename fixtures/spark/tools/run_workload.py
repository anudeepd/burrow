#!/usr/bin/env python
"""Run one workload from fixtures/spark/workloads/<name>.py under local-mode PySpark and capture REST+HTML.

    .venv/bin/python fixtures/spark/tools/run_workload.py rdd-wordcount            # -> fixtures/spark/4.2.0/rdd-wordcount
    .venv-spark35/bin/python fixtures/spark/tools/run_workload.py rdd-wordcount    # -> fixtures/spark/3.5.9/rdd-wordcount

The Python running this script decides the Spark version (pip pyspark). JAVA_HOME defaults to .cluster/jdk17.

A workload module defines::

    MASTER   = "local[2]"           # optional
    CONF     = {"spark.x": "y"}     # optional extra Spark conf
    SNAPSHOT = {"env": True, ...}   # optional kwargs for the final Capture.snapshot()
    def run(spark, cap): ...        # drive jobs; call cap.snapshot("live", ...) for mid-flight captures
"""
from __future__ import annotations

import argparse
import sys as _sys
_sys.dont_write_bytecode = True
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SPARK_DIR = os.path.dirname(HERE)  # fixtures/spark
REPO = os.path.dirname(os.path.dirname(SPARK_DIR))
sys.path.insert(0, HERE)

from sparkcap import Capture, _now_iso  # noqa: E402

EVENTLOG_ROOT = "/tmp/burrow-spark-eventlogs"


def java_version(java_home: str) -> str:
    out = subprocess.run([os.path.join(java_home, "bin", "java"), "-version"], capture_output=True, text=True)
    return (out.stderr or out.stdout).splitlines()[0]


def load_workload(name: str):
    path = os.path.join(SPARK_DIR, "workloads", name.replace("-", "_") + ".py")
    spec = importlib.util.spec_from_file_location("workload_" + name.replace("-", "_"), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, path


def drain(spark):
    """Wait until the live listener bus has delivered everything so REST reflects the finished work."""
    try:
        spark.sparkContext._jsc.sc().listenerBus().waitUntilEmpty()
    except Exception:
        time.sleep(2)
    time.sleep(0.5)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workload")
    ap.add_argument("--port", type=int, default=4140)
    ap.add_argument("--driver-memory", default="1g")
    ap.add_argument("--out-root", default=None, help="default fixtures/spark/<sparkVersion>")
    args = ap.parse_args()

    java_home = os.environ.get("JAVA_HOME") or os.path.join(REPO, ".cluster", "jdk17")
    os.environ["JAVA_HOME"] = java_home
    os.environ["PATH"] = os.path.join(java_home, "bin") + os.pathsep + os.environ["PATH"]
    os.environ["PYSPARK_PYTHON"] = sys.executable
    os.environ["PYSPARK_DRIVER_PYTHON"] = sys.executable
    os.environ["SPARK_LOCAL_IP"] = "127.0.0.1"
    os.environ["PYSPARK_SUBMIT_ARGS"] = f"--driver-memory {args.driver_memory} pyspark-shell"
    os.environ.pop("SPARK_HOME", None)

    import pyspark
    from pyspark.sql import SparkSession

    ver = pyspark.__version__
    mod, wl_path = load_workload(args.workload)
    out_root = args.out_root or os.path.join(SPARK_DIR, ver)
    out = os.path.join(out_root, args.workload)
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    eventlog = os.path.join(EVENTLOG_ROOT, ver)
    os.makedirs(eventlog, exist_ok=True)
    localdir = f"/tmp/burrow-spark-local/{ver}/{args.workload}"
    shutil.rmtree(localdir, ignore_errors=True)
    os.makedirs(localdir)

    master = getattr(mod, "MASTER", "local[2]")
    conf = {
        "spark.app.name": f"burrow-{args.workload}",
        "spark.ui.port": str(args.port),
        "spark.ui.enabled": "true",
        "spark.driver.bindAddress": "127.0.0.1",
        "spark.driver.host": "127.0.0.1",
        "spark.eventLog.enabled": "true",
        "spark.eventLog.dir": "file://" + eventlog,
        "spark.local.dir": localdir,
        "spark.sql.shuffle.partitions": "4",
        "spark.default.parallelism": "2",
        "spark.ui.showConsoleProgress": "false",
    }
    conf.update(getattr(mod, "CONF", {}))

    b = SparkSession.builder.master(master)
    for k, v in conf.items():
        b = b.config(k, v)
    started = _now_iso()
    spark = b.getOrCreate()
    spark.sparkContext.setLogLevel("ERROR")

    meta = {
        "sparkVersion": ver,
        "javaVersion": java_version(java_home),
        "pythonVersion": sys.version.split()[0],
        "workload": args.workload,
        "workloadSource": os.path.relpath(wl_path, REPO),
        "workloadSourceSha256": hashlib.sha256(open(wl_path, "rb").read()).hexdigest()[:16],
        "master": master,
        "conf": conf,
        "uiBase": f"http://127.0.0.1:{args.port}",
        "eventLogDir": eventlog,
        "startedAt": started,
    }
    cap = Capture(out, f"http://127.0.0.1:{args.port}", meta)
    cap.discover_app()
    cap.spark_app_name = conf["spark.app.name"]
    err = None
    try:
        mod.run(spark, cap)
        drain(spark)
        cap.snapshot("final", **getattr(mod, "SNAPSHOT", {}))
    except BaseException as e:  # keep partial manifest for debugging
        err = repr(e)
        raise
    finally:
        extra = {"finishedAt": _now_iso()}
        if err:
            extra["error"] = err
        cap.write_manifest(extra)
        spark.stop()
    print(f"[{ver}] {args.workload}: {len(cap.files)} files -> {out}")


if __name__ == "__main__":
    main()
