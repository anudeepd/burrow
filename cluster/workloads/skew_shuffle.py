"""Skewed shuffle: --skew fraction of rows land on one key, so one reduce task is a straggler (visible in the
stage task-distribution quantiles).  AQE skew handling is off by default so the skew survives; --aqe-skew 1 turns it on.
Knobs: --rows --skew --keys --aqe-skew --sleep."""
from pyspark.sql import functions as F

from _common import pause, parser, session, summary

args = parser("skew_shuffle", rows=300000, skew=0.8, keys=50, aqe_skew=0, sleep=0.0).parse_args()
spark = session("skew_shuffle")
spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true" if args.aqe_skew else "false")
spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "-1")

cut = int(args.rows * args.skew)
df = spark.range(args.rows).withColumn(
    "k", F.when(F.col("id") < cut, F.lit(0)).otherwise((F.col("id") % args.keys).cast("int") + 1))
side = spark.range(args.keys + 1).withColumnRenamed("id", "k").withColumn("label", F.concat(F.lit("L"), F.col("k").cast("string")))

by_key = df.groupBy("k").agg(F.count("*").alias("n"), F.avg("id").alias("avg_id"))
r1 = by_key.orderBy(F.desc("n")).limit(5).collect()
pause(args.sleep)
r2 = df.join(side, "k").groupBy("label").count().count()          # skewed sort-merge join
pause(args.sleep)
r3 = df.repartition(8, "k").rdd.glom().map(len).collect()          # RDD view of partition skew

summary(spark, topKey=r1[0]["k"], topCount=r1[0]["n"], joinGroups=r2, partitionSizes=r3)
spark.stop()
