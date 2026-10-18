// Upstream access with two modes and one code path:
//
//   live    — real HTTP GETs (direct to the RM/NM/SHS, or through burrow for P3)
//   record  — real HTTP GETs, every response written under <dir>/<scenario>/upstream/
//   replay  — responses read back from disk; NO network. Any live attempt throws ReplayMiss.
//
// The recorded unit is the whole response (status, headers, body) keyed by the exact URL, so
// replay reproduces the live run's inputs byte-for-byte and a replay miss is a harness bug
// rather than a silently-skipped fetch.
import fs from "node:fs";
import path from "node:path";
import { sha1short, stableJson } from "./util.mjs";

export class ReplayMiss extends Error {}

export class RecordedMiss extends Error {}

export function scenarioDir(root, scenarioId) {
  return path.join(root, scenarioId);
}

export async function createUpstream(opts) {
  const { mode = "live", fixtureDir, scenarioId, timeoutMs = 20000, log = () => {} } = opts;
  if (mode !== "live" && !fixtureDir) throw new Error(`${mode} mode requires a fixture directory`);
  const dir = fixtureDir ? scenarioDir(fixtureDir, scenarioId) : null;
  const upDir = dir ? path.join(dir, "upstream") : null;
  const indexName = opts.label ? `index-${opts.label}.json` : "index.json";
  const indexPath = upDir ? path.join(upDir, indexName) : null;

  const loaded = new Map(); // url -> entry (+body)
  if (mode === "replay") {
    if (!upDir || !fs.existsSync(upDir)) throw new ReplayMiss(`replay: no recorded upstream directory at ${upDir}`);
    // Keep each recorder isolated. The P3 direct and proxied snapshots deliberately share
    // upstream URLs with the main P1/P2 capture; merging indexes lets a later sorted file
    // silently replace one side and turns a passing live comparison into a false replay diff.
    const files = [indexName].filter((f) => fs.existsSync(path.join(upDir, f)));
    if (!files.length) throw new ReplayMiss(`replay: no recorded upstream index ${indexName} at ${upDir}`);
    for (const f of files) {
      const index = JSON.parse(fs.readFileSync(path.join(upDir, f), "utf8"));
      for (const e of index.entries ?? []) {
        loaded.set(e.url, { ...e, body: fs.readFileSync(path.join(upDir, e.file), "utf8") });
      }
    }
    log(`replay: loaded ${loaded.size} recorded upstream responses from ${files.length} index file(s) in ${path.relative(process.cwd(), upDir)}`);
  }

  const written = new Map(); // url -> entry
  const stats = { live: 0, recorded: 0, replayed: 0, misses: 0 };

  async function get(url, { headers = {}, method = "GET", timeoutMs: t = timeoutMs } = {}) {
    const key = url;
    if (mode === "replay") {
      const hit = loaded.get(key);
      if (!hit) {
        stats.misses++;
        throw new ReplayMiss(
          `replay: ${key} was never recorded (recorded ${loaded.size} urls). ` +
            `Re-run with --record to refresh the fixture set.`
        );
      }
      stats.replayed++;
      return {
        url,
        status: hit.status,
        headers: hit.headers ?? {},
        text: hit.body,
        json: tryJson(hit.body),
        fromReplay: true,
      };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), t);
    let res;
    try {
      res = await fetch(url, { method, headers, signal: ctrl.signal, redirect: "follow" });
    } catch (e) {
      clearTimeout(timer);
      const entry = { url, status: 0, headers: {}, error: String(e?.message ?? e), file: `miss-${sha1short(url)}.json` };
      if (mode === "record") persist(entry, "");
      throw new RecordedMiss(`upstream unreachable: ${url}: ${e?.message ?? e}`);
    }
    const text = await res.text();
    clearTimeout(timer);
    const respHeaders = Object.fromEntries([...res.headers.entries()]);
    stats.live++;
    if (mode === "record") persist({ url, status: res.status, headers: respHeaders, error: null }, text);
    return { url, status: res.status, headers: respHeaders, text, json: tryJson(text), fromReplay: false };
  }

  function persist(entry, body) {
    const tag = opts.label ?? "main";
    const file = entry.file ?? `${tag}-${String(written.size + 1).padStart(4, "0")}-${sha1short(entry.url)}.json`;
    written.set(entry.url, { ...entry, file });
    fs.mkdirSync(upDir, { recursive: true }); // persist() may run before flush() creates the dir
    fs.writeFileSync(path.join(upDir, file), body, "utf8");
  }

  /** Persist the recorded index. Returns the number of entries. */
  function flush() {
    if (mode !== "record") return 0;
    fs.mkdirSync(upDir, { recursive: true });
    const entries = [...written.values()].sort((a, b) => a.url.localeCompare(b.url));
    fs.writeFileSync(
      indexPath,
      `${JSON.stringify({ version: 1, scenario: scenarioId, count: entries.length, digest: sha1short(entries.map((e) => `${e.url}:${e.status}`).join("|")), entries }, null, 1)}\n`
    );
    stats.recorded = entries.length;
    return entries.length;
  }

  return { mode, get, flush, stats, dir: upDir };
}

function tryJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Hard proof that replay performs no network I/O: replace global fetch/XMLHttpRequest-ish entry
 * points with throwing stubs for the duration of the run.
 */
export function installNetworkGuard(onAttempt = () => {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    onAttempt(url);
    throw new Error(`network guard: attempted live fetch of ${url} during offline replay`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readTextIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

export function slug(s) {
  return String(s)
    .replace(/^https?:\/\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 180);
}

export { stableJson };
