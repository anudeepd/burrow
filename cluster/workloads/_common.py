"""Shared helpers for burrow PySpark workloads (shipped with --py-files by `cluster.py submit`).

Every workload takes `--key value` knobs, builds a SparkSession whose app name comes from spark-submit --name, and
prints a one-line JSON summary on the driver (visible in the driver's stdout container log).
"""
import argparse
import json
import sys
import time


def parser(description, **knobs):
    """argparse parser where every knob is `--name value` with a typed default: parser("x", rows=1000, sleep=0.1)."""
    p = argparse.ArgumentParser(description=description)
    for k, v in knobs.items():
        p.add_argument("--" + k.replace("_", "-"), dest=k, type=type(v) if v is not None else str, default=v)
    return p


def session(default_name):
    from pyspark.sql import SparkSession
    return SparkSession.builder.appName(default_name).getOrCreate()


def summary(spark, **kv):
    out = {"workload": spark.sparkContext.appName, "applicationId": spark.sparkContext.applicationId, **kv}
    print("BURROW_SUMMARY " + json.dumps(out), flush=True)
    sys.stdout.flush()


def pause(seconds):
    if seconds and seconds > 0:
        time.sleep(seconds)
