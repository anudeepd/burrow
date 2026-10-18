"""Python UDF in a DataFrame (BatchEvalPython), RDD mapPartitions in Python, and df.rdd round-trip."""
MASTER = "local[2]"
SNAPSHOT = {"env": True}


def run(spark, cap):
    from pyspark.sql import functions as F
    from pyspark.sql.types import StringType

    @F.udf(StringType())
    def shout(s):
        return (s or "").upper() + "!"

    df = spark.range(0, 20000, 1, 4).select(F.concat(F.lit("row"), F.col("id")).alias("s"), (F.col("id") % 10).alias("g"))
    df.select("g", shout("s").alias("u")).groupBy("g").count().collect()
    df.rdd.map(lambda r: (r["g"], len(r["s"]))).reduceByKey(lambda a, b: a + b).collect()
    spark.sparkContext.parallelize(range(1000), 4).mapPartitions(lambda it: [sum(it)]).collect()
