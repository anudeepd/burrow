"""Queue-backed DStream workload for exercising Spark's legacy Streaming UI.

Knobs: --duration --batch-seconds --batches --items-per-batch --partitions.
"""
import tempfile

from pyspark.streaming import StreamingContext

from _common import parser, session, summary

args = parser(
    "dstream_queue",
    duration=240,
    batch_seconds=2,
    batches=140,
    items_per_batch=100,
    partitions=2,
).parse_args()

spark = session("dstream_queue")
sc = spark.sparkContext
ssc = StreamingContext(sc, args.batch_seconds)
ssc.checkpoint(tempfile.mkdtemp(prefix="burrow-dstream-checkpoint-"))

queued_batches = [
    sc.parallelize(
        [("key-%d" % ((batch + offset) % 8), 1) for offset in range(args.items_per_batch)],
        args.partitions,
    )
    for batch in range(args.batches)
]
events = ssc.queueStream(queued_batches, oneAtATime=True)
counts = events.reduceByKey(lambda left, right: left + right)
counts.pprint(num=8)
counts.window(6, args.batch_seconds).pprint(num=8)

ssc.start()
ssc.awaitTerminationOrTimeout(args.duration)
ssc.stop(stopSparkContext=False, stopGraceFully=True)
summary(spark, queuedBatches=args.batches, batchSeconds=args.batch_seconds)
spark.stop()
