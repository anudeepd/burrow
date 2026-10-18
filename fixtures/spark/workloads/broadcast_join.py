"""Broadcast hash join via hint (BroadcastExchange job + BroadcastHashJoin) and a plain sc.broadcast variable."""
MASTER = "local[2]"
CONF = {"spark.sql.adaptive.enabled": "true"}
SNAPSHOT = {"env": True}


def run(spark, cap):
    from pyspark.sql import functions as F
    big = spark.range(0, 100000, 1, 4).select((F.col("id") % 50).alias("k"), F.col("id").alias("v"))
    small = spark.range(0, 50, 1, 1).select(F.col("id").alias("k"), F.concat(F.lit("n"), F.col("id")).alias("name"))
    big.join(F.broadcast(small), "k").groupBy("name").count().collect()
    bv = spark.sparkContext.broadcast({i: i * i for i in range(100)})
    spark.sparkContext.parallelize(range(100), 4).map(lambda x: bv.value[x % 100]).sum()
