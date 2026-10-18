"""Long-running multi-stage app for live demos: loops for --duration seconds running jobs of varying shape
(shuffle, cache, SQL/AQE, skew, python UDF), so Jobs/Stages/SQL/Storage/Executors all keep changing.
Knobs: --duration (s) --task-ms (per-task sleep, stretches stages) --rows --tick (s between rounds)."""
import random
import time

from pyspark.sql import functions as F

from _common import parser, session, summary

args = parser("long_running", duration=300, task_ms=150, rows=40000, tick=1.0).parse_args()
spark = session("long_running")
sc = spark.sparkContext
delay = args.task_ms / 1000.0
end = time.time() + args.duration
rnd = random.Random(7)
rounds = 0


def slow(x):
    if delay:
        time.sleep(delay / 50.0)
    return x


cached = sc.parallelize(range(args.rows), 6).map(lambda x: (x % 97, x)).setName("cached pairs").cache()
cached.count()

while time.time() < end:
    rounds += 1
    shape = rounds % 5
    sc.setJobGroup("round-%d" % rounds, "round %d shape %d" % (rounds, shape))
    if shape == 0:
        cached.map(lambda kv: (kv[0] % 13, slow(kv[1]))).reduceByKey(lambda a, b: a + b).sortByKey().count()
    elif shape == 1:
        df = spark.range(args.rows).withColumn("k", F.col("id") % 31)
        df.groupBy("k").agg(F.sum("id"), F.count("*")).orderBy("k").collect()
    elif shape == 2:
        a = spark.range(args.rows).withColumn("k", (F.col("id") % 50).cast("int"))
        b = spark.range(50).withColumnRenamed("id", "k").withColumn("tag", F.col("k") * 2)
        a.join(b, "k").groupBy("tag").count().collect()
    elif shape == 3:
        skewed = sc.parallelize(range(args.rows), 6).map(lambda x: (0 if x % 10 < 8 else x % 40, slow(1)))
        skewed.groupByKey().mapValues(len).collect()
    else:
        sc.parallelize(range(args.rows // 4), 6).map(lambda x: slow(x * rnd.randint(1, 3)) if x % 997 == 0 else x).distinct().count()
    time.sleep(args.tick)

summary(spark, rounds=rounds, duration=args.duration)
spark.stop()
