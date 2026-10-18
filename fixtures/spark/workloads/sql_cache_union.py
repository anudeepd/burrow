"""SQL: CACHE (InMemoryTableScan => cached RDDs in storage), union, exists-subquery, EXPLAIN, rollup."""
MASTER = "local[2]"
SNAPSHOT = {"env": True}


def run(spark, cap):
    from pyspark.sql import functions as F
    df = spark.range(0, 50000, 1, 4).select((F.col("id") % 100).alias("k"), (F.col("id") * 3).alias("v"))
    df.createOrReplaceTempView("t")
    spark.sql("CACHE TABLE tc AS SELECT k, sum(v) AS s FROM t GROUP BY k")
    spark.sql("SELECT * FROM tc WHERE k < 5").collect()
    spark.sql("SELECT k, s FROM tc WHERE k < 3 UNION ALL SELECT k, s FROM tc WHERE k > 96").collect()
    spark.sql("SELECT k, sum(s) FROM tc GROUP BY ROLLUP(k)").count()
    spark.sql("SELECT * FROM tc a WHERE EXISTS (SELECT 1 FROM t b WHERE b.k = a.k AND b.v > 149990)").collect()
    df.cache().count()   # DataFrame.cache() also lands in storage
