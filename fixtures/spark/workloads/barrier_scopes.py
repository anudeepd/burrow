"""DAG edge cases: barrier stage, hand-crafted (nested, escaped) operation scopes and names via the spark.rdd.scope local
property, hostile RDD names and call sites (quotes, <, &, [n], newlines, backslashes, non-ASCII)."""
import json

MASTER = "local[2]"
SNAPSHOT = {"env": True}


def run(spark, cap):
    sc = spark.sparkContext

    # 1. barrier stage
    sc.parallelize(range(10), 2).barrier().mapPartitions(lambda it: [sum(it)]).collect()

    # 2. crafted nested scopes + hostile names through the JVM API (python wrappers would override scope/callsite)
    scope = {
        "id": "9001", "name": 'outer "q" <b>bold</b> & amp; back\\slash \n newline é–✓',
        "parent": {"id": "9000", "name": "grandparent"},
    }
    sc.setLocalProperty("spark.rdd.scope", json.dumps(scope))
    sc.setLocalProperty("spark.rdd.scope.noOverride", "true")
    sc._jsc.setCallSite('site <x> & "y" \'z\' [5]\\n é')
    jl = sc._jvm.java.util.ArrayList()
    for i in range(20):
        jl.add(i)
    jr = sc._jsc.parallelize(jl, 2)
    jr.setName('name "with" <i>html</i> & [7] \\ back\nnl é–✓')
    jr.count()
    sc.setLocalProperty("spark.rdd.scope", None)
    sc.setLocalProperty("spark.rdd.scope.noOverride", None)
    sc._jsc.setCallSite(None)

    # 3. same thing but across a shuffle so the hostile scope lives in two stages
    sc.setLocalProperty("spark.rdd.scope", json.dumps({"id": "9002", "name": "shared <scope>"}))
    sc.setLocalProperty("spark.rdd.scope.noOverride", "true")
    sc.parallelize(range(50), 2).map(lambda x: (x % 3, x)).reduceByKey(lambda a, b: a + b, 2).collect()
    sc.setLocalProperty("spark.rdd.scope", None)
    sc.setLocalProperty("spark.rdd.scope.noOverride", None)
