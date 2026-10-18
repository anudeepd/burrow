#!/usr/bin/env bash
# Run every workload sequentially (one JVM at a time) with the python given as $1 (default .venv/bin/python).
set -u
cd "$(dirname "$0")/../../.."
PY="${1:-.venv/bin/python}"
WORKLOADS="${WORKLOADS:-rdd-wordcount df-join-aqe window-sql sql-cache-union python-udf broadcast-join task-retries job-failed stage-retry shared-stages-multijob barrier-scopes big-dag dstream structured-streaming long-running}"
[ -n "${KEEP_EVENTLOGS:-}" ] || rm -rf "/tmp/burrow-spark-eventlogs/$($PY -c 'import pyspark;print(pyspark.__version__)')"
for w in $WORKLOADS; do
  echo "=== $w"
  "$PY" fixtures/spark/tools/run_workload.py "$w" > "/tmp/ys-run-$w.log" 2>&1 || { echo "FAILED $w (see /tmp/ys-run-$w.log)"; tail -5 "/tmp/ys-run-$w.log"; }
  tail -1 "/tmp/ys-run-$w.log"
done
