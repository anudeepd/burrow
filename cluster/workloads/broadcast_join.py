"""Broadcast hash join (BroadcastExchange / BroadcastHashJoin plan nodes) plus an RDD broadcast variable.
Knobs: --rows --dim-rows --sleep."""
from pyspark.sql import functions as F

from _common import pause, parser, session, summary

args = parser("broadcast_join", rows=300000, dim_rows=1000, sleep=0.0).parse_args()
spark = session("broadcast_join")

facts = spark.range(args.rows).withColumn("k", (F.col("id") % args.dim_rows).cast("int")).withColumn("v", F.col("id") % 11)
dims = spark.range(args.dim_rows).withColumnRenamed("id", "k").withColumn("name", F.concat(F.lit("dim_"), F.col("k").cast("string")))
joined = facts.join(F.broadcast(dims), "k")
n = joined.filter(F.col("v") > 3).groupBy("name").agg(F.sum("v").alias("sv")).count()
pause(args.sleep)

lookup = spark.sparkContext.broadcast({i: "d%d" % i for i in range(args.dim_rows)})
m = (spark.sparkContext.parallelize(range(args.rows // 10), 4)
     .map(lambda i: lookup.value[i % args.dim_rows]).distinct().count())

summary(spark, groups=n, broadcastKeys=m)
spark.stop()
