<p align="center">
  <img src="https://raw.githubusercontent.com/anudeepd/burrow/master/web/public/favicon.svg" alt="Burrow logo" width="72" height="72" />
</p>

<h1 align="center">Burrow</h1>

[![Status: Alpha](https://img.shields.io/badge/status-alpha-orange)](https://github.com/anudeepd/burrow/blob/master/pyproject.toml)
[![Version: 0.1.4](https://img.shields.io/badge/version-0.1.4-blue)](https://github.com/anudeepd/burrow/blob/master/Cargo.toml)
[![License: MIT](https://img.shields.io/badge/license-MIT-007EC6.svg)](https://github.com/anudeepd/burrow/blob/master/LICENSE)

**A local, read-only browser UI for Apache Hadoop YARN and Spark-on-YARN.**

Burrow brings cluster operations and Spark tracking together: inspect applications, queues and nodes, then follow a Spark application's jobs, stages, executors, SQL, logs and live DAGs in the same interface.

## Screenshots

These screenshots use Burrow's demo data to show the desktop overview, the responsive applications page and Spark jobs.

Click a thumbnail to open the full-size screenshot.

<table>
  <tr>
    <th>Cluster overview</th>
    <th>Applications on mobile</th>
    <th>Spark jobs</th>
  </tr>
  <tr>
    <td align="center"><a href="https://github.com/anudeepd/burrow/blob/master/docs/screenshots/overview-desktop.png"><img src="https://raw.githubusercontent.com/anudeepd/burrow/master/docs/screenshots/overview-desktop.png" alt="Burrow cluster overview on desktop" width="260" /></a></td>
    <td align="center"><a href="https://github.com/anudeepd/burrow/blob/master/docs/screenshots/applications-mobile.png"><img src="https://raw.githubusercontent.com/anudeepd/burrow/master/docs/screenshots/applications-mobile.png" alt="Burrow applications page on mobile" width="130" /></a></td>
    <td align="center"><a href="https://github.com/anudeepd/burrow/blob/master/docs/screenshots/spark-jobs-desktop.png"><img src="https://raw.githubusercontent.com/anudeepd/burrow/master/docs/screenshots/spark-jobs-desktop.png" alt="Burrow Spark jobs page on desktop" width="260" /></a></td>
  </tr>
</table>

## Start Burrow

Install `yarn-burrow` from PyPI and check which services your cluster exposes:

```bash
pip install yarn-burrow
burrow doctor
burrow
```

Burrow serves the UI at `http://127.0.0.1:8787` by default. `burrow doctor` reports detected ResourceManager, NodeManager, JobHistory and Spark History services. The default configuration can discover addresses from Hadoop and Spark client configuration. For explicit service addresses, HA ResourceManagers, bind settings and reverse-proxy setup, see [installation and configuration](https://github.com/anudeepd/burrow/blob/master/docs/install-and-configuration.md).

> **Package name note:** the public PyPI project [`burrow`](https://pypi.org/project/burrow/) is an unrelated Nest Mobile API client. This project’s Python distribution is `yarn-burrow`; it installs the `burrow` command.

The wheel contains a self-contained executable with the web UI embedded. Python and pip are used to install the wheel; Python, Node.js, Bun and Java are not needed to run Burrow.

## What you can do

- **Operate YARN:** review cluster health, applications, queues, scheduler capacity, nodes and labels.
- **Follow Spark:** inspect jobs and stages with DAGs, task details, executors, storage, environment, SQL, streaming and timelines. Running apps use the ResourceManager web proxy; finished apps use the Spark History Server.
- **Troubleshoot:** inspect ResourceManager and NodeManager configuration, JMX, thread stacks and daemon logs; view container logs while running or after aggregation.
- **Work with live data:** use filters, URL-addressable views, exports and live updates while Burrow keeps the upstream data path read-only.

The [feature guide](https://github.com/anudeepd/burrow/blob/master/docs/features.md) lists the full page-by-page coverage.

## Stack

[![Rust 2024](https://img.shields.io/badge/Rust-2024-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React 19](https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white)](https://react.dev/)
[![TanStack Start](https://img.shields.io/badge/TanStack-Start-FF4154)](https://tanstack.com/)
[![TanStack Router](https://img.shields.io/badge/TanStack-Router-FF4154)](https://tanstack.com/)
[![TanStack Query](https://img.shields.io/badge/TanStack-Query-FF4154?logo=reactquery&logoColor=white)](https://tanstack.com/)
[![TanStack Store](https://img.shields.io/badge/TanStack-Store-FF4154)](https://tanstack.com/)
[![TanStack Table](https://img.shields.io/badge/TanStack-Table-FF4154)](https://tanstack.com/)
[![TanStack Virtual](https://img.shields.io/badge/TanStack-Virtual-FF4154)](https://tanstack.com/)
[![TanStack Pacer](https://img.shields.io/badge/TanStack-Pacer-FF4154)](https://tanstack.com/)
[![TanStack Hotkeys](https://img.shields.io/badge/TanStack-Hotkeys-FF4154)](https://tanstack.com/)
[![Bun 1.4.3](https://img.shields.io/badge/Bun-1.4.3-fbf0df?logo=bun&logoColor=000000)](https://bun.sh/)
[![Vite 8.3](https://img.shields.io/badge/Vite-8.3-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Tailwind CSS 4.3](https://img.shields.io/badge/Tailwind_CSS-4.3-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Vitest 5](https://img.shields.io/badge/Vitest-5-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![Playwright 1.63](https://img.shields.io/badge/Playwright-1.63-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)

| Layer | Technologies |
|---|---|
| Server | Rust 2024, Tokio, Axum |
| Web UI | React 19, TypeScript, TanStack Start/Router/Query/Store/Table/Virtual/Pacer/Hotkeys, Vite, Tailwind CSS 4, Base UI, Motion, D3 scale/shape and ELK.js |
| Development and verification | Bun, Vitest, Testing Library, Playwright, Biome, Cargo tests, Clippy and rustfmt |
| Packaging | Maturin-built `yarn-burrow` platform wheel containing one Rust binary with the web UI embedded |

The versions shown in badges are checked against the project manifests and lockfiles; Bun 1.4.3 is the version recorded in the verification environment. See the [architecture overview](https://github.com/anudeepd/burrow/blob/master/docs/architecture.md) for implementation details.

## Limitations

- **Read-only:** Burrow has no application kill, queue move or priority-change actions.
- **Kerberos/SPNEGO is not implemented.** Simple auth (`user.name`), custom headers, bearer tokens, custom TLS CAs and ResourceManager HA are supported.
- **ATS v2/flow activity, YARN services and Federation are out of scope.** UI2-only pages are catalogued in the parity inventory rather than presented as implemented.
- **No MapReduce job-level view.** MapReduce and distributed-shell applications have YARN-level views.
- **The packaged UI cannot be hosted under a URL subpath** such as `https://example.com/burrow/` yet. It expects the site root, such as `https://burrow.example.com/`; otherwise the UI looks for its API at `/api` instead of `/burrow/api`. See [reverse-proxy setup](https://github.com/anudeepd/burrow/blob/master/docs/install-and-configuration.md#put-burrow-behind-a-reverse-proxy).

## Compatibility

Burrow's live YARN verification uses Hadoop 3.4.3. Spark SQL and DAG routes have also been exercised live with Spark 2.4.8, 3.3.2 and 4.2.0. These are tested versions, not a guarantee for every vendor distribution; see the [verification record](https://github.com/anudeepd/burrow/blob/master/docs/verification.md).

## How it works

Burrow runs locally and connects directly to configured or discovered Hadoop and Spark services; it does not depend on a Burrow-hosted service. By default, its web server listens only on loopback (`127.0.0.1`) and it provides no YARN write operations. See the [architecture overview](https://github.com/anudeepd/burrow/blob/master/docs/architecture.md) for the request path and security details.

## Verification

The parity harness checks REST-field coverage, compares displayed values with the stock YARN UI, and checks that proxied responses preserve upstream bytes. The [verification record](https://github.com/anudeepd/burrow/blob/master/docs/verification.md) includes the latest results, test environment, open limits and reproduction commands. The [parity guide](https://github.com/anudeepd/burrow/blob/master/docs/parity.md) documents the inventory and comparison method.

## Documentation

| For | Read |
|---|---|
| Full feature list | [Feature guide](https://github.com/anudeepd/burrow/blob/master/docs/features.md) |
| Install, configure and connect services | [Installation and configuration](https://github.com/anudeepd/burrow/blob/master/docs/install-and-configuration.md) |
| Architecture and security behavior | [Architecture overview](https://github.com/anudeepd/burrow/blob/master/docs/architecture.md) · [Backend details](https://github.com/anudeepd/burrow/blob/master/docs/architecture-backend.md) |
| Verification and parity | [Verification record](https://github.com/anudeepd/burrow/blob/master/docs/verification.md) · [Parity inventory](https://github.com/anudeepd/burrow/blob/master/docs/parity.md) · [Harness guide](https://github.com/anudeepd/burrow/blob/master/parity/harness/README.md) |
| Build and contribute | [Development guide](https://github.com/anudeepd/burrow/blob/master/docs/development.md) · [Test-cluster guide](https://github.com/anudeepd/burrow/blob/master/cluster/README.md) |
| API and UI contracts | [Backend API](https://github.com/anudeepd/burrow/blob/master/docs/contracts/api.md) · [Parity DOM](https://github.com/anudeepd/burrow/blob/master/docs/contracts/parity-dom.md) |
| Design system | [Design language](https://github.com/anudeepd/burrow/blob/master/DESIGN.md) · [DAG design](https://github.com/anudeepd/burrow/blob/master/docs/design-dag.md) |

## License

MIT. YARN and Spark are trademarks of the Apache Software Foundation. Burrow is an independent project.
