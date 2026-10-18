"""One healthy job, then a job that fails completely (every attempt of a task fails => stage + job FAILED), then a
failing SQL execution. local[2,2] => maxFailures=2."""
MASTER = "local[2,2]"
SNAPSHOT = {"env": True}


def run(spark, cap):
    sc = spark.sparkContext
    sc.parallelize(range(100), 2).map(lambda x: x * 2).count()   # job 0: fine

    def boom(x):
        if x == 13:
            raise ValueError("task blew up on 13")
        return x

    sc.setJobDescription("doomed job")
    try:
        sc.parallelize(range(40), 4).map(boom).map(lambda x: (x % 3, x)).reduceByKey(lambda a, b: a + b).collect()
    except Exception as e:  # noqa: BLE001
        print("expected failure:", type(e).__name__)
    sc.setJobDescription(None)

    from pyspark.sql import functions as F
    from pyspark.sql.types import IntegerType

    @F.udf(IntegerType())
    def bad(x):
        return 1 // (x - x)

    try:
        spark.range(10).select(bad("id")).collect()
    except Exception as e:  # noqa: BLE001
        print("expected sql failure:", type(e).__name__)
