"""Multi-stage RDD word count: shuffles (reduceByKey, sortByKey, join), a cached RDD reused across jobs
(=> Storage tab entries and skipped stages), several jobs.  Knobs: --lines --vocab --partitions --iterations --sleep."""
import random

from _common import pause, parser, session, summary

args = parser("wordcount_rdd", lines=20000, vocab=300, partitions=4, iterations=3, sleep=0.0).parse_args()
spark = session("wordcount_rdd")
sc = spark.sparkContext
sc.setJobGroup("wordcount", "generate + count + sort")

words = ["w%03d" % i for i in range(args.vocab)]


def make_line(i):
    r = random.Random(i)
    return " ".join(r.choice(words) for _ in range(8))


lines = sc.parallelize(range(args.lines), args.partitions).map(make_line).setName("generated lines")
tokens = lines.flatMap(str.split).setName("tokens")
counts = tokens.map(lambda w: (w, 1)).reduceByKey(lambda a, b: a + b, args.partitions).setName("word counts").cache()

total = counts.count()                      # job 0: map + reduce stage; materialises the cache
pause(args.sleep)
top = counts.sortBy(lambda kv: -kv[1]).take(5)   # job(s): sampling + range-shuffle sort, reads cache
pause(args.sleep)
for i in range(args.iterations):
    # re-key + join against the cached counts: more shuffle stages each iteration
    buckets = counts.map(lambda kv, i=i: (hash(kv[0]) % (7 + i), kv[1])).reduceByKey(lambda a, b: a + b)
    joined = buckets.join(sc.parallelize([(b, "bucket%d" % b) for b in range(7 + i)], 2))
    joined.count()
    pause(args.sleep)

summary(spark, distinctWords=total, top=[list(t) for t in top])
spark.stop()
