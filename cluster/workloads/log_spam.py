"""Large container log generator for the log-viewer slice: the driver writes --megabytes MB of lines to stdout,
which in `--deploy-mode cluster` lands in the ApplicationMaster container's `stdout` file (and is therefore
served by the NodeManager and, after aggregation, by the JobHistory Server). A small job runs afterwards so the
application is a real Spark job and not just a log emitter.

Knobs: --megabytes (default 5) --line-bytes (default 220) --rows rows for the trailing job."""
import sys

from _common import parser, session, summary

args = parser("log_spam", megabytes=5, line_bytes=220, rows=2000).parse_args()
spark = session("log_spam")
sc = spark.sparkContext

payload = "y" * max(8, args.line_bytes - 48)
target = int(args.megabytes * 1024 * 1024)
written = 0
lines = 0
print("BURROW_BIGLOG start target_bytes=%d" % target, flush=True)
while written < target:
    line = "[biglog] %09d %s\n" % (lines, payload)
    sys.stdout.write(line)
    written += len(line)
    lines += 1
    if lines % 5000 == 0:
        sys.stdout.flush()
sys.stdout.flush()
print("BURROW_BIGLOG emitted bytes=%d lines=%d" % (written, lines), flush=True)

total = sc.parallelize(range(args.rows), 2).map(lambda x: x + 1).sum()
print("BURROW_BIGLOG end sum=%d" % total, flush=True)
summary(spark, logBytes=written, logLines=lines, sum=total)
spark.stop()
