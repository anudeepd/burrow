"""Several jobs sharing stages: the shuffle of `shuf` is computed by job 0 and *skipped* by later jobs; job groups and
descriptions; repartition (INDETERMINATE) ; groupByKey (UNORDERED)."""
MASTER = "local[2]"
SNAPSHOT = {"env": True}


def run(spark, cap):
    sc = spark.sparkContext
    shuf = sc.parallelize(range(3000), 4).map(lambda x: (x % 13, x)).reduceByKey(lambda a, b: a + b, 3)
    sc.setJobGroup("grp-A", "first pass over shuf")
    shuf.count()                                              # computes map stage + result stage
    sc.setJobGroup("grp-B", "second pass reuses shuffle output")
    shuf.collect()                                            # map stage skipped
    shuf.map(lambda kv: (kv[0] % 3, kv[1])).reduceByKey(lambda a, b: a + b).collect()   # shares shuf's map stage (skipped) + new stage
    sc.setJobGroup("grp-C", "indeterminate / unordered")
    sc.parallelize(range(100), 4).repartition(3).map(lambda x: (x % 4, x)).groupByKey().mapValues(len).collect()
    sc.setJobGroup("", "")
