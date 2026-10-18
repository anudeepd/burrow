"""Trigger one genuine Spark stage retry by removing this app's first shuffle output.

This is specific to the local single-host cluster. Pass --cluster-data-dir with the cluster's .cluster/state/data
directory. Knobs: --cluster-data-dir --user --timeout.
"""
import json
import os
import threading
import time
import urllib.request
from pathlib import Path

from pyspark import TaskContext

from _common import parser, session, summary

args = parser("stage_retry_demo", cluster_data_dir=None, user="alice", timeout=120).parse_args()
if not args.cluster_data_dir:
    raise SystemExit("--cluster-data-dir is required for this local-cluster demo")

spark = session("stage_retry_demo")
sc = spark.sparkContext
app_id = sc.applicationId
data_dir = Path(args.cluster_data_dir)
marker = Path("/tmp/burrow-stage-retry-%s.marker" % app_id)
release = Path("/tmp/burrow-stage-retry-%s.release" % app_id)
for p in (marker, release):
    p.unlink(missing_ok=True)


def reduce_side(rows):
    ctx = TaskContext.get()
    if ctx.attemptNumber() == 0 and not marker.exists():
        deadline = time.monotonic() + args.timeout
        while not release.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        if not release.exists():
            raise TimeoutError("driver did not release the first task attempt")
        marker.touch(exist_ok=True)
        raise RuntimeError("intentional first task failure after deleting shuffle output")
    yield from rows


result = {}


def run_job():
    try:
        result["value"] = (
            sc.parallelize(range(2000), 2)
            .map(lambda value: (value % 11, value))
            .reduceByKey(lambda left, right: left + right, 2)
            .mapPartitions(reduce_side)
            .map(lambda pair: (pair[0] % 2, pair[1]))
            .reduceByKey(lambda left, right: left + right, 2)
            .collect()
        )
    except BaseException as exc:
        result["error"] = repr(exc)


thread = threading.Thread(target=run_job, name="stage-retry-demo")
thread.start()
# This local cluster's RM proxy resolves the driver UI using the same route burrow uses. The node hostname in
# sc.uiWebUrl resolves to a non-loopback IPv6 address on the host, while the daemon ports bind to loopback.
stages_url = f"http://127.0.0.1:8088/proxy/{app_id}/api/v1/applications/{app_id}/stages"
deadline = time.monotonic() + args.timeout
shuffle_files = []
while time.monotonic() < deadline:
    try:
        with urllib.request.urlopen(stages_url, timeout=3) as response:
            stages = json.load(response)
    except Exception:
        stages = []
    if any(stage.get("stageId", 0) > 0 and stage.get("status") == "ACTIVE" and stage.get("numActiveTasks", 0) > 0 for stage in stages):
        block_managers = data_dir.glob(f"nm*-local/usercache/{args.user}/appcache/{app_id}/blockmgr-*")
        shuffle_files = [p for root in block_managers for p in root.glob("**/shuffle_0_*") if p.is_file()]
        if shuffle_files:
            break
    time.sleep(0.25)

if not shuffle_files:
    release.touch(exist_ok=True)
    thread.join(args.timeout)
    raise RuntimeError("did not find the active reduce stage and its shuffle output")

for path in shuffle_files:
    path.unlink(missing_ok=True)
release.touch(exist_ok=True)
thread.join(args.timeout)
if thread.is_alive():
    raise TimeoutError("stage retry job did not finish")
if "error" in result:
    raise RuntimeError(result["error"])

summary(spark, result=result["value"], deletedShuffleFiles=len(shuffle_files))
spark.stop()
