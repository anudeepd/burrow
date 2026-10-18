/**
 * `bun run preview` — serve the built SPA (`dist/client`) plus the dev mock API from ONE origin, exactly like the Rust
 * backend does (contract §7: `_shell.html` fallback for unknown paths, immutable hashed assets, `/api/*` API).
 *
 *   bun run build && bun run preview        # http://127.0.0.1:5273
 */
import { startMockServer } from "../dev/mock-api.ts";

const port = Number(process.env.PORT ?? 5273);
const root = new URL("../dist/client", import.meta.url).pathname;

if (!(await Bun.file(`${root}/_shell.html`).exists())) {
  console.error(`[preview] no build at ${root} — run \`bun run build\` first`);
  process.exit(1);
}

const server = startMockServer({ port, webRoot: root });
console.log(`[preview] serving ${root} + mock API on http://127.0.0.1:${server.port}`);
