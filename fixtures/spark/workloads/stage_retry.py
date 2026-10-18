"""A retried stage (stage attempt 1).

Recipe (deterministic, local mode): the reduce stage's first task attempt sleeps until the driver thread has deleted
every shuffle_* file under spark.local.dir, then raises; the task retry then fails to fetch the (deleted) map output =>
FetchFailedException => DAGScheduler resubmits the map stage (attempt 1) and then the reduce stage (attempt 1)."""
MASTER = "local[2,4]"
CONF = {"spark.stage.maxConsecutiveAttempts": "4"}
SNAPSHOT = {"env": True}


def run(spark, cap):
    import glob
    import os
    import threading
    import time

    sc = spark.sparkContext
    flag = "/tmp/burrow-stage-retry.flag"
    if os.path.exists(flag):
        os.remove(flag)
    local_dir = cap.meta["conf"]["spark.local.dir"]

    def reduce_side(it):
        from pyspark import TaskContext
        ctx = TaskContext.get()
        if ctx.stageAttemptNumber() == 0 and ctx.attemptNumber() == 0:
            for _ in range(200):
                if os.path.exists(flag):
                    break
                time.sleep(0.1)
            raise RuntimeError("first attempt dies after shuffle files vanished")
        return it

    res = {}

    def job():
        res["v"] = (sc.parallelize(range(2000), 2).map(lambda x: (x % 11, x)).reduceByKey(lambda a, b: a + b, 2)
                    .mapPartitions(reduce_side).map(lambda kv: (kv[0] % 2, kv[1])).reduceByKey(lambda a, b: a + b, 2)
                    .collect())

    sc.setJobDescription("shuffle files deleted under a running reduce stage")
    t = threading.Thread(target=job)
    t.start()

    # wait for the first reduce stage to be running, then delete the map output
    deadline = time.time() + 60
    while time.time() < deadline:
        st = cap.jget(cap.app_path() + "/stages") or []
        if any(s["status"] == "ACTIVE" and s["numActiveTasks"] > 0 and s["stageId"] >= 1 for s in st):
            break
        time.sleep(0.1)
    files = [f for f in glob.glob(os.path.join(local_dir, "**", "shuffle_*"), recursive=True)]
    print("deleting shuffle files:", len(files))
    for f in files:
        os.remove(f)
    open(flag, "w").close()
    cap.snapshot("live", item_cap=12, html=True)     # mid-retry capture (stage 1 attempt 0 still ACTIVE)
    t.join(120)
    sc.setJobDescription(None)
