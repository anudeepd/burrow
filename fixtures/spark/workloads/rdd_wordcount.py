"""RDD word count: textFile -> flatMap/map -> reduceByKey (cached) -> join with a second shuffle -> sortBy.
Multi-stage shuffles, a cached RDD (storage/rdd populated), nested operation scopes (sortBy/distinct/join)."""
import os
import random

MASTER = "local[2]"
SNAPSHOT = {"env": True, "quirks": True}  # this workload carries the (large) environment + error-shape captures


def run(spark, cap):
    sc = spark.sparkContext
    random.seed(7)
    words = ["spark", "yarn", "dag", "stage", "task", "shuffle", "rdd", "executor", "driver", "cache"]
    path = "/tmp/burrow-wordcount-input.txt"
    with open(path, "w") as f:
        for _ in range(400):
            f.write(" ".join(random.choice(words) for _ in range(8)) + "\n")

    lines = sc.textFile(path, minPartitions=4)
    counts = (lines.flatMap(lambda l: l.split())
                   .map(lambda w: (w, 1))
                   .reduceByKey(lambda a, b: a + b, 3)
                   .setName("word-counts")
                   .cache())
    counts.count()                       # job 0: 2 stages, materialises the cache
    top = counts.sortBy(lambda kv: -kv[1]).take(3)   # job(s): sortBy => sampling job + range-partitioned shuffle
    lens = counts.map(lambda kv: (len(kv[0]), kv[1])).reduceByKey(lambda a, b: a + b)
    joined = counts.map(lambda kv: (len(kv[0]), kv[0])).join(lens)   # extra shuffle + cogroup
    joined.collect()
    counts.distinct().count()
    print("top", top)
