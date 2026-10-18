# Spark 2.4 SQL compatibility capture

This fixture came from a real Spark 2.4.0 YARN application submitted to the local test cluster. The workload creates temporary
`orders` and `customers` views, joins and aggregates them with SQL, collects the result, then keeps the application alive for
three minutes so its UI pages can be inspected. The saved pages are the Spark 2.4 UI's own SQL list and execution detail, used by the backend compatibility
adapter when `/api/v1/applications/{appId}/sql` returns 404.

The capture includes the source workload and a manifest with endpoint paths, byte counts, and SHA-256 hashes. The driver ran
on Temurin 8 because Spark 2.4's bytecode analysis is incompatible with Java 17; the local YARN daemons and executor ran on
Java 17.
