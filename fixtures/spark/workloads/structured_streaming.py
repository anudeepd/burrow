"""Structured Streaming: rate source -> windowed aggregation -> memory sink. Populates the /StreamingQuery/ tab and one SQL
execution + several jobs per micro-batch."""
import time

MASTER = "local[3]"
CONF = {"spark.sql.streaming.numRecentProgressUpdates": "50", "spark.sql.shuffle.partitions": "4"}
SNAPSHOT = {"env": True, "streaming": "structured", "item_cap": 16}
def run(spark, cap):
    from pyspark.sql import functions as F
    src = spark.readStream.format("rate").option("rowsPerSecond", 40).load()
    agg = (src.withWatermark("timestamp", "10 seconds")
              .groupBy(F.window("timestamp", "5 seconds"), (F.col("value") % 3).alias("k")).count())
    q = (agg.writeStream.outputMode("update").format("memory").queryName("rate_counts")
            .trigger(processingTime="2 seconds").start())
    time.sleep(10)
    cap.snapshot("live", streaming="structured", item_cap=16)
    cap.html("live", "streamingquery-statistics", "StreamingQuery/statistics/", f"id={q.runId}")
    time.sleep(4)
    cap.html("final", "streamingquery-statistics", "StreamingQuery/statistics/", f"id={q.runId}")
    q.stop()
    time.sleep(1)
    cap.html("final", "streamingquery-after-stop", "StreamingQuery/")
