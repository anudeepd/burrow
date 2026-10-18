"""Python UDFs (BatchEvalPython plan nodes, Python worker memory) + RDD mapPartitions with a Python closure.
Knobs: --rows --udf-sleep-ms (per row) --sleep."""
import time

from pyspark.sql import functions as F
from pyspark.sql.types import IntegerType, StringType

from _common import pause, parser, session, summary

args = parser("udf_python", rows=50000, udf_sleep_ms=0, sleep=0.0).parse_args()
spark = session("udf_python")
delay = args.udf_sleep_ms / 1000.0


@F.udf(returnType=StringType())
def bucket(n):
    if delay:
        time.sleep(delay)
    return "b%d" % (n % 13)


@F.udf(returnType=IntegerType())
def collatz(n):
    steps, n = 0, n + 1
    while n != 1 and steps < 200:
        n = n // 2 if n % 2 == 0 else 3 * n + 1
        steps += 1
    return steps


df = spark.range(args.rows).withColumn("bucket", bucket("id")).withColumn("steps", collatz("id"))
agg = df.groupBy("bucket").agg(F.max("steps").alias("max_steps"), F.count("*").alias("n")).orderBy("bucket")
rows = agg.collect()
pause(args.sleep)


def part_stats(it):
    n = s = 0
    for r in it:
        n += 1
        s += r["steps"]
    yield (n, s)


per_part = df.rdd.mapPartitions(part_stats).collect()
summary(spark, buckets=len(rows), partitions=len(per_part))
spark.stop()
