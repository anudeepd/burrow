# Installation and configuration

## Install and start

Once `yarn-burrow` is published on PyPI, install it with:

```bash
pip install yarn-burrow
burrow doctor
burrow
```

The server listens at `http://127.0.0.1:8787` by default and opens that address in your browser. Use `burrow --no-open` to start without opening a browser. Python, Node.js, Bun and Java are not runtime dependencies; the wheel contains the executable and web UI.

> **Package name:** the PyPI project is `yarn-burrow`; the installed command is `burrow`. The separate public PyPI project named [`burrow`](https://pypi.org/project/burrow/) is an unrelated Nest Mobile API client.

## Start with explicit service endpoints

Pass each service's base URL with its scheme and port. This example sets a local bind address, an explicit port, a two-node ResourceManager HA pair, and multiple JobHistory and Spark History candidates:

```bash
burrow serve \
  --bind 127.0.0.1 \
  --port 8787 \
  --rm http://rm1.example.net:8088 \
  --rm http://rm2.example.net:8088 \
  --jhs http://jhs1.example.net:19888 \
  --jhs http://jhs2.example.net:19888 \
  --spark-history http://shs1.example.net:18080 \
  --spark-history http://shs2.example.net:18080 \
  --no-open
```

- `--bind` is the local IP address Burrow listens on; it is not a public DNS name or reverse-proxy URL. It defaults to `127.0.0.1`, which accepts connections from the same machine only. Use `--bind 0.0.0.0` only when Burrow should listen on every network interface.
- `--port` is the local listening port and defaults to `8787`.
- Repeat `--rm` for each ResourceManager in the order listed by `yarn.resourcemanager.ha.rm-ids`. You can also pass comma-separated URLs to one `--rm` option.
- Repeat `--jhs` and `--spark-history` for additional JobHistory and Spark History endpoints, or comma-separate the URLs. Burrow can also discover these endpoints from Hadoop/Spark configuration and the live ResourceManager; discovered runtime endpoints that are not already listed may be appended.
- `--no-open` is useful when starting Burrow as a service or behind a proxy.

`burrow doctor` shows the configured and discovered service endpoints and probes whether they can be reached.

## Put Burrow behind a reverse proxy

For a root-mounted proxy, the browser-facing URL belongs to the proxy configuration. For example:

```text
Public URL:  https://burrow.example.net/
Proxy target: http://127.0.0.1:8787/
```

Start Burrow on loopback and allow the public host if the proxy forwards the original `Host` header:

```bash
burrow serve \
  --bind 127.0.0.1 \
  --port 8787 \
  --allowed-host burrow.example.net \
  --rm http://rm1.example.net:8088 \
  --rm http://rm2.example.net:8088 \
  --jhs http://jhs.example.net:19888 \
  --spark-history http://shs.example.net:18080 \
  --no-open
```

Configure the proxy to forward requests for `https://burrow.example.net/` to `http://127.0.0.1:8787/`. If it rewrites the `Host` header to the local upstream address, `--allowed-host` is not needed. If Burrow runs in a different container or host from the proxy, bind to an address reachable from that proxy instead of loopback, and restrict network access at the host or network layer. The proxy should allow long-lived responses from `/api/events` for live updates.

`--allowed-host` checks which HTTP `Host` values Burrow accepts; it does not authenticate users. TLS termination and access control must be configured at the reverse proxy or network layer.

The packaged UI currently expects to be served from the site root. Although `--base-path /prefix` makes the backend route under a prefix, the embedded UI uses root-based routes and `/api` URLs, so setting `--base-path` alone does not make the packaged app work at a URL such as `https://example.net/burrow/`. Use a root-mounted proxy for the packaged wheel. A custom UI supplied with `--assets-dir` must be built with the matching base path to use a prefix.

## Use a TOML configuration file

The same settings can go in a TOML file:

```toml
bind = "127.0.0.1"
port = 8787
rm = ["http://rm1.example.net:8088", "http://rm2.example.net:8088"]
jhs = ["http://jhs1.example.net:19888", "http://jhs2.example.net:19888"]
spark_history = ["http://shs1.example.net:18080", "http://shs2.example.net:18080"]
allowed_hosts = ["burrow.example.net"]
no_open = true
```

Start with `burrow serve --config burrow.toml`. Command-line flags override environment variables, which override values from the TOML file. Hadoop and Spark discovery supplies values that were not explicitly configured, followed by built-in defaults.

## Hadoop and Spark discovery

Burrow reads client configuration from `HADOOP_CONF_DIR`, `YARN_CONF_DIR` or `/etc/hadoop/conf`, including `yarn-site.xml`, `core-site.xml`, `mapred-site.xml` and `spark-defaults.conf` when present. It uses settings such as:

- `yarn.resourcemanager.webapp.address` and HA `rm-ids`;
- `yarn.http.policy`;
- `yarn.log.server.url` for aggregated logs;
- `spark.yarn.historyServer.address`.

If no ResourceManager is configured or discovered, Burrow falls back to `http://localhost:8088`. At startup, it also reads effective configuration from the active ResourceManager and can discover JobHistory and Spark History endpoints. Tracking links from finished applications are suggestions only; when a link goes through the ResourceManager web proxy, Burrow inspects the redirect but does not follow or contact its destination.

## Other useful options

| Option | Purpose |
|---|---|
| `--timeline URL` | Set the YARN Timeline Service endpoint. |
| `--user NAME` | Send Hadoop simple-auth `user.name` to upstream services. |
| `--header 'Name: value'` | Add an upstream request header; repeat for multiple headers. |
| `--token TOKEN` | Send a bearer token to upstream services. |
| `--ca-cert FILE` | Trust an additional CA bundle for upstream TLS. |
| `--insecure` | Skip upstream TLS certificate verification; intended for development only. |
| `--assets-dir DIR` | Serve a custom web UI directory instead of the embedded assets. |
| `--config FILE` | Load settings from a TOML configuration file. |

The corresponding environment variables use the `BURROW_` prefix, such as `BURROW_BIND`, `BURROW_PORT`, `BURROW_RM`, `BURROW_JHS` and `BURROW_SPARK_HISTORY`. Run `burrow --help` for the complete list.

## Packaging notes

Wheels are built with [maturin](https://www.maturin.rs) using binary bindings. Each platform wheel carries the executable; release builds embed the built web UI with Brotli and gzip sidecars. Bun is used to build and verify the frontend, not to run the installed application.

The project metadata names the distribution `yarn-burrow`; the installed executable remains `burrow`. This avoids the unrelated public PyPI project named `burrow`. Confirm that `yarn-burrow` is available before publishing a public release.
