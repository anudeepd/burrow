# burrow — developer entry points.
# Everything runs from the repo root. `make help` lists targets.
SHELL := /bin/bash
ROOT  := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
VENV  := $(ROOT)/.venv
PY    := $(VENV)/bin/python
CLUSTER := $(PY) $(ROOT)/cluster/cluster.py

.DEFAULT_GOAL := help
.PHONY: help venv cluster-setup cluster-up cluster-down cluster-status cluster-seed cluster-selftest \
        web-install web-dev web-build web-test web-typecheck web-e2e assets backend run test lint \
        parity parity-record wheel install-smoke clean fmt

help: ## show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

venv: ## create the project venv (python 3.12) and install dev tooling
	uv venv --python 3.12 $(VENV)
	uv pip install --python $(PY) pyspark==4.2.0 maturin pytest

# ---------------------------------------------------------------- test cluster
cluster-setup: ## render Hadoop/Spark configs for the local test cluster
	$(CLUSTER) setup
cluster-up: ## start RM + 3 NodeManagers + JobHistory + Spark History
	$(CLUSTER) up
cluster-down: ## stop the test cluster
	$(CLUSTER) down
cluster-status: ## JSON status of the test cluster
	$(CLUSTER) status
cluster-seed: ## submit the scenario matrix (running/failed/killed/pending/multi-attempt/...)
	$(CLUSTER) scenario seed
cluster-selftest: ## assert the cluster is healthy and end-to-end capable
	$(PY) $(ROOT)/cluster/selftest.py

# ---------------------------------------------------------------------- web
web-install: ## install web dependencies (bun)
	cd $(ROOT)/web && bun install
web-dev: ## run the SPA dev server against the dev mock API
	cd $(ROOT)/web && bun run dev:mock
web-build: ## production build of the SPA (web/dist/client)
	cd $(ROOT)/web && bun run build
web-typecheck:
	cd $(ROOT)/web && bun run typecheck
web-test:
	cd $(ROOT)/web && bun run test
web-e2e:
	cd $(ROOT)/web && bun run e2e

# ------------------------------------------------------------------ backend
backend: ## debug build of the Rust binary
	cargo build -p burrow
assets: web-build ## copy the built SPA into the crate for embedding
	rm -rf $(ROOT)/crates/burrow/assets
	mkdir -p $(ROOT)/crates/burrow/assets
	cp -r $(ROOT)/web/dist/client/. $(ROOT)/crates/burrow/assets/
	touch $(ROOT)/crates/burrow/assets/.gitkeep
run: assets ## build everything and serve against the local test cluster
	cargo run -p burrow -- serve \
		--rm http://127.0.0.1:8088 \
		--spark-history http://127.0.0.1:18080 \
		--jhs http://127.0.0.1:19888

# --------------------------------------------------------------------- tests
test: ## rust + web unit tests
	cargo test --workspace
	$(MAKE) web-test
lint:
	cargo clippy --workspace --all-targets -- -D warnings
	cargo fmt --all -- --check
	cd $(ROOT)/web && bun run lint
fmt:
	cargo fmt --all
	cd $(ROOT)/web && bun run format

# -------------------------------------------------------------------- parity
acceptance: ## build everything and run the full end-to-end acceptance (parity harness vs live cluster)
	bash scripts/acceptance.sh
parity: ## run the differential parity harness against the live cluster (requires a built wheel/serve)
	cd $(ROOT)/parity/harness && bun install && bun run parity
parity-record: ## record fixtures for offline replay
	cd $(ROOT)/parity/harness && bun run parity --record

# ----------------------------------------------------------------- packaging
wheel: assets ## build the pip wheel containing the binary + embedded SPA
	$(VENV)/bin/maturin build --release --manifest-path $(ROOT)/crates/burrow/Cargo.toml -o $(ROOT)/dist
install-smoke: wheel ## install the wheel into a throwaway venv and smoke-test it
	rm -rf /tmp/burrow-smoke && uv venv --python 3.12 /tmp/burrow-smoke
	uv pip install --python /tmp/burrow-smoke/bin/python $(ROOT)/dist/*.whl
	/tmp/burrow-smoke/bin/burrow --version
	/tmp/burrow-smoke/bin/burrow doctor --rm http://127.0.0.1:8088

clean:
	cargo clean
	rm -rf $(ROOT)/web/dist $(ROOT)/dist
