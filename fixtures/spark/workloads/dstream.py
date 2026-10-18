"""DStream (pyspark.streaming) app: queueStream -> map/reduceByKey -> window -> pprint; populates /streaming/* REST and the
Streaming tab. The context is left running when run() returns (the 'final' snapshot is therefore still a live stream)."""
import time

MASTER = "local[3]"
CONF = {"spark.streaming.ui.retainedBatches": "20"}
SNAPSHOT = {"env": True, "streaming": "dstream", "item_cap": 16}
def run(spark, cap):
    from pyspark.streaming import StreamingContext
    sc = spark.sparkContext
    ssc = StreamingContext(sc, 1)
    ssc.checkpoint("/tmp/burrow-dstream-ckpt")
    q = [sc.parallelize([(f"k{i % 4}", 1) for i in range(50 * (j + 1))], 2) for j in range(40)]
    s = ssc.queueStream(q)
    counts = s.reduceByKey(lambda a, b: a + b)
    counts.pprint()
    s.window(3, 1).count().pprint()
    s.map(lambda kv: kv[0]).countByValue().pprint()
    ssc.start()
    time.sleep(9)
    cap.snapshot("live", streaming="dstream", item_cap=16)
    time.sleep(6)
    cap.keep_alive = ssc
