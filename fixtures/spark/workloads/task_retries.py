"""Tasks that fail (python exception) and are retried; the job still SUCCEEDS. local[2,4] => spark.task.maxFailures=4."""
MASTER = "local[2,4]"
SNAPSHOT = {"env": True}


def run(spark, cap):
    from pyspark import TaskContext
    sc = spark.sparkContext

    def flaky(it):
        ctx = TaskContext.get()
        if ctx.partitionId() in (1, 3) and ctx.attemptNumber() < 2:
            raise RuntimeError(f"induced failure partition={ctx.partitionId()} attempt={ctx.attemptNumber()}")
        return it

    sc.setJobDescription("flaky tasks, retried 2x")
    r = (sc.parallelize(range(400), 4).mapPartitions(flaky)
           .map(lambda x: (x % 7, x)).reduceByKey(lambda a, b: a + b).collect())
    sc.setJobDescription(None)
    assert len(r) == 7
