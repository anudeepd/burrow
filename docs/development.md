# Development

Burrow combines a Rust backend, a React/TanStack web UI, and a parity harness for Hadoop YARN. The repository has a local mock API for frontend work and a reproducible Hadoop/Spark test cluster for end-to-end verification.

## Set up the toolchains

```bash
make venv          # Python 3.12 venv with PySpark, maturin and pytest for developer tooling
make web-install   # install frontend dependencies with Bun
```

Python is used for cluster tooling and wheel builds; the installed Burrow executable does not require a Python runtime. Bun is used for frontend development and verification.

## Common commands

```bash
make web-dev       # run the frontend against the mock API; no cluster required
make backend       # build the Rust backend
make test          # Rust workspace tests and web unit tests
make lint          # Clippy, rustfmt check and Biome
make fmt           # format Rust and web sources
make wheel         # build the frontend and a platform wheel
make install-smoke # install a locally built wheel in a throwaway venv and smoke-test it
```

The Python distribution built by `make wheel` is `yarn-burrow`; the installed executable remains `burrow`.

## Release

The GitHub Actions **Burrow CI and Release** workflow (`ci.yml`) runs only when manually dispatched. Every run builds and uploads the web assets, six platform wheels, and parity report as workflow artifacts. Its final cleanup job deletes older completed runs of `ci.yml` and their attached workflow artifacts, retaining the current run and artifacts. Cleanup runs after failures as well as successes, but skips cancelled runs. It does not delete GitHub Releases/assets, tags, source commits, PyPI releases, or runs from other workflows. A CI-only run (`publish=false`) creates temporary artifacts but does not publish a release.

To publish, run **Burrow CI and Release** from the `master` branch, set `publish` to `true`, and select a `bump`:

- `patch` (default): increment the patch component.
- `minor`: increment the minor component and reset patch to zero.
- `major`: increment the major component and reset minor and patch to zero.

After web, Rust, parity, and six-platform wheel checks pass, Actions applies the selected bump, synchronizes `pyproject.toml`, the Cargo workspace manifest and lockfile, and the internal `burrow-core` dependency, then commits that bump to `master` before publishing those exact wheels to GitHub Releases and PyPI. It refuses to reuse an existing release tag. Leave `publish` unchecked for a CI-only run; that run does not change versions or publish.

PyPI publishing uses Trusted Publishing, so no API token is stored in GitHub. Before the first release, configure a pending GitHub Actions publisher in PyPI with owner `anudeepd`, repository `burrow`, workflow file `ci.yml`, environment `pypi`, and project name `yarn-burrow`. The first successful upload creates the PyPI project if that name is available. Configure the GitHub `pypi` environment with the desired reviewer and branch restrictions before publishing.

For full parity acceptance against the test cluster:

```bash
make cluster-up
make cluster-seed
make acceptance
```

The acceptance run builds and serves Burrow, then runs the P1/P2/P3 parity checks. It writes its report under `parity/report/`. See the [test-cluster guide](../cluster/README.md) for topology, commands and scenarios, and the [parity harness guide](../parity/harness/README.md) for individual stages and fixture replay.

## Repository map

| Path | Contents |
|---|---|
| `crates/burrow-core/` | Configuration, upstream clients, cache, YARN/Spark/log routes |
| `crates/burrow/` | CLI, HTTP server and embedded assets |
| `web/` | TanStack Start single-page application |
| `parity/` | REST inventory and differential harness |
| `cluster/` | Test-cluster CLI and PySpark workloads |
| `fixtures/` | Captured YARN and Spark payloads |
| `docs/` | Architecture, verification, design and contracts |

## Contracts and design

Read these before changing data shapes or the frontend/backend boundary:

- [Backend API contract](contracts/api.md): SPA-to-server HTTP and SSE behavior.
- [Parity DOM contract](contracts/parity-dom.md): the `data-yf`/`data-yv` fields read by the comparison harness.
- [Backend architecture](architecture-backend.md): request path, caching, HA and security.
- [Design system](../DESIGN.md) and [DAG design](design-dag.md): visual tokens, motion and graph behavior.
