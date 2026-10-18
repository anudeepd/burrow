"""Captured mid-flight: two concurrent jobs (an RDD job with 3 chained stages + a SQL query with a slow Python UDF), a
cached RDD that is only partly materialised, ACTIVE/PENDING stages, RUNNING tasks, then again after completion."""
import threading
import time

MASTER = "local[4]"
SNAPSHOT = {"env": True}


def run(spark, cap):
    from pyspark.sql import functions as F
    from pyspark.sql.types import IntegerType
    sc = spark.sparkContext

    def slow(it):
        import time as t
        for x in it:
            t.sleep(0.8)
            yield x

    sc.setJobDescription("long chained job")
    chained = (sc.parallelize(range(24), 6).mapPartitions(slow).setName("slow-source").cache()
                 .map(lambda x: (x % 5, x)).reduceByKey(lambda a, b: a + b, 3)
                 .mapPartitions(slow).map(lambda kv: (kv[0] % 2, kv[1])).reduceByKey(lambda a, b: a + b, 2))
    t1 = threading.Thread(target=lambda: chained.collect())
    t1.start()

    @F.udf(IntegerType())
    def nap(x):
        import time as t
        t.sleep(0.02)
        return x

    def sql_job():
        sc.setJobDescription("long sql query")
        spark.range(0, 1200, 1, 4).select(nap("id").alias("v")).groupBy((F.col("v") % 3).alias("m")).count().collect()

    t2 = threading.Thread(target=sql_job)
    t2.start()

    def wait(pred, timeout=60):
        t0 = time.time()
        while time.time() - t0 < timeout:
            st = cap.jget(cap.app_path() + "/stages") or []
            if pred(st):
                return True
            time.sleep(0.2)
        return False

    wait(lambda st: any(s["status"] == "ACTIVE" and s["numCompleteTasks"] >= 1 and s["numActiveTasks"] >= 1 for s in st)
         and any(s["status"] == "PENDING" for s in st))
    cap.snapshot("live1", item_cap=20)       # first stage running, downstream stages PENDING
    wait(lambda st: any(s["status"] == "COMPLETE" for s in st) and
         any(s["status"] == "ACTIVE" and s["numCompleteTasks"] >= 1 for s in st) and
         len([s for s in st if s["status"] == "ACTIVE"]) >= 1, 20)
    time.sleep(2.5)
    cap.snapshot("live2", item_cap=20)       # later: first job's second stage running
    t1.join()
    t2.join()
    sc.setJobDescription(None)
