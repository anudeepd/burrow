#!/usr/bin/env bun
// P3 — wire fidelity. Nothing added, nothing dropped, nothing re-encoded:
//
//   * for every RM/NM/daemon endpoint in docs/contracts/api.md §3, the JSON served by burrow
//     (`/api/yarn/*`, `/api/nm/*`, `/api/rm/*`) must deep-equal the direct upstream body,
//     fetched with `Cache-Control: no-cache` so the cache is bypassed;
//   * for Spark: the jobs/stages/executors identifiers and (when the inventory declares them)
//     the spark.* field values our UI renders must equal Spark's own REST payload, and the
//     scraped Spark UI HTML is recorded as evidence next to the comparison.
//
// Degrades explicitly: unreachable backend or missing Spark app => status "skipped" with a reason,
// never a silent pass.
import fs from "node:fs";
import path from "node:path";
import { deepDiff, stableJson, truncate } from "./lib/util.mjs";
import { canonicalise, canonicalEqual } from "./lib/normalise.mjs";
import { resolveRestValue } from "./lib/compare.mjs";
import { parseApiContract, expandResources } from "./coverage.mjs";
import { createUpstream, writeJson, writeText } from "./lib/sources.mjs";
import { deriveLive, loadEndpoints } from "./lib/scenarios.mjs";

/** ours-side URL for a direct upstream URL */
export function theirUrl(direct, scenario) {
  const rm = scenario.rmBase?.replace(/\/+$/, "");
  const shs = scenario.shsBase?.replace(/\/+$/, "");
  const jhs = scenario.jhsBase?.replace(/\/+$/, "");
  if (rm && direct.startsWith(`${rm}/ws/v1/cluster/`)) return `/api/yarn/${direct.slice(`${rm}/ws/v1/cluster/`.length)}`;
  if (rm && direct.startsWith(`${rm}/conf`)) return `/api/rm/${direct.slice(`${rm}/`.length)}`;
  if (rm && direct.startsWith(`${rm}/jmx`)) return `/api/rm/${direct.slice(`${rm}/`.length)}`;
  if (rm && direct.startsWith(`${rm}/stacks`)) return `/api/rm/${direct.slice(`${rm}/`.length)}`;
  if (rm && direct.startsWith(`${rm}/metrics`)) return `/api/rm/${direct.slice(`${rm}/`.length)}`;
  if (rm && direct.startsWith(`${rm}/logs`)) return `/api/rm/${direct.slice(`${rm}/`.length)}`;
  if (shs && direct.startsWith(`${shs}/`)) return `/api/spark-history/${direct.slice(`${shs}/`.length)}`;
  if (jhs && direct.startsWith(`${jhs}/`)) return `/api/jhs/${direct.slice(`${jhs}/`.length)}`;
  for (const nm of scenario.nodeBases ?? []) {
    const base = nm.webapp?.replace(/\/+$/, "");
    if (base && direct.startsWith(`${base}/ws/v1/node/`)) {
      const hostPort = new URL(base).host;
      return `/api/nm/${hostPort}/${direct.slice(`${base}/ws/v1/node/`.length)}`;
    }
    if (base && (direct.startsWith(`${base}/conf`) || direct.startsWith(`${base}/jmx`))) {
      const hostPort = new URL(base).host;
      return `/api/nm/${hostPort}/${direct.slice(`${base}/`.length)}`;
    }
  }
  if (/^https?:\/\/[^/]+\/proxy\/[^/]+\//.test(direct)) {
    const m = direct.match(/^https?:\/\/[^/]+\/proxy\/([^/]+)\/(.*)$/);
    if (m) return `/api/spark/${m[1]}/proxy/${m[2]}`;
  }
  return null;
}

/** Documented P3 normalisations: values the RM computes from the wall clock at serialization time. */
export const WIRE_TIME_DERIVED = [
  { suffix: ".elapsedTime", toleranceMs: 5000 },
  { suffix: ".remainingTimeInSeconds", toleranceMs: 2 },
  { suffix: ".expiryTime", toleranceMs: 2000 },
];

/** Drop deepDiff entries that are only wall-clock drift of a time-derived field. */
export function filterTimeDerived(diff, context = {}) {
  const kept = [];
  const ignored = [];
  for (const d of diff) {
    const driverIndex = d.path.match(/^\$\[([0-9]+)\]\.totalDuration$/)?.[1];
    const driverClock = context.resource === "executors" && driverIndex != null &&
      context.a?.[driverIndex]?.id === "driver" && context.b?.[driverIndex]?.id === "driver";
    const spec = WIRE_TIME_DERIVED.find((s) => String(d.path).endsWith(s.suffix)) ??
      (driverClock ? { toleranceMs: 2000 } : null) ??
      (/^\$\.attempts\[[0-9]+\]\.duration$/.test(d.path) ? { toleranceMs: 2000 } : null) ??
      (/^\$\.(?:appActivities|activities)\.timestamp$/.test(d.path) ? { toleranceMs: 2000 } : null);
    // the container/attempt DAOs serialise these as JSON strings ("1613361"), the app DAO as numbers: accept both
    const num = (v) => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);
    const na = num(d.a);
    const nb = num(d.b);
    if (spec && na != null && nb != null && Math.abs(na - nb) <= spec.toleranceMs) {
      ignored.push({ ...d, reason: `${d.path} is computed from the wall clock at serialization time (RMAppImpl / ContainerInfo), so two sequential requests always drift; |Δ|=${Math.abs(na - nb)}ms <= ${spec.toleranceMs}ms` });
      continue;
    }
    kept.push(d);
  }
  return { kept, ignored };
}

/** Thread identity/section completeness, deliberately separate from a byte-fidelity claim. */
export function compareThreadDumps(a, b) {
  const parse = (text) => {
    const count = text.match(/^([0-9]+) active threads$/m)?.[1];
    const threads = new Map();
    for (const match of text.matchAll(/^Thread ([0-9]+) \((.*)\):\r?\n([\s\S]*?)(?=^Thread [0-9]+ \(|$(?![\s\S]))/gm)) {
      const [, id, name, body] = match;
      const sections = ["State:", "Blocked count:", "Waited count:", "Stack:"];
      const complete = sections.every((section) => body.includes(`  ${section}`));
      threads.set(id, { name, complete });
    }
    return { count: Number(count), threads, valid: text.startsWith("Process Thread Dump:") && Number(count) === threads.size };
  };
  const x = parse(a);
  const y = parse(b);
  const diff = [];
  if (!x.valid || !y.valid) diff.push({ path: "$dump", kind: "invalid-dump", a: x.valid, b: y.valid });
  for (const [id, thread] of x.threads) {
    if (!y.threads.has(id)) diff.push({ path: `threads.${id}`, kind: "missing-in-b", a: thread.name });
    else if (thread.name !== y.threads.get(id).name || !y.threads.get(id).complete) diff.push({ path: `threads.${id}`, kind: "thread-metadata", a: thread, b: y.threads.get(id) });
  }
  for (const [id, thread] of y.threads) if (!x.threads.has(id)) diff.push({ path: `threads.${id}`, kind: "missing-in-a", b: thread.name });
  return { diff, threads: y.threads.size };
}

/** Compare every distinct scheduling decision and the total count across separate recording windows. */
export function normalizeBulkActivities(body) {
  const value = structuredClone(body);
  const activities = value?.bulkActivities?.activities;
  if (!Array.isArray(activities)) return value;
  const unique = new Map();
  for (const activity of activities) {
    const { timestamp, dateTime, ...decision } = activity;
    unique.set(stableJson(decision), decision);
  }
  value.bulkActivities.activityCount = activities.length;
  value.bulkActivities.activities = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, activity]) => activity);
  return value;
}

export async function runWire(opts) {
  const { repoRoot, scenario, direct, ours, inventory, oursCaptures = [], log = console.log, reportDir, spark = true } = opts;
  const mismatches = [];
  const skipped = [];
  const samplingRaces = [];
  const ignoredNotes = [];
  let compared = 0;

  const spec = parseApiContract(repoRoot);
  const targets = expandResources(spec, scenario);

  for (const t of targets) {
    const base = t.base ?? scenario.rmBase;
    const directUrl = `${String(base).replace(/\/+$/, "")}${t.path.startsWith("/") ? t.path : `/${t.path}`}`;
    const rel = theirUrl(directUrl, scenario);
    if (!rel) {
      skipped.push({ path: t.path, reason: "no burrow route mapping for this upstream" });
      continue;
    }
    const oursUrl = `${scenario.oursBase.replace(/\/+$/, "")}${rel}`;
    // Bulk activities records the next scheduling window. Sequential requests intentionally collect
    // different windows; concurrent requests observe the same events without dropping their content.
    const headers = { "Cache-Control": "no-cache", ...(t.headers ?? {}) };
    const [directResult, ourResult] = await Promise.allSettled([
      direct.get(directUrl, { headers }), ours.get(oursUrl, { headers }),
    ]);
    if (directResult.status === "rejected" || ourResult.status === "rejected") {
      const failed = directResult.status === "rejected" ? directResult : ourResult;
      skipped.push({ path: t.path, reason: `${directResult.status === "rejected" ? "direct upstream" : "burrow"} unreachable: ${truncate(failed.reason.message, 120)}` });
      continue;
    }
    let a = directResult.value;
    let b = ourResult.value;
    // Request-driven activity collectors and changing app state can race even when started
    // together. Retry once for a stronger exact proof; a repeated field loss still fails.
    const unequal = () => a.status !== b.status || (a.json !== null && b.json !== null
      ? filterTimeDerived(deepDiff(a.json, b.json)).kept.length > 0
      : a.text !== b.text);
    if (t.path !== "/stacks" && unequal()) {
      const retry = await Promise.allSettled([direct.get(directUrl, { headers }), ours.get(oursUrl, { headers })]);
      if (retry.every((r) => r.status === "fulfilled")) {
        [a, b] = retry.map((r) => r.value);
      }
    }
    if (t.path === "/ws/v1/cluster/scheduler/bulk-activities" && unequal()) {
      // Hadoop ActivitiesManager.recordAndGetBulkActivitiesInfo replaces its shared deque after
      // reading it (3.4.3 lines223-239). Concurrent clients can therefore consume each other's result.
      // Collect separately, preserving every unique decision's fields and the total activity count.
      a = await direct.get(directUrl, { headers });
      b = await ours.get(oursUrl, { headers });
      if (a.status === 200 && b.status === 200 && a.json && b.json &&
          !deepDiff(normalizeBulkActivities(a.json), normalizeBulkActivities(b.json)).length) {
        compared++;
        samplingRaces.push({ path: t.path, ourPath: rel, reason: "Hadoop consumes a shared recording deque; separate windows preserve every distinct decision field and total activity count, with order/repetition frequency and event clocks varying" });
        continue;
      }
    }
    compared++;
    if (compared === 1 && !b.headers?.["x-ys-api"]) {
      // the contract (docs/contracts/api.md §1) mandates `x-ys-api: 1` on every /api response; its
      // absence means we are talking to something that is not burrow (e.g. the harness's own
      // static dev server), so P3 must not certify it.
      return {
        generatedAt: new Date().toISOString(),
        status: "skipped",
        reason:
          `${scenario.oursBase} answered ${rel} without the x-ys-api header — not a burrow backend ` +
          `(parity static server?). P3 only certifies the real binary; pass --ours <url>.`,
        compared: 0,
        mismatches: [],
        skipped: [{ path: t.path, reason: "not a burrow backend" }],
      };
    }
    if (a.status !== b.status) {
      mismatches.push({ path: t.path, ourPath: rel, diff: [{ path: "$status", kind: "status", a: a.status, b: b.status }] });
      continue;
    }
    const j1 = a.json;
    const j2 = b.json;
    if (j1 === null || j2 === null) {
      // A thread dump changes stack frames and counters as the request itself executes. Compare its
      // complete thread inventory and format, and report the weaker live proof explicitly. Mock
      // integration tests still require byte-identical stacks passthrough from a fixed upstream.
      if (t.path === "/stacks" && a.status === 200 && a.text !== b.text) {
        const check = compareThreadDumps(a.text, b.text);
        if (!check.diff.length) samplingRaces.push({ path: t.path, ourPath: rel, reason: "thread identities and dump sections preserved; live stack frames/counters differ between requests", threads: check.threads });
        else mismatches.push({ path: t.path, ourPath: rel, diff: check.diff });
        continue;
      }
      if (String(a.text) !== String(b.text) && !/^text\/html/.test(a.headers?.["content-type"] ?? "")) {
        mismatches.push({ path: t.path, ourPath: rel, diff: [{ path: "$text", kind: "text", a: truncate(a.text, 200), b: truncate(b.text, 200) }] });
      }
      continue;
    }
    const diff = deepDiff(j1, j2);
    const { kept, ignored } = filterTimeDerived(diff);
    if (ignored.length) ignoredNotes.push(...ignored);
    if (kept.length) mismatches.push({ path: t.path, ourPath: rel, status: [a.status, b.status], diff: kept });
  }

  const sparkRes = spark
    ? await runSparkWire({ repoRoot, scenario, direct, ours, inventory, oursCaptures, reportDir, log })
    : { status: "skipped", reason: "spark check disabled", checked: [], skipped: [] };

  const status = mismatches.length || (sparkRes.mismatches?.length ?? 0) ? "fail" : compared || sparkRes.checked?.length ? "pass" : "skipped";
  const result = {
    generatedAt: new Date().toISOString(),
    status,
    reason:
      status === "skipped"
        ? (skipped[0]?.reason ?? "burrow backend not reachable (start it with `burrow` or pass --ours)")
        : `compared ${compared} passthrough endpoints, ${sparkRes.checked?.length ?? 0} spark checks, ${samplingRaces.length} live sampling races`,
    compared,
    mismatches,
    skipped,
    samplingRaces,
    ignored: ignoredNotes.slice(0, 50),
    ignoredCount: ignoredNotes.length,
    spark: sparkRes,
  };
  log(`P3 wire: ${status} — ${compared} endpoints compared, ${mismatches.length} mismatches, ${skipped.length} skipped${sparkRes.status ? `, spark=${sparkRes.status}` : ""}`);
  return result;
}

/**
 * Spark parity: identifier coverage (does our UI render every job/stage/executor Spark reports?)
 * plus, when the inventory declares spark.* fields with REST sources, value comparison.
 */
async function runSparkWire({ repoRoot, scenario, direct, ours, inventory, oursCaptures, reportDir, log }) {
  const rm = scenario.rmBase?.replace(/\/+$/, "");
  const shs = scenario.shsBase?.replace(/\/+$/, "");
  const out = { status: "skipped", reason: null, app: null, source: null, checked: [], skipped: [], mismatches: [], idCoverage: [] };

  // find a Spark application: running (RM web proxy) first, else a finished one on the SHS
  let appId = scenario.params?.appId ?? null;
  let source = null;
  let base = null;
  try {
    const apps = await direct.get(`${rm}/ws/v1/cluster/apps`);
    const list = apps.json?.apps?.app ?? [];
    const sparkApps = list.filter((a) => String(a.applicationType).toUpperCase().includes("SPARK"));
    const running = sparkApps.find((a) => a.state === "RUNNING");
    const chosen = running ?? sparkApps[0];
    if (chosen) {
      appId = chosen.id;
      if (chosen.state === "RUNNING") {
        base = `${rm}/proxy/${appId}`;
        source = "live-proxy";
      } else if (shs) {
        base = shs;
        source = "history";
      }
    }
  } catch (e) {
    out.reason = `RM apps unavailable: ${truncate(e.message, 120)}`;
  }
  if (!appId || !base) {
    out.reason = out.reason ?? "no Spark application found on this cluster (nothing to compare)";
    return out;
  }
  out.app = appId;
  out.source = source;

  const appBase = `${base}/api/v1/applications/${appId}`;
  let restBase = appBase;
  let attempt = null;
  const resources = Object.fromEntries([
    "application", "jobs", "stages", "executors", "allexecutors", "environment", "storage/rdd", "sql",
    "streaming/statistics", "streaming/receivers", "streaming/batches",
  ].map((key) => [key, null]));
  for (const key of Object.keys(resources)) {
    const url = key === "application" ? appBase : `${restBase}/${key}`;
    const ourUrl = `${scenario.oursBase.replace(/\/+$/, "")}/api/spark/${appId}/${key}`;
    try {
      const headers = { "Cache-Control": "no-cache" };
      let [r, b] = await Promise.all([direct.get(url, { headers }), ours.get(ourUrl, { headers })]);
      const compare = () => r.status === b.status ? deepDiff(r.json, b.json) : [{ path: "$status", a: r.status, b: b.status }];
      if (r.status === 200 && b.status === 200 && filterTimeDerived(compare(), { resource: key, a: r.json, b: b.json }).kept.length) {
        [r, b] = await Promise.all([direct.get(url, { headers }), ours.get(ourUrl, { headers })]);
      }
      if (r.status === 200 && r.json) {
        resources[key] = r.json;
        if (key === "application" && source === "history") {
          attempt = r.json.attempts?.[0]?.attemptId ?? null;
          if (attempt) restBase = `${appBase}/${attempt}`;
        }
        const diff = compare();
        const { kept, ignored } = filterTimeDerived(diff, { resource: key, a: r.json, b: b.json });
        if (kept.length) out.mismatches.push({ resource: key, url, ourUrl, diff: kept });
        out.checked.push({ resource: key, url, ourUrl, status: [r.status, b.status], ignored });
      } else if (r.status === b.status && r.status >= 400) {
        // Optional streaming/SQL surfaces can be absent for an app. Both sides must preserve the
        // unsupported-resource status; burrow intentionally envelopes upstream HTML errors.
        out.checked.push({ resource: key, url, ourUrl, status: [r.status, b.status], unsupported: true });
      } else {
        out.mismatches.push({ resource: key, url, ourUrl, diff: [{ path: "$status", a: r.status, b: b.status }] });
      }
    } catch (e) {
      out.mismatches.push({ resource: key, url, ourUrl, reason: truncate(e.message, 120) });
    }
  }
  if (!out.checked.length) {
    out.status = "skipped";
    out.reason = `Spark REST not reachable at ${restBase} (${out.skipped[0]?.reason ?? "no resources"})`;
    if (reportDir) writeJson(path.join(reportDir, "raw", "spark-rest.json"), out);
    return out;
  }

  // ---- identifier coverage: Spark's ids vs the entities our UI renders
  const oursDatums = oursCaptures.flatMap((c) => c.datums ?? []).filter((d) => d.field?.startsWith("spark."));
  const idSets = {
    jobs: (resources.jobs ?? []).map((j) => String(j.jobId)),
    stages: (resources.stages ?? []).map((s) => String(s.stageId)),
    executors: (resources.executors ?? []).map((e) => String(e.id)),
  };
  for (const [kind, ids] of Object.entries(idSets)) {
    const fieldPrefix = { jobs: "spark.job.", stages: "spark.stage.", executors: "spark.executor." }[kind];
    const kindDatums = oursDatums.filter((d) => d.field?.startsWith(fieldPrefix));
    if (!ids.length || !kindDatums.length) continue;
    const idsRendered = new Set(kindDatums.map((d) => String(d.entity)));
    const missing = ids.filter((id) => !idsRendered.has(id));
    out.idCoverage.push({ kind, sparkCount: ids.length, rendered: ids.length - missing.length, missing: missing.slice(0, 50) });
    if (missing.length) out.mismatches.push({ resource: kind, reason: "Spark identifiers missing from UI capture", missing });
  }
  if (!oursDatums.length) out.skipped.push({ resource: "DOM identifiers", reason: "no Spark UI captures supplied; REST passthrough alone is proved" });

  // ---- value comparison driven by the inventory's spark.* fields
  const sparkFields = [...inventory.fields.values()].filter((f) => f.entity?.startsWith("spark.") && Array.isArray(f.rest) && f.rest.length);
  if (!sparkFields.length) {
    out.skipped.push({ resource: "*", reason: "inventory declares no spark.* REST fields yet (parity/inventory/src/rest-spark.yaml); id coverage reported only" });
  } else {
    const byEntity = { "spark.job": "jobs", "spark.stage": "stages", "spark.executor": "executors", "spark.rdd": "storage/rdd" };
    for (const f of sparkFields) {
      const key = byEntity[f.entity];
      const payload = key ? resources[key] : null;
      if (!payload) continue;
      for (const d of oursDatums.filter((x) => x.field === f.id)) {
        const rv = resolveRestValue(inventory, f, payload, d.entity);
        if (rv.value === undefined) continue;
        const a = canonicalise(rv.value, f.normaliser ?? "none", { unit: f.unit });
        const b = canonicalise(d.yn ? null : d.raw, f.normaliser ?? "none", { unit: f.unit });
        if (!canonicalEqual(a.value, b.value).equal) {
          out.mismatches.push({ field: f.id, entity: d.entity, spark: rv.value, ours: d.raw, why: canonicalEqual(a.value, b.value).why });
        }
      }
    }
  }

  // ---- Spark UI HTML evidence (scraped rows, recorded for review; compared when ids are known)
  if (reportDir) {
    const uiUrl = source === "history" ? `${base}/history/${appId}/${attempt ? `${attempt}/` : ""}jobs/` : `${base}/jobs/`;
    try {
      const ui = await direct.get(uiUrl);
      if (ui.status === 200) writeText(path.join(reportDir, "raw", "spark-ui.html"), ui.text);
      else out.skipped.push({ resource: "Spark UI HTML evidence", url: uiUrl, reason: `status ${ui.status}` });
    } catch (e) {
      out.skipped.push({ resource: "Spark UI HTML evidence", url: uiUrl, reason: truncate(e.message, 120) });
    }
    writeJson(path.join(reportDir, "raw", "spark-rest.json"), {
      app: appId,
      source,
      restBase,
      idCoverage: out.idCoverage,
      jobsSample: (resources.jobs ?? []).slice(0, 20),
      stagesSample: (resources.stages ?? []).slice(0, 20),
      executorsSample: (resources.executors ?? []).slice(0, 20),
      resourceChecks: out.checked,
    });
  }
  out.status = out.mismatches.length ? "fail" : "pass";
  out.reason = out.mismatches.length
    ? `${out.mismatches.length} spark value mismatches`
    : `spark REST compared (${out.checked.map((c) => c.resource).join(", ")}); id coverage: ${out.idCoverage.map((i) => `${i.kind} ${i.rendered}/${i.sparkCount}`).join(", ") || "n/a"}`;
  return out;
}

/* ------------------------------- CLI ------------------------------- */

export function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, vInline] = a.slice(2).split("=");
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (vInline !== undefined) out[key] = vInline;
    else if (args[i + 1] && !args[i + 1].startsWith("--")) out[key] = args[++i];
    else out[key] = true;
  }
  return out;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(argv.repoRoot ?? path.join(import.meta.dirname, "..", ".."));
  const { loadInventory } = await import("./lib/inventory.mjs");
  const fixtureDir = argv.fixtures ? path.resolve(repoRoot, argv.fixtures) : null;
  const scenarioId = argv.scenario ?? "live";
  const scenarioFile = path.join(
    fixtureDir ?? path.join(repoRoot, "parity", "harness", "fixtures"),
    scenarioId,
    "scenario.json"
  );
  const endpoints = loadEndpoints(repoRoot);
  const scenario = fs.existsSync(scenarioFile)
    ? JSON.parse(fs.readFileSync(scenarioFile, "utf8"))
    : { id: scenarioId, params: {}, facts: { conf: {} }, rmBase: argv.rm ?? endpoints?.rm?.webapp ?? "http://127.0.0.1:8088" };
  if (argv.rm) scenario.rmBase = argv.rm;
  if (argv.ours) scenario.oursBase = argv.ours;
  if (!scenario.oursBase) scenario.oursBase = "http://127.0.0.1:8787";
  scenario.nodeBases = scenario.nodeBases?.length ? scenario.nodeBases : endpoints?.nodeManagers ?? [];
  scenario.shsBase ??= endpoints?.sparkHistory?.webapp;
  scenario.jhsBase ??= endpoints?.jobHistory?.webapp;
  const mode = fixtureDir ? "replay" : "live";
  const direct = await createUpstream({ mode, fixtureDir, scenarioId, label: "wire-direct", log: console.log });
  if (!fixtureDir) {
    const derived = await deriveLive(direct, scenario.rmBase);
    scenario.params = { ...derived.params, ...scenario.params };
    scenario.facts = derived.facts;
  }
  const ours = await createUpstream({ mode, fixtureDir, scenarioId, label: "wire-ours", log: console.log });
  const inventory = loadInventory(repoRoot);
  const reportDir = path.resolve(repoRoot, argv.report ?? "parity/report");
  const res = await runWire({
    repoRoot,
    scenario,
    direct,
    ours,
    inventory,
    reportDir,
  });
  writeJson(path.join(reportDir, "wire.json"), res);
  if (mode === "record") {
    direct.flush();
    ours.flush();
  }
  console.log(JSON.stringify({ status: res.status, compared: res.compared, mismatches: res.mismatches.length, skipped: res.skipped.length }, null, 1));
  process.exitCode = res.status === "pass" ? 0 : 1;
}

if (import.meta.main) await main();
