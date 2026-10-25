# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Hadoop/Spark cluster operators, data engineers, and application teams who need to inspect cluster health and follow application behavior while operating or troubleshooting workloads.

## Product Purpose

Burrow is a local, read-only browser UI for Apache Hadoop YARN and Spark-on-YARN. It brings cluster operations and Spark application tracking into one interface so users can inspect cluster resources, find applications, and follow Spark jobs, stages, executors, SQL, and logs. Success means users can understand cluster and workload state without changing the upstream YARN cluster.

## Positioning

Burrow runs beside the user's Hadoop/Spark environment and connects directly to configured or discovered services; it does not depend on a Burrow-hosted service. It combines YARN cluster operations visibility with Spark workload diagnostics in a read-only interface.

## Operating Context

Users install the `yarn-burrow` distribution and run the `burrow` command. Burrow serves its web UI locally, binding to `127.0.0.1` by default, and reads from ResourceManagers, NodeManagers, JobHistory Servers, and Spark History Servers. Service addresses can be supplied explicitly or discovered from Hadoop and Spark client configuration. A reverse proxy may expose Burrow at a root-mounted URL.

## Capabilities and Constraints

- Inspect cluster health, applications, queues, scheduler state, nodes, and labels.
- Follow Spark jobs, stages, executors, storage, environment, SQL, streaming, and timelines; inspect configuration, JMX, thread stacks, daemon logs, and container logs.
- Use filters, URL-addressable views, exports, and live updates.
- Burrow has no YARN write actions, including application termination, queue moves, or priority changes.
- Kerberos/SPNEGO is not implemented. Simple authentication, custom request headers, bearer tokens, custom TLS CAs, and ResourceManager HA are supported.
- The packaged UI expects to be served from the site root; a URL subpath is not currently supported by the packaged UI.
- Hadoop 3.4.3 and Spark 2.4.8, 3.3.2, and 4.2.0 have documented live verification. These versions are evidence of tested behavior, not a guarantee for every vendor distribution.
- The public distribution is named `yarn-burrow`; the installed command and product UI are named `burrow`.

## Brand Commitments

The product name is **Burrow**. YARN and Spark are Apache Software Foundation trademarks; Burrow is an independent project.

## Evidence on Hand

- `README.md` and `docs/features.md` document the product and its workflows.
- `docs/screenshots/` contains overview, applications, and Spark jobs captures made with demo data.
- `docs/verification.md`, `docs/parity.md`, `parity/`, and `fixtures/` contain live-cluster, parity, and captured-payload evidence. Compatibility claims should stay within the versions and limits recorded there.
- The repository contains no customer testimonials, pricing, or market validation to use as product proof.

## Product Principles

- Keep upstream YARN operations read-only.
- Keep the service local and self-hosted, without a required Burrow-hosted dependency.
- Bring cluster operations and Spark workload investigation into one workflow.
- State compatibility and performance claims only to the extent supported by recorded verification.
