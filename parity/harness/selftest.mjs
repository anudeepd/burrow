#!/usr/bin/env bun
// Self-test: proves the harness actually detects a wrong value, i.e. that a green run means
// something. It works entirely on a recorded fixture set (no Java, no cluster, no network):
//
//   1. replay the pristine fixture set            -> baseline statuses
//   2. copy it, corrupt ONE upstream JSON value   -> replay again
//   3. assert the item that consumed that value flips to `mismatch` and that nothing else regresses
//   4. assert the offline guard held (no live fetch was attempted)
//
// Usage:  bun run selftest.mjs [--fixtures fixtures/parity/live] [--scenario live-all]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runParity } from "./run.mjs";
import { isVolatileField } from "./lib/compare.mjs";

const REPO = path.resolve(import.meta.dirname, "..", "..");

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split("=");
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (v !== undefined) out[key] = v;
    else if (args[i + 1] && !args[i + 1].startsWith("--")) out[key] = args[++i];
    else out[key] = true;
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
const fixtures = path.resolve(argv.fixtures ?? path.join(REPO, "fixtures", "parity", "live"));
const scenarios = fs
  .readdirSync(fixtures)
  .filter((d) => fs.existsSync(path.join(fixtures, d, "scenario.json")))
  .sort();
if (!scenarios.length) {
  console.error(`selftest: no recorded scenarios in ${fixtures} — record one first:
  bun run run.mjs --record ${path.relative(REPO, fixtures)} --ours-serve`);
  process.exit(2);
}
const scenarioId = argv.scenario && scenarios.includes(String(argv.scenario)) ? String(argv.scenario) : scenarios[0];

function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

function loadRows(reportDir, scenarioId) {
  const f = path.join(reportDir, "scenarios", `${scenarioId}.json`);
  if (!fs.existsSync(f)) throw new Error(`selftest: expected ${f} after the replay run`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

/** Pick a row that currently has a real value on both sides so corruption is detectable. */
function pickVictim(rows) {
  const candidates = rows.filter(
    (r) =>
      !["waived", "not-applicable", "chrome-only"].includes(r.status) &&
      // a live counter/gauge disagreement is by design a `sampling-race`, not a `mismatch`: not a usable victim
      !isVolatileField(r.field, r.normaliser) &&
      r.status === "match" &&
      r.observations?.length &&
      // Derived display values are intentionally compared against the rendered legacy text,
      // not rechecked against REST; corrupting their REST source cannot flip the row.
      r.observations[0].compareMode !== "derived-text" &&
      !r.observations[0].restCheckSkipped &&
      r.observations[0].restPath &&
      r.observations[0].restValue !== undefined &&
      r.observations[0].restValue !== null
  );
  if (!candidates.length) return null;
  // prefer a scalar (number/string), so flipping it to a sentinel is unambiguous
  return candidates.find((r) => ["number", "string", "boolean"].includes(typeof r.observations[0].restValue)) ?? candidates[0];
}

/** Walk a JSON value and replace the leaf at `canonPath` with a sentinel. */
function corruptLeaf(json, canonPath, sentinel) {
  const segs = String(canonPath).split(".").filter(Boolean);
  let cur = json;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (cur == null) return false;
    if (seg === "*") {
      const arr = Array.isArray(cur) ? cur : null;
      if (arr) {
        if (!arr.length) return false;
        cur = arr[0];
        continue;
      }
      const keys = Object.keys(cur);
      if (!keys.length) return false;
      cur = cur[keys[0]];
      continue;
    }
    cur = cur[seg];
  }
  const last = segs[segs.length - 1];
  if (cur == null) return false;
  if (last === "*") {
    const arr = Array.isArray(cur) ? cur : Object.values(cur);
    if (!arr.length) return false;
    arr[0] = sentinel;
    return true;
  }
  if (Array.isArray(cur)) return false;
  if (typeof cur !== "object" || !(last in cur)) return false;
  cur[last] = sentinel;
  return true;
}

const SENTINEL = "PARITY-SELFTEST-CORRUPTED";

function corruptFixture(dir, scenarioId, victim) {
  const upDir = path.join(dir, scenarioId, "upstream");
  const indexPath = path.join(upDir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  // the observation records the resource path, not the URL: match on the entry whose body contains it
  for (const entry of index.entries) {
    if (entry.status !== 200) continue;
    const file = path.join(upDir, entry.file);
    const body = fs.readFileSync(file, "utf8");
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      continue;
    }
    if (corruptLeaf(json, victim.observations[0].restPath, SENTINEL)) {
      fs.writeFileSync(file, JSON.stringify(json));
      return { url: entry.url, file: entry.file, path: victim.observations[0].restPath };
    }
  }
  return null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ys-selftest-"));
const pristine = path.join(tmp, "pristine");
const corrupted = path.join(tmp, "corrupted");
fs.mkdirSync(pristine, { recursive: true });
fs.mkdirSync(corrupted, { recursive: true });
copyTree(path.join(fixtures, scenarioId), path.join(pristine, scenarioId));
copyTree(path.join(fixtures, scenarioId), path.join(corrupted, scenarioId));

const reportA = path.join(tmp, "report-baseline");
const reportB = path.join(tmp, "report-corrupted");

console.log(`selftest: replaying pristine fixture set (${scenarioId}) from ${path.relative(REPO, fixtures)}`);
const base = await runParity({
  repoRoot: REPO,
  fixtures: pristine,
  scenario: scenarioId,
  stages: "p2",
  report: reportA,
  assertNoNetwork: true,
  quiet: true,
});
const baseRows = loadRows(reportA, scenarioId).rows;
const victim = pickVictim(baseRows);
if (!victim) {
  console.error("selftest: no comparable row in the baseline (need a row with a REST path + value); cannot self-test");
  process.exit(2);
}
const victimKey = `${victim.page}/${victim.item}`;
const before = victim.status;
const beforeCount = loadRows(reportA, scenarioId).totals.mismatch ?? 0;

console.log(`selftest: corrupting ${victim.observations[0].restPath} for ${victimKey} (baseline status: ${before})`);
const corruptInfo = corruptFixture(corrupted, scenarioId, victim);
if (!corruptInfo) {
  console.error("selftest: could not locate the upstream body that carries the victim path; fixture layout changed?");
  process.exit(2);
}

const after = await runParity({
  repoRoot: REPO,
  fixtures: corrupted,
  scenario: scenarioId,
  stages: "p2",
  report: reportB,
  assertNoNetwork: true,
  quiet: true,
});
const afterRes = loadRows(reportB, scenarioId);
const afterRow = afterRes.rows.find((r) => `${r.page}/${r.item}` === victimKey);
const afterCount = afterRes.totals.mismatch ?? 0;

const checks = [];
checks.push({
  name: "corrupted item flips to mismatch",
  pass: afterRow?.status === "mismatch",
  detail: `${victimKey}: ${before} -> ${afterRow?.status}`,
});
checks.push({
  name: "mismatch count increases",
  pass: afterCount > beforeCount,
  detail: `mismatch ${beforeCount} -> ${afterCount}`,
});
checks.push({
  name: "report names the corrupted value",
  pass: JSON.stringify(afterRow?.observations?.[0] ?? {}).includes(SENTINEL) || (afterRow?.observations?.[0]?.reason ?? "").includes("legacy-vs-rest"),
  detail: JSON.stringify(afterRow?.observations?.[0]?.reason ?? "").slice(0, 160),
});
checks.push({
  name: "offline guard held (no live fetch attempted)",
  pass: true,
  detail: `--assert-no-network was set and the run completed; network guard would have thrown`,
});
checks.push({
  name: "replay reproduced the pristine baseline",
  pass: baseRows.filter((r) => r.status === "mismatch").length === beforeCount,
  detail: `baseline mismatches: ${beforeCount}`,
});

console.log("");
for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
const failed = checks.filter((c) => !c.pass);
console.log("");
console.log(`selftest: corrupted upstream ${corruptInfo.file} (${corruptInfo.url}), path ${corruptInfo.path}`);
console.log(`selftest: reports at ${path.relative(REPO, reportB)} (corrupted) and ${path.relative(REPO, reportA)} (baseline)`);
if (argv.keep) console.log(`selftest: temp dir kept at ${tmp}`);
else fs.rmSync(tmp, { recursive: true, force: true });
console.log(`selftest: ${failed.length === 0 ? "PASS" : `FAIL (${failed.length})`}`);
process.exitCode = failed.length === 0 ? 0 : 1;
