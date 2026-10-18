import org.apache.spark.sql.SparkSession
import org.apache.spark.sql.functions._

object BurrowSqlDemo {
  def main(args: Array[String]): Unit = {
    val spark = SparkSession.builder().appName("burrow-spark24-sql-demo").getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    import spark.implicits._
    spark.range(20000)
      .selectExpr("id", "CAST(id % 100 AS INT) AS customer_id", "CAST(id * 0.5 AS DOUBLE) AS amount")
      .createOrReplaceTempView("orders")
    spark.range(100)
      .selectExpr("CAST(id AS INT) AS customer_id", "concat('region-', CAST(id % 5 AS STRING)) AS region")
      .createOrReplaceTempView("customers")
    val result = spark.sql("""
      SELECT c.region, SUM(o.amount) AS revenue, COUNT(*) AS order_count
      FROM orders o JOIN customers c ON o.customer_id = c.customer_id
      GROUP BY c.region ORDER BY c.region
    """)
    result.explain(true)
    result.collect().foreach(println)
    Thread.sleep(180000)
    spark.stop()
  }
}
