"""Spark SQL with window functions over temp views (rank, running sum, lag, ntile) — Window/Sort/Exchange plan nodes.
Knobs: --rows --groups --sleep."""
from _common import pause, parser, session, summary

args = parser("window_sql", rows=100000, groups=20, sleep=0.0).parse_args()
spark = session("window_sql")

spark.range(args.rows).selectExpr(
    "id", f"cast(id % {args.groups} as int) as grp", "cast(id % 101 as double) as score",
    "timestamp_seconds(1700000000 + id) as ts").createOrReplaceTempView("events")

q1 = spark.sql("""
  SELECT grp, id, score,
         row_number() OVER (PARTITION BY grp ORDER BY score DESC, id) AS rn,
         sum(score)   OVER (PARTITION BY grp ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running,
         lag(score, 1) OVER (PARTITION BY grp ORDER BY id) AS prev,
         ntile(4) OVER (PARTITION BY grp ORDER BY score) AS quartile
  FROM events""")
q1.createOrReplaceTempView("ranked")
top = spark.sql("SELECT grp, max(running) AS max_running, count(*) AS n FROM ranked WHERE rn <= 100 GROUP BY grp ORDER BY grp").collect()
pause(args.sleep)
tumbling = spark.sql("""
  SELECT window(ts, '10 minutes') AS w, count(*) AS n, avg(score) AS avg_score
  FROM events GROUP BY window(ts, '10 minutes') ORDER BY w""").collect()

summary(spark, groups=len(top), windows=len(tumbling))
spark.stop()
