// Scenario definitions and their resolution against a live cluster.
//
// A scenario is: the route params a page needs ({appId}, {attemptId}, {containerId}, {nodeId},
// {queue}, {state}) plus the *facts* used to evaluate inventory `when` conditions (scheduler type,
// states present on the cluster, conf values, labels, HA, security). Record mode persists the
// resolved scenario, so replay needs no Java, no RM and no guessing.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { readJson } from "./sources.mjs";

export function loadScenarioDefs(dir) {
  const defs = [];
  if (!fs.existsSync(dir)) return defs;
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const doc = YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")) ?? {};
    for (const s of doc.scenarios ?? []) {
      if (!s?.id) continue;
      defs.push({ ...s, file: path.join(dir, f) });
    }
  }
  return defs;
}

export function loadEndpoints(repoRoot) {
  const p = path.join(repoRoot, ".cluster", "endpoints.json");
  return fs.existsSync(p) ? readJson(p) : null;
}

export function parseConfXml(xml) {
  const map = {};
  if (typeof xml !== "string") return map;
  const re = /<property>\s*<name>([\s\S]*?)<\/name>\s*<value>([\s\S]*?)<\/value>/g;
  let m;
  while ((m = re.exec(xml))) map[unescapeXml(m[1])] = unescapeXml(m[2]);
  return map;
}

export function parseConfJson(json) {
  const map = {};
  for (const p of json?.properties ?? []) map[p.key] = p.value;
  return map;
}

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** Pull the facts and auto params a live cluster can answer. */
export async function deriveLive(upstream, rmBase) {
  const facts = { conf: {}, states: [], ui: {}, apps: {} };
  const params = {};
  const notes = [];
  const get = async (p, headers = {}) => {
    const r = await upstream.get(`${rmBase.replace(/\/+$/, "")}${p}`, { headers });
    return r;
  };

  let info = null;
  try {
    const r = await get("/ws/v1/cluster/info");
    info = r.json?.clusterInfo ?? null;
  } catch (e) {
    notes.push(`cluster info unavailable: ${e.message}`);
  }

  let confXml = "";
  try {
    const r = await get("/conf?format=json", { Accept: "application/json" });
    facts.conf = parseConfJson(r.json) && Object.keys(parseConfJson(r.json)).length ? parseConfJson(r.json) : parseConfXml(r.text);
    confXml = r.text ?? "";
  } catch (e) {
    notes.push(`/conf unavailable: ${e.message}`);
  }

  try {
    const r = await get("/ws/v1/cluster/scheduler");
    const t = r.json?.scheduler?.schedulerInfo?.type ?? "";
    facts.scheduler = t.replace(/Scheduler$/i, "").toLowerCase() || null;
    // webapp AppInfo.java:122-131: the GPU columns carry real values only when yarn.io/gpu is a configured resource type
    // (ResourceUtils.getResourceTypeIndex().get(GPU_URI) != null), else the fields are the sentinel -1; every configured type
    // is listed in the scheduler's maximumAllocation.resourceInformations
    facts.gpuResourceTypeConfigured = JSON.stringify(r.json ?? {}).includes('"yarn.io/gpu"');
  } catch (e) {
    notes.push(`/scheduler unavailable: ${e.message}`);
  }

  let apps = [];
  try {
    const r = await get("/ws/v1/cluster/apps");
    apps = r.json?.apps?.app ?? [];
    facts.states = [...new Set(apps.map((a) => a.state).filter(Boolean))].sort();
    facts.states.push("ALL");
    facts.appCount = apps.length;
  } catch (e) {
    notes.push(`/apps unavailable: ${e.message}`);
  }

  try {
    const r = await get("/ws/v1/cluster/nodes");
    const nodes = r.json?.nodes?.node ?? [];
    const running = nodes.find((n) => n.state === "RUNNING") ?? nodes[0];
    if (running?.id) params.nodeId = running.id;
    facts.nodeCount = nodes.length;
    // CapacitySchedulerPage.java:474-490 hasAnyLabelLinkedToNM: a non-default label with >= 1 active NM. One RUNNING NM carrying the label
    // is exactly RMNodeLabel.getNumActiveNMs() > 0 (REST get-node-labels carries no active-NM count); live legacy DOM agrees
    // (partition bars rendered instead of the root bar)
    facts.labelsWithActiveNMs = nodes.some(
      (n) => n.state === "RUNNING" && (n.nodeLabels ?? []).some((l) => l && l !== "<DEFAULT_PARTITION>")
    );
  } catch (e) {
    notes.push(`/nodes unavailable: ${e.message}`);
  }

  try {
    const r = await get("/ws/v1/cluster/get-node-labels");
    const labels = r.json?.nodeLabelInfo ?? r.json?.nodeLabels?.nodeLabel ?? [];
    facts.labels = labels.length > 0;
    facts.nodeLabels = labels.map((l) => l.name);
  } catch (e) {
    facts.labels = false;
  }

  // pick a representative application whose *attempts* actually resolve in REST: an app whose
  // record was loaded from the state store can have `{"appAttempts":{}}` (no attempts retained).
  const pick = (pred) => apps.find(pred);
  const runningish = apps.filter((a) => ["RUNNING", "ACCEPTED", "SUBMITTED", "NEW", "NEW_SAVING"].includes(a.state));
  const running = runningish[0] ?? null;
  const finished = pick((a) => a.state === "FAILED") ?? pick((a) => a.state === "FINISHED" || a.state === "KILLED") ?? null;
  const candidateOrder = uniqBy([
    ...runningish.filter((a) => Number(a.runningContainers ?? 0) > 0),
    ...runningish,
    ...apps.filter((a) => a.state === "FAILED"),
    ...apps.filter((a) => ["FINISHED", "KILLED"].includes(a.state)),
  ], (a) => a.id);
  // the state facet of /cluster/apps/{state}: RUNNING only when an app is really RUNNING (an ACCEPTED app is not listed there,
  // and an empty facet renders no rows, which made every table item "absent"); else the state of the pending app; else ALL
  params.state = apps.some((a) => a.state === "RUNNING") ? "RUNNING" : (running?.state ?? "ALL");

  {
    const findContainers = async (appId, attemptId) => {
      const c = await get(`/ws/v1/cluster/apps/${appId}/appattempts/${attemptId}/containers`);
      // this endpoint returns `{"container":[…]}`; the app-level one uses `{"containers":{"container":[…]}}`
      return c.json?.containers?.container ?? c.json?.container ?? [];
    };
    const attsFor = async (appId) => {
      const r = await get(`/ws/v1/cluster/apps/${appId}/appattempts`);
      return r.json?.appAttempts?.appAttempt ?? [];
    };
    let chosenApp = candidateOrder[0] ?? null;
    let chosenAttempt = null;
    // facts about the apps a scenario may target (attempt/container presence gate the attempt/container table items)
    for (const cand of candidateOrder.slice(0, 12)) {
      try {
        const atts = await attsFor(cand.id);
        let containerCount = 0;
        for (const a of atts) containerCount += (await findContainers(cand.id, a.appAttemptId).catch(() => [])).length;
        facts.apps[cand.id] = {
          attemptCount: atts.length,
          containerCount,
          state: cand.state,
          logAggregationStatus: cand.logAggregationStatus ?? null,
        };
        if (!params.pendingAppId && atts.length && ["ACCEPTED", "SUBMITTED", "NEW", "NEW_SAVING"].includes(cand.state)) {
          params.pendingAppId = cand.id;
          params.pendingAttemptId = atts[atts.length - 1].appAttemptId;
        }
      } catch (e) {
        notes.push(`${cand.id}: attempt/container facts unavailable: ${e.message}`);
      }
    }
    for (const cand of candidateOrder.slice(0, 10)) {
      try {
        const atts = await attsFor(cand.id);
        if (atts.length) {
          chosenApp = cand;
          chosenAttempt = atts[atts.length - 1];
          break;
        }
        notes.push(`${cand.id}: RM retains no attempts (appAttempts empty)`);
      } catch (e) {
        notes.push(`${cand.id}: appattempts unavailable: ${e.message}`);
      }
    }
    if (chosenApp) {
      params.appId = chosenApp.id;
      if (chosenApp.queue) params.queue = chosenApp.queue;
    }
    if (chosenAttempt) {
      params.attemptId = chosenAttempt.appAttemptId;
      if (chosenAttempt.containerId) params.containerId = chosenAttempt.containerId;
      if (chosenAttempt.nodeId) params.nodeId = chosenAttempt.nodeId;
      try {
        const conts = await findContainers(params.appId, params.attemptId);
        const withNode = conts.find((x) => x.nodeId ?? x.assignedNodeId);
        const pickContainer = (conts.find((x) => x.containerId) ?? withNode)?.containerId ?? withNode?.id;
        if (pickContainer) params.containerId = pickContainer;
        if (withNode?.nodeId ?? withNode?.assignedNodeId) params.nodeId = withNode.nodeId ?? withNode.assignedNodeId;
      } catch (e) {
        notes.push(`containers unavailable: ${e.message}`);
      }
    }
    if (running) params.runningAppId = running.id;
    if (finished) params.finishedAppId = finished.id;
    // a scenario that asks for the finished app should get one the harness can actually crawl
    if (chosenApp && ["FAILED", "FINISHED", "KILLED"].includes(chosenApp.state)) params.finishedAppId = chosenApp.id;
    if (chosenApp && runningish.some((a) => a.id === chosenApp.id)) params.runningAppId = chosenApp.id;
  }
  if (!params.appId && apps[0]) params.appId = apps[0].id;
  if (!params.queue) params.queue = "root.default";
  // the legacy /logs/{filename} page needs a real file name: take the first .log in the RM's listing
  try {
    const r = await get("/logs");
    const m = String(r.text ?? "").match(/href=["']([^"']+\.log[^"']*)["']/i);
    if (m) params.logFile = m[1].replace(/^.*\//, "");
  } catch (e) {
    notes.push(`/logs listing unavailable: ${e.message}`);
  }
  if (info) {
    facts.ha = !/not enabled|not configured/i.test(String(info.haZooKeeperConnectionState ?? "not enabled"));
    facts.haState = info.haState ?? null;
    facts.rmVersion = info.resourceManagerVersion ?? null;
    facts.clusterId = info.id ?? null;
  }
  facts.secure = String(facts.conf["hadoop.security.authentication"] ?? "simple").toLowerCase() === "kerberos";
  // The legacy "User Metrics for <user>" block needs per-user QueueMetrics on the root queue (MetricsOverviewTable.java
  // :157-160 -> UserMetricsInfo.metricsAvailable()). The Fair scheduler hardcodes enableUserMetrics=true (FSQueue.java:95);
  // the Capacity scheduler builds root QueueMetrics with it only when yarn.scheduler.capacity.user-metrics.enable=true
  // (CapacitySchedulerConfiguration.ENABLE_USER_METRICS, default false; AbstractCSQueue.java:153, QueueMetrics.java:287-290).
  facts.userMetricsEnabled =
    facts.scheduler === "fair" ||
    String(facts.conf["yarn.scheduler.capacity.user-metrics.enable"] ?? "false").toLowerCase() === "true";
  return { facts, params, notes, confXmlLength: confXml.length };
}

/**
 * Resolve a scenario definition into a concrete runnable scenario.
 * `auto` params come from the live derivation; explicit values win.
 */
export function resolveScenario(def, { derived, endpoints, repoRoot, scenarioIdOverride } = {}) {
  const params = {};
  const sources = [];
  const explicit = def.params ?? {};
  const aliases = { appId: ["appId", "runningAppId", "finishedAppId"] };
  for (const [k, v] of Object.entries(explicit)) {
    if (typeof v === "string" && v.startsWith("auto:")) {
      const key = v.slice("auto:".length);
      params[k] = derived.params[key] ?? null;
      sources.push(`${k}=auto:${key}(${params[k] ?? "unresolved"})`);
      continue;
    }
    if (v === "auto") {
      const cands = aliases[k] ?? [k];
      const val = cands.map((c) => derived.params[c]).find((x) => x != null);
      params[k] = val ?? null;
      sources.push(`${k}=auto(${val ?? "unresolved"})`);
    } else {
      params[k] = v;
      sources.push(`${k}=${v}`);
    }
  }
  // always expose the derived params for route templates
  // (an explicit `null` in the scenario means "this scenario has none", e.g. the pending-app scenario has no container)
  for (const [k, v] of Object.entries(derived.params)) if (params[k] == null && explicit[k] !== null) params[k] = v;
  const facts = { ...derived.facts, ...(def.facts ?? {}) };
  // per-scenario facts about the targeted app (derived once per cluster in deriveLive, selected by the resolved appId)
  const appFacts = derived.facts?.apps?.[params.appId] ?? null;
  facts.attemptCount = appFacts?.attemptCount ?? 0;
  facts.attemptHasContainers = (appFacts?.containerCount ?? 0) > 0;
  facts.targetAppState = appFacts?.state ?? null;
  // RMAppLogAggregationStatusBlock lists one row per NM report (rmApp.getLogAggregationReportsForApp()); the app-level
  // status stays NOT_START (or DISABLED) until the first NM report arrives, so that is the observable proxy
  const lag = appFacts?.logAggregationStatus ?? null;
  facts.logAggReportsPresent = lag != null && !["NOT_START", "DISABLED"].includes(String(lag).toUpperCase());
  if (def.facts?.conf) facts.conf = { ...derived.facts.conf, ...def.facts.conf };
  const resolved = {
    id: scenarioIdOverride ?? def.id,
    description: def.description ?? "",
    params,
    facts,
    pages: def.pages ?? null,
    sources,
    endpoints,
    repoRoot,
    rmBase: endpoints?.rm?.webapp ?? derived.rmBase ?? null,
    nodeBase: endpoints?.nodeManagers?.[0]?.webapp ?? null,
    shsBase: endpoints?.sparkHistory?.webapp ?? null,
    jhsBase: endpoints?.jobHistory?.webapp ?? null,
    derivedNotes: derived.notes ?? [],
    file: def.file ?? null,
  };
  return resolved;
}

export function writeScenario(fixtureDir, scenario) {
  const dir = path.join(fixtureDir, scenario.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scenario.json"), `${JSON.stringify(scenario, null, 1)}\n`);
}

export function readScenario(fixtureDir, scenarioId) {
  return readJson(path.join(fixtureDir, scenarioId, "scenario.json"));
}

export function listRecordedScenarios(fixtureDir) {
  if (!fs.existsSync(fixtureDir)) return [];
  return fs
    .readdirSync(fixtureDir)
    .filter((d) => fs.existsSync(path.join(fixtureDir, d, "scenario.json")))
    .sort();
}
