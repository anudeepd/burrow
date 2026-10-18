#!/usr/bin/env bun
/**
 * Bundle budget gate (PLAN §5): the *initial* JS a user must download before
 * the shell is interactive must stay ≤ 300 KB gzipped. Lazy route chunks are
 * reported separately and are not part of the budget.
 *
 * Usage: bun run scripts/check-bundle-budget.ts [distDir]
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const BUDGET_BYTES = 300 * 1024;
const dist = resolve(process.argv[2] ?? "dist/client");
const assetsDir = join(dist, "assets");
const shellPath = join(dist, "_shell.html");

const gz = (p: string) => gzipSync(readFileSync(p), { level: 9 }).length;

let shell: string;
try {
  shell = readFileSync(shellPath, "utf8");
} catch {
  console.error(`✗ no SPA shell at ${shellPath} — run \`bun run build\` first`);
  process.exit(2);
}

// Assets referenced by the shell are eager; everything else is lazy.
const referenced = new Set<string>();
for (const m of shell.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
  const url = m[1]!;
  const name = url.split("/").pop()!;
  referenced.add(name);
}

const all = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
if (all.length === 0) {
  console.error("✗ no JS assets found — build is empty");
  process.exit(2);
}

const rows = all.map((name) => ({ name, eager: referenced.has(name), size: gz(join(assetsDir, name)) })).sort((a, b) => b.size - a.size);

const eager = rows.filter((r) => r.eager).reduce((n, r) => n + r.size, 0);
const lazy = rows.filter((r) => !r.eager).reduce((n, r) => n + r.size, 0);

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB gz`;
console.log(`initial JS  ${kb(eager)} / budget ${kb(BUDGET_BYTES)}`);
for (const r of rows.filter((x) => x.eager).sort((a, b) => b.size - a.size)) {
  console.log(`   eager  ${r.name}  ${kb(r.size)}`);
}
console.log(`lazy JS     ${kb(lazy)} across ${rows.length - rows.filter((r) => r.eager).length} chunks`);
const biggestLazy = rows
  .filter((r) => !r.eager)
  .slice(0, 5)
  .map((r) => `${r.name} ${kb(r.size)}`)
  .join(", ");
if (biggestLazy) console.log(`   largest lazy: ${biggestLazy}`);

if (eager > BUDGET_BYTES) {
  console.error(`✗ initial JS exceeds the budget by ${kb(eager - BUDGET_BYTES)}`);
  process.exit(1);
}
console.log("✓ within budget");
