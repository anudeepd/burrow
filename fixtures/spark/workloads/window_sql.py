"""Window functions in SQL text (rank, running sum, lag), CTE + subquery; several SQL executions."""
MASTER = "local[2]"
SNAPSHOT = {"env": True}


def run(spark, cap):
    import random
    random.seed(3)
    rows = [(i, f"dept{i % 5}", random.randint(1000, 9000), 2020 + i % 4) for i in range(2000)]
    df = spark.createDataFrame(rows, ["id", "dept", "sal", "yr"])
    df.createOrReplaceTempView("emp")
    spark.sql("""SELECT id, dept, sal,
                        rank() OVER (PARTITION BY dept ORDER BY sal DESC) AS rk,
                        sum(sal) OVER (PARTITION BY dept ORDER BY id ROWS BETWEEN 3 PRECEDING AND CURRENT ROW) AS run,
                        lag(sal, 1) OVER (PARTITION BY dept ORDER BY id) AS prev
                 FROM emp""").filter("rk <= 3").collect()
    spark.sql("""WITH t AS (SELECT dept, yr, avg(sal) AS a FROM emp GROUP BY dept, yr)
                 SELECT dept, yr, a, dense_rank() OVER (PARTITION BY yr ORDER BY a DESC) AS r FROM t
                 WHERE a > (SELECT avg(sal) FROM emp)""").collect()
    spark.sql("SELECT count(DISTINCT dept), max(sal) FROM emp").collect()
