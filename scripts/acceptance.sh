#!/usr/bin/env bash
# burrow — end-to-end acceptance run (PLAN.md §8/§10).
#
# Builds the SPA, embeds it in the release binary, serves it against the LIVE test cluster, then runs
# the parity harness (P1 REST-key coverage, P2 differential legacy-vs-ours, P3 wire fidelity) and
# leaves the report on disk. Nothing is committed or uploaded.
#
#   scripts/acceptance.sh                 # full run against 127.0.0.1:8088
#   PORT=8899 scripts/acceptance.sh       # different port
#   SKIP_BUILD=1 scripts/acceptance.sh    # reuse the current web/dist + target/release binary
#   STAGES=p2 scripts/acceptance.sh       # a subset of the proofs
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
STAGES="${STAGES:-p1,p2,p3}"
SKIP_BUILD="${SKIP_BUILD:-0}"
CONF="${HADOOP_CONF_DIR:-$ROOT/.cluster/state/conf}"
LOG="${TMPDIR:-/tmp}/burrow-acceptance.log"
REPORT="$ROOT/parity/report"

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v bun >/dev/null || die "bun is required"
command -v cargo >/dev/null || die "cargo is required"
[ -f "$ROOT/.cluster/endpoints.json" ] || die "no test cluster: run 'make cluster-up' first"
[ -f "$CONF/yarn-site.xml" ] || die "no Hadoop conf at $CONF"

if [ "$SKIP_BUILD" != "1" ]; then
  say "building the SPA (web/)"
  (cd web && bun run build)
  say "checking the bundle budget"
  (cd web && bun run scripts/check-bundle-budget.ts)
  say "staging the SPA into the crate"
  rm -rf crates/burrow/assets && mkdir -p crates/burrow/assets
  cp -r web/dist/client/. crates/burrow/assets/
  touch crates/burrow/assets/.gitkeep
  say "building the release binary"
  cargo build --release -p burrow
fi

BIN="$ROOT/target/release/burrow"
[ -x "$BIN" ] || die "missing $BIN"

if ! "$ROOT/.venv/bin/python" - "$PORT" <<'PYPORT'
import socket, sys
with socket.socket() as sock:
    try:
        sock.bind(("127.0.0.1", int(sys.argv[1])))
    except OSError:
        sys.exit(1)
PYPORT
then
  die "port $PORT is occupied; choose an unused PORT (for example PORT=8899 scripts/acceptance.sh)"
fi

say "starting the server on 127.0.0.1:$PORT (log: $LOG)"
HADOOP_CONF_DIR="$CONF" SPARK_CONF_DIR="$ROOT/.cluster/state/spark-conf" \
  setsid "$BIN" --no-open --port "$PORT" \
    --spark-history http://127.0.0.1:18080 --jhs http://127.0.0.1:19888 \
    >"$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -20 "$LOG"; die "server exited before becoming healthy"; }
  if curl -sf "http://127.0.0.1:$PORT/api/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -sf "http://127.0.0.1:$PORT/api/healthz" >/dev/null || { tail -20 "$LOG"; die "server did not become healthy"; }
say "server is healthy — $(curl -sS "http://127.0.0.1:$PORT/api/meta" | "$ROOT/.venv/bin/python" -c 'import json,sys; m=json.load(sys.stdin); print("RM", m["rm"]["active"], "· features", ",".join(k for k,v in m["features"].items() if v))')"

say "running the parity harness (stages: $STAGES)"
(cd parity/harness && bun install --frozen-lockfile >/dev/null && bun run parity --ours "http://127.0.0.1:$PORT" --stages "$STAGES" --report "$REPORT")

say "acceptance finished"
echo "  report   : $REPORT/index.html"
echo "  summary  : $REPORT/summary.json"
echo "  coverage : $REPORT/coverage.json"
echo "  server   : still running on http://127.0.0.1:$PORT (Ctrl-C to stop)"
wait "$SERVER_PID"
