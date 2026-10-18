"""DataFrame join / groupBy / sort with AQE on. Sort-merge join (broadcast disabled) + a self-join over a shared
aggregate so AQE reuses an exchange => skipped stages and many small AQE jobs per query."""
MASTER = "local[2]"
SNAPSHOT = {"env": True}
CONF = {
    "spark.sql.adaptive.enabled": "true",
    "spark.sql.autoBroadcastJoinThreshold": "-1",
    "spark.sql.adaptive.coalescePartitions.initialPartitionNum": "8",
}


def run(spark, cap):
    from pyspark.sql import functions as F

    orders = spark.range(0, 200000, 1, 4).select(
        (F.col("id") % 1000).alias("cust"), (F.col("id") % 7).alias("p"), (F.rand(1) * 100).alias("amt"))
    custs = spark.range(0, 1000, 1, 2).select(F.col("id").alias("cust"), F.concat(F.lit("c"), F.col("id")).alias("name"))

    spark.sparkContext.setJobDescription("join+groupBy+orderBy")
    (orders.join(custs, "cust").groupBy("name")
           .agg(F.sum("amt").alias("total"), F.count("*").alias("n"))
           .orderBy(F.desc("total")).collect())

    spark.sparkContext.setJobDescription("self-join of a shared aggregate (ReusedExchange)")
    agg = orders.groupBy("cust").count()
    agg.join(agg.withColumnRenamed("count", "c2"), "cust").count()
    spark.sparkContext.setJobDescription(None)
