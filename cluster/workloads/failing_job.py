"""A job whose tasks throw: every task attempt fails (spark.task.maxFailures retries) => job aborted => the driver
raises => YARN final status FAILED with diagnostics.  Run with `--attempts 1` to avoid AM retries.
Knobs: --mode task|driver  --good-jobs (successful jobs first)  --delay (seconds before failing)."""
from _common import pause, parser, session

args = parser("failing_job", mode="task", good_jobs=2, delay=0.0).parse_args()
spark = session("failing_job")
sc = spark.sparkContext

for i in range(args.good_jobs):          # a few succeeding jobs so the failure is not the only content
    sc.parallelize(range(1000), 4).map(lambda x: (x % 7, x)).reduceByKey(lambda a, b: a + b).count()
pause(args.delay)


def boom(x):
    raise ValueError("burrow deliberate failure in task: x=%d" % x)


if args.mode == "driver":
    raise RuntimeError("burrow deliberate driver-side failure")
sc.setJobDescription("deliberately failing job")
sc.parallelize(range(100), 4).map(boom).count()
spark.stop()
