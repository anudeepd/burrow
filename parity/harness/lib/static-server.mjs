#!/usr/bin/env bun
// Minimal static server + `/api` passthrough used ONLY by the parity harness when the Rust
// backend is not running (`run.mjs --ours-serve`). It serves web/dist/client with the SPA shell
// fallback and maps the contract's passthrough paths onto the live RM/NM/SHS so the harness can
// exercise the *real* SPA. It is a harness convenience, never a release artifact — `burrow`
// itself is the Rust binary and is what P3 tests.
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export function createStaticServer({ root, rm, nm, shs, port = 0, log = () => {} }) {
  const rootAbs = path.resolve(root);
  const shell = path.join(rootAbs, "_shell.html");

  const upstreamFor = (url) => {
    const p = url.pathname;
    if (p.startsWith("/api/yarn/")) return { base: rm, tail: `/ws/v1/cluster/${p.slice("/api/yarn/".length)}` };
    if (p.startsWith("/api/nm/")) {
      const m = p.slice("/api/nm/".length).match(/^([^/]+)\/(.*)$/);
      if (!m) return null;
      const target = (nm ?? []).find((x) => x.host === m[1] || `${x.host}:${x.port}` === m[1] || x.webapp?.includes(m[1]));
      return { base: target?.webapp ?? `http://${m[1]}`, tail: `/ws/v1/node/${m[2]}` };
    }
    if (p.startsWith("/api/rm/")) return { base: rm, tail: `/${p.slice("/api/rm/".length)}` };
    if (p.startsWith("/api/spark-history/")) return { base: shs, tail: `/${p.slice("/api/spark-history/".length)}` };
    return null;
  };

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        const up = upstreamFor(url);
        if (!up) return new Response(JSON.stringify({ error: { code: "not_found", message: `${url.pathname} not mapped by the parity static server` } }), { status: 404, headers: { "content-type": "application/json" } });
        const target = `${up.base.replace(/\/+$/, "")}${up.tail}${url.search}`;
        try {
          const res = await fetch(target, {
            headers: { accept: req.headers.get("accept") ?? "application/json", "cache-control": req.headers.get("cache-control") ?? "no-cache" },
          });
          const body = await res.arrayBuffer();
          return new Response(body, {
            status: res.status,
            headers: {
              "content-type": res.headers.get("content-type") ?? "application/json",
              // deliberately NOT x-ys-api: P3 must only ever certify the real burrow binary
              "x-parity-static-server": "1",
            },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: { code: "upstream_unreachable", message: String(e?.message ?? e) } }), { status: 502, headers: { "content-type": "application/json" } });
        }
      }
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const candidate = path.join(rootAbs, rel);
      if (candidate.startsWith(rootAbs) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return new Response(fs.readFileSync(candidate), { headers: { "content-type": MIME[path.extname(candidate)] ?? "application/octet-stream" } });
      }
      if (fs.existsSync(shell)) {
        return new Response(fs.readFileSync(shell), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("<html><body>no shell.html in dist (run `bun run build` in web/)</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  log(`parity static server on http://127.0.0.1:${server.port} serving ${rootAbs} (rm=${rm})`);
  return server;
}

if (import.meta.main) {
  let argv = { root: "web/dist/client", rm: "http://127.0.0.1:8088", port: "8899" };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) argv[a[i].slice(2)] = a[i + 1];
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  createStaticServer({
    root: path.resolve(repoRoot, argv.root),
    rm: argv.rm,
    shs: argv.shs ?? "http://127.0.0.1:18080",
    nm: [],
    port: Number(argv.port),
    log: console.log,
  });
}
