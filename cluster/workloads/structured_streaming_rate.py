"""Structured Streaming from the built-in `rate` source: windowed aggregation with a watermark, foreachBatch sink.
Runs for --duration seconds then stops cleanly.  Knobs: --duration --rows-per-second --trigger-seconds."""
import os
import tempfile
import time

from pyspark.sql import functions as F

from _common import parser, session, summary

args = parser("structured_streaming_rate", duration=120, rows_per_second=200, trigger_seconds=2).parse_args()
spark = session("structured_streaming_rate")
spark.conf.set("spark.sql.shuffle.partitions", "4")

stream = (spark.readStream.format("rate").option("rowsPerSecond", args.rows_per_second).option("numPartitions", 2).load())
windowed = (stream.withWatermark("timestamp", "10 seconds")
            .groupBy(F.window("timestamp", "5 seconds"), (F.col("value") % 5).alias("bucket"))
            .agg(F.count("*").alias("n"), F.max("value").alias("max_value")))

batches = []


def handle(df, batch_id):
    batches.append((batch_id, df.count()))


ckpt = os.path.join(tempfile.mkdtemp(prefix="burrow-ckpt-"), "chk")
query = (windowed.writeStream.outputMode("update").foreachBatch(handle).option("checkpointLocation", ckpt)
         .trigger(processingTime="%d seconds" % args.trigger_seconds).queryName("rate_windowed").start())
query.awaitTermination(args.duration)
query.stop()
summary(spark, batches=len(batches), lastBatch=batches[-1][0] if batches else None)
spark.stop()
