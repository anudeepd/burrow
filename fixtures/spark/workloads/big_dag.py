"""A deep lineage of 12 *distinct* shuffles (each iteration changes the shuffle partition count, so Spark cannot reuse
the upstream partitioning) plus branching unions => a job DAG with ~27 stages / ~90 RDD nodes: perf vector.

The first version of this workload used a constant ``numPartitions``; Spark then reuses the existing partitioner across
consecutive ``reduceByKey`` calls and collapses the whole chain into one stage (measured: 10 stages, 22 RDD nodes). Cycling
the partition count forces a real shuffle stage pair per iteration."""
MASTER = "local[2]"
SNAPSHOT = {"env": True}


def run(spark, cap):
    sc = spark.sparkContext
    rdd = sc.parallelize(range(400), 2).map(lambda x: (x % 10, x))
    branches = []
    for i in range(12):
        # a different partition count every iteration => a fresh shuffle (new partitioner) every time
        rdd = rdd.reduceByKey(lambda a, b: a + b, 2 + (i % 7)).mapValues(lambda v: v + 1)
        if i % 4 == 3:
            branches.append(rdd.map(lambda kv: (kv[0], -kv[1])))
    out = rdd
    for b in branches:
        out = out.union(b)
    out.reduceByKey(lambda a, b: a + b, 3).sortByKey().collect()
