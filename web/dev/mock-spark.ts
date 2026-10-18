/**
 * Dev-mock of the Spark slice of the burrow API (docs/contracts/api.md §4).
 *
 * Everything replayed here is a REAL captured payload from `fixtures/spark/{4.2.0,3.5.9}/<workload>/rest/**`
 * (indexed from each workload's `MANIFEST.json`). The only synthesized routes are `/source`, the RM identity of the
 * fixture apps (the workloads ran on `local[2]`, so no RM ever had them — see `rmIdentityResponse`), the `/dag/*` route
 * (persisted goldens parsed from Spark's HTML dot pages) and the Spark-exact `taskList` pagination/sort/status and
 * `taskSummary` quantile derivations, which are computed from the captured task rows rather than invented.
 *
 * Wired in by `web/dev/mock-api.ts`: `handleSpark(req, path, url)` returns `null` for anything outside `spark/...`.
 */
import { errorResponse, jsonResponse, MOCK_RM_HOST, MOCK_SHS_HOST } from "./mock-data/instance.ts";

/* ── scenarios ──────────────────────────────────────────────────────────────────────────────────────────────── */

export interface SparkScenario {
  appId: string;
  workload: string;
  version: "4.2.0" | "3.5.9";
  phase: "final" | "live";
}

/** YARN app id → captured workload (MANDATORY table from the Spark tracking-UI brief). */
export const SPARK_SCENARIOS: readonly SparkScenario[] = [
  { appId: "application_1791010000001_0001", workload: "rdd-wordcount", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0002", workload: "df-join-aqe", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0003", workload: "job-failed", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0004", workload: "task-retries", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0005", workload: "stage-retry", version: "4.2.0", phase: "live" },
  { appId: "application_1791010000001_0006", workload: "big-dag", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0007", workload: "dstream", version: "4.2.0", phase: "live" },
  { appId: "application_1791010000001_0008", workload: "structured-streaming", version: "4.2.0", phase: "live" },
  { appId: "application_1791010000001_0009", workload: "sql-cache-union", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0010", workload: "window-sql", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0011", workload: "python-udf", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0012", workload: "broadcast-join", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0013", workload: "shared-stages-multijob", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0014", workload: "barrier-scopes", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0015", workload: "long-running", version: "4.2.0", phase: "final" },
  { appId: "application_1791010000001_0016", workload: "rdd-wordcount", version: "3.5.9", phase: "final" },
];

/** Deliberately resolvable-but-unavailable app (SHS has no event log) so the SPA's honest path is reachable. */
const UNAVAILABLE_APP = "application_1791010000001_0099";

const FIXTURES = new URL("../../fixtures/spark/", import.meta.url);
const DEFAULT_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];

/** `pick` takes a params Map; the RM identity stub asks for a path that carries no query of its own. */
const NO_PARAMS: Map<string, string> = new Map();

const scenarioById: Record<string, SparkScenario> = Object.fromEntries(SPARK_SCENARIOS.map((s) => [s.appId, s]));
const finalScenarios = SPARK_SCENARIOS.filter((s) => s.phase === "final");

/** FNV-1a: stable appId→scenario mapping (prefers the `final` phase) so unknown URLs still render real data. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function resolveScenario(appId: string): SparkScenario {
  const hit = scenarioById[appId];
  if (hit) return hit;
  const fallback = finalScenarios[hash32(appId) % finalScenarios.length] ?? SPARK_SCENARIOS[0];
  if (fallback) return fallback;
  // unreachable: SPARK_SCENARIOS is non-empty
  throw new Error("SPARK_SCENARIOS is empty");
}

/* ── fixture index (MANIFEST.json per workload) ─────────────────────────────────────────────────────────────── */

interface ManifestFile {
  file: string;
  phase?: string;
  request?: { path?: string; query?: unknown };
  status?: number;
}
interface Manifest {
  appId?: string;
  files?: ManifestFile[];
}
interface Fixture {
  url: URL;
  status: number;
  phase: string;
  pathname: string;
  query: string;
  params: Map<string, string>;
  payload?: unknown;
  text?: string;
}
interface WorkloadIndex {
  appId: string | null;
  byPath: Map<string, Fixture[]>;
}

const indexCache = new Map<string, Promise<WorkloadIndex>>();

function paramsFromQueryString(q: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof q !== "string" || q === "") return out;
  for (const [k, v] of new URLSearchParams(q)) {
    if (k === "attempt") continue; // attempt-agnostic captures
    out.set(k, out.has(k) ? `${out.get(k)},${v}` : v);
  }
  return out;
}

function paramsFromSearch(sp: URLSearchParams): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of sp) {
    if (k === "attempt") continue;
    out.set(k, out.has(k) ? `${out.get(k)},${v}` : v);
  }
  return out;
}

/** Mirrors `web/src/api/client.ts`'s `canonicalQuery`: keys sorted, values comma-joined, `%2C` kept literal. */
function canonicalFromParams(m: Map<string, string>): string {
  const parts: string[] = [];
  for (const k of [...m.keys()].sort()) {
    const s = m.get(k) ?? "";
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(s).replaceAll("%2C", ",")}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function buildIndex(version: string, workload: string): Promise<WorkloadIndex> {
  const dir = new URL(`${version}/${workload}/`, FIXTURES);
  const byPath = new Map<string, Fixture[]>();
  return Bun.file(new URL("MANIFEST.json", dir))
    .json()
    .then((raw) => {
      const manifest = raw as Manifest;
      for (const f of manifest.files ?? []) {
        const p = f.request?.path;
        if (typeof p !== "string" || !p.startsWith("/api/")) continue;
        const params = paramsFromQueryString(f.request?.query);
        const fixture: Fixture = {
          url: new URL(f.file, dir),
          status: f.status ?? 200,
          phase: f.phase ?? "final",
          pathname: p,
          query: canonicalFromParams(params),
          params,
        };
        const list = byPath.get(p);
        if (list) list.push(fixture);
        else byPath.set(p, [fixture]);
      }
      return { appId: manifest.appId ?? null, byPath };
    })
    .catch(() => ({ appId: null, byPath }));
}

function loadIndex(sc: SparkScenario): Promise<WorkloadIndex> {
  const key = `${sc.version}/${sc.workload}`;
  let p = indexCache.get(key);
  if (!p) {
    p = buildIndex(sc.version, sc.workload);
    indexCache.set(key, p);
  }
  return p;
}

/* ── payload access ─────────────────────────────────────────────────────────────────────────────────────────── */

async function payloadOf(entry: Fixture): Promise<unknown> {
  if (entry.payload !== undefined) return entry.payload;
  try {
    const parsed = await Bun.file(entry.url).json();
    entry.payload = parsed;
    return parsed;
  } catch {
    return undefined;
  }
}

async function textOf(entry: Fixture): Promise<string> {
  if (entry.text !== undefined) return entry.text;
  try {
    entry.text = await Bun.file(entry.url).text();
  } catch {
    entry.text = "";
  }
  return entry.text;
}

/** Collapse a captured 404 body to a single concise line for the error envelope. */
function oneLine(text: string): string {
  const h2 = /<h2>([^<]*)<\/h2>/i.exec(text);
  const msg = /MESSAGE:<\/th><td>([^<]*)<\/td>/i.exec(text);
  const raw = h2?.[1] ?? msg?.[1] ?? text;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, 200) || "Not found";
}

async function serveFixture(entry: Fixture, req: Request, reqParams: Map<string, string>): Promise<Response> {
  if (entry.status >= 400 || entry.url.pathname.endsWith(".txt")) {
    const text = await textOf(entry);
    return errorResponse("not_found", oneLine(text), entry.status >= 400 ? entry.status : 404);
  }
  let payload = await payloadOf(entry);
  const status = reqParams.get("status");
  if (status && !entry.params.has("status") && Array.isArray(payload)) {
    payload = filterByStatus(payload, status);
  }
  return jsonResponse(payload, {}, req);
}

function filterByStatus(rows: unknown[], status: string): unknown[] {
  const want = status.toUpperCase();
  return rows.filter((row) => {
    if (!row || typeof row !== "object") return false;
    const s = (row as Record<string, unknown>).status;
    return typeof s === "string" && s.toUpperCase() === want;
  });
}

/* ── fixture resolution ─────────────────────────────────────────────────────────────────────────────────────── */

function isSubset(captured: Map<string, string>, requested: Map<string, string>): boolean {
  for (const [k, v] of captured) {
    if (requested.get(k) !== v) return false;
  }
  return true;
}

function pickExact(index: WorkloadIndex, pathname: string, query: string, phase: string): Fixture | undefined {
  const all = index.byPath.get(pathname);
  if (!all) return undefined;
  return all.find((e) => e.phase === phase && e.query === query) ?? all.find((e) => e.query === query);
}

function pick(
  index: WorkloadIndex,
  pathname: string,
  reqParams: Map<string, string>,
  reqQuery: string,
  phase: string,
): Fixture | undefined {
  const all = index.byPath.get(pathname);
  if (!all) return undefined;
  const exact = pickExact(index, pathname, reqQuery, phase);
  if (exact) return exact;

  const choose = (pool: Fixture[]): Fixture | undefined => {
    let cands = pool.filter((e) => isSubset(e.params, reqParams));
    if (!cands.length) return undefined;
    if (reqParams.has("status")) {
      const withStatus = cands.filter((e) => e.params.has("status"));
      if (withStatus.length) cands = withStatus;
    }
    let best = cands[0];
    for (const c of cands) {
      if (!best) {
        best = c;
        continue;
      }
      if (c.params.size > best.params.size) best = c;
      else if (c.params.size === best.params.size && best.status >= 400 && c.status < 400) best = c;
    }
    return best;
  };

  const phasePool = all.filter((e) => e.phase === phase);
  return choose(phasePool) ?? choose(all);
}

/** Captured entry at `pathname` with no query (the "full" / unfiltered capture), preferring the active phase. */
function baseEntry(index: WorkloadIndex, pathname: string, phase: string): Fixture | undefined {
  const all = (index.byPath.get(pathname) ?? []).filter((e) => e.query === "" && e.status < 400);
  return all.find((e) => e.phase === phase) ?? all[0];
}

/* ── route → captured Spark REST path ───────────────────────────────────────────────────────────────────────── */

function appBase(capturedId: string): string {
  return `/api/v1/applications/${capturedId}`;
}

function mapPath(capturedId: string, rest: string[]): string {
  if (rest.length === 0) return appBase(capturedId);
  if (rest.length === 1 && rest[0] === "application") return appBase(capturedId);
  if (rest.length === 1 && rest[0] === "version") return "/api/v1/version";
  return `${appBase(capturedId)}/${rest.join("/")}`;
}

/* ── synthesized: /source ───────────────────────────────────────────────────────────────────────────────────── */

async function sourceResponse(appId: string, req: Request): Promise<Response> {
  if (appId === UNAVAILABLE_APP) {
    return jsonResponse(
      {
        mode: "none",
        baseUrl: null,
        sparkAppId: null,
        attempt: null,
        available: false,
        reason: "The Spark History Server has no event log for this application.",
        hint: "Event logging may be disabled, or the log may have been cleaned up.",
      },
      {},
      req,
    );
  }
  const sc = resolveScenario(appId);
  const index = await loadIndex(sc);
  const live = sc.phase === "live";
  return jsonResponse(
    {
      mode: live ? "live-proxy" : "history",
      baseUrl: live ? `http://${MOCK_RM_HOST}/proxy/${appId}` : `http://${MOCK_SHS_HOST}`,
      sparkAppId: index.appId ?? appId,
      attempt: "1",
      available: true,
      reason: null,
      hint: null,
    },
    {},
    req,
  );
}

/* ── synthesized: the RM identity of a fixture app ──────────────────────────────────────────────────────────── */

/**
 * The workloads were captured on `local[2]` (each `MANIFEST.json`), so no ResourceManager ever had a record for these
 * YARN ids. The SPA's `/apps/$appId` layout gates every child route on `GET /apps/{id}`, so without this stub the whole
 * Spark tree answers "Could not load …". Identity, state and attempt times are derived from the *captured* Spark
 * application payload; only the RM fields the Spark payload cannot know stay at their neutral values (-1 / 0).
 *
 * `UNAVAILABLE_APP` is the mock's deliberate "SHS has no event log" scenario: the RM keeps a finished record for it, the
 * Spark source resolves to `none`, and the pages must say so instead of inventing numbers.
 */

/** Spark's REST timestamps carry a bare `GMT` suffix (`2026-10-03T07:06:29.343GMT`), which `Date.parse` rejects. */
function sparkTimeMs(v: unknown): number {
  if (typeof v !== "string") return 0;
  const ms = Date.parse(v.endsWith("GMT") ? `${v.slice(0, -3)}Z` : v);
  return Number.isFinite(ms) ? ms : 0;
}

interface CapturedAttempt {
  startTime?: string;
  duration?: number;
  sparkUser?: string;
}
interface CapturedApplication {
  name?: string;
  attempts?: CapturedAttempt[];
}

async function rmIdentityResponse(path: string, req: Request): Promise<Response | null> {
  const segs = path.split("/").filter(Boolean); // yarn/apps/<id>[/appattempts]
  if (segs[0] !== "yarn" || segs[1] !== "apps" || !segs[2]) return null;
  const appId = decodeURIComponent(segs[2]);
  if (!(appId in scenarioById) && appId !== UNAVAILABLE_APP) return null; // every other app id belongs to the generated RM mock
  if (segs.length > 4 || (segs[3] !== undefined && segs[3] !== "appattempts")) return null;

  const sc = appId === UNAVAILABLE_APP ? undefined : resolveScenario(appId);
  const index = sc ? await loadIndex(sc) : undefined;
  const entry = sc && index ? pick(index, appBase(index.appId ?? appId), NO_PARAMS, "", sc.phase) : undefined;
  const payload = (entry ? await payloadOf(entry) : undefined) as CapturedApplication | undefined;
  const attempts = payload?.attempts ?? [];
  const first = attempts[0];
  const last = attempts[attempts.length - 1];
  const started = sparkTimeMs(first?.startTime);
  const live = sc?.phase === "live";
  const finished = live ? 0 : started + (last?.duration ?? 0);
  const clusterId = Number(appId.split("_")[1] ?? 0);

  if (segs[3] === "appattempts") {
    return jsonResponse(
      {
        appAttempts: {
          appAttempt: attempts.map((a, i) => ({
            id: i + 1,
            startTime: sparkTimeMs(a.startTime),
            finishedTime: live ? 0 : sparkTimeMs(a.startTime) + (a.duration ?? 0),
            containerId: "",
            nodeHttpAddress: "",
            nodeId: "",
            logsLink: "",
            appAttemptId: `appattempt_${clusterId}_${appId.split("_")[2] ?? "000001"}_${String(i + 1).padStart(6, "0")}`,
            appAttemptState: live ? "RUNNING" : "FINISHED",
          })),
        },
      },
      {},
      req,
    );
  }

  return jsonResponse(
    {
      app: {
        id: appId,
        user: first?.sparkUser ?? "spark",
        name: payload?.name ?? sc?.workload ?? "burrow-unavailable",
        queue: "root.default",
        state: live ? "RUNNING" : "FINISHED",
        finalStatus: live ? "UNDEFINED" : "SUCCEEDED",
        progress: live ? 0 : 100,
        trackingUI: live ? "ApplicationMaster" : "History",
        trackingUrl: live ? `http://${MOCK_RM_HOST}/proxy/${appId}/` : `http://${MOCK_SHS_HOST}/history/${appId}/`,
        diagnostics: "",
        clusterId,
        applicationType: "SPARK",
        applicationTags: "",
        priority: 0,
        startedTime: started,
        launchTime: started,
        finishedTime: finished,
        elapsedTime: (finished || Date.now()) - started,
        allocatedMB: -1,
        allocatedVCores: -1,
        runningContainers: 0,
        memorySeconds: 0,
        vcoreSeconds: 0,
        queueUsagePercentage: 0,
        clusterUsagePercentage: 0,
        preemptedResourceMB: 0,
        preemptedResourceVCores: 0,
        numNonAMContainerPreempted: 0,
        numAMContainerPreempted: 0,
        unmanagedApplication: false,
      },
    },
    {},
    req,
  );
}

/* ── synthesized: /dag/* ────────────────────────────────────────────────────────────────────────────────────── */

const OTHER_VERSION: Record<string, string> = { "4.2.0": "3.5.9", "3.5.9": "4.2.0" };

async function serveDag(sc: SparkScenario, kind: "job" | "stage", ids: string, jobId: string | null, req: Request): Promise<Response> {
  const golden = `dag-${kind}-${ids}.json`;
  const live = `dag-live-${kind}-${ids}.json`;
  const names = sc.phase === "live" ? [live, golden] : [golden, live];
  if (kind === "job" && jobId) names.push(`dag-fallback-job-${jobId}.json`);

  const versions = [sc.version, OTHER_VERSION[sc.version]].filter((v): v is string => typeof v === "string");
  for (const version of versions) {
    const dir = new URL(`${version}/${sc.workload}/`, FIXTURES);
    for (const name of names) {
      const url = new URL(name, dir);
      const file = Bun.file(url);
      if (!(await file.exists())) continue;
      if (name.endsWith(".txt")) {
        return errorResponse("not_found", oneLine(await file.text()), 404);
      }
      try {
        const parsed = (await file.json()) as Record<string, unknown>;
        if (typeof parsed.kind !== "string" || typeof parsed.granularity !== "string" || !Array.isArray(parsed.stages)) {
          return errorResponse("not_found", `Spark's HTML page for this ${kind} carries no DAG metadata`, 404);
        }
        return jsonResponse(parsed, {}, req);
      } catch {
        return errorResponse("not_found", `Spark's HTML page for this ${kind} carries no DAG metadata`, 404);
      }
    }
  }
  return errorResponse("not_found", `Spark's HTML page for this ${kind} carries no DAG metadata`, 404);
}

async function dagResponse(appId: string, rest: string[], req: Request): Promise<Response> {
  const sc = resolveScenario(appId);
  if (rest[1] === "jobs" && rest.length === 3 && rest[2]) {
    return serveDag(sc, "job", rest[2], rest[2], req);
  }
  if (rest[1] === "stages" && rest.length === 4 && rest[2] && rest[3]) {
    return serveDag(sc, "stage", `${rest[2]}-${rest[3]}`, null, req);
  }
  return errorResponse("not_found", `Unknown DAG resource /spark/${appId}/${rest.join("/")}`, 404);
}

/* ── synthesized: taskList (status filter, runtime sort, offset/length) ─────────────────────────────────────── */

function intParam(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sortByRuntime(tasks: unknown[], desc: boolean): unknown[] {
  const duration = (t: unknown): number => {
    if (!t || typeof t !== "object") return 0;
    const d = (t as Record<string, unknown>).duration;
    return typeof d === "number" ? d : Number(d) || 0;
  };
  return [...tasks].sort((a, b) => (desc ? duration(b) - duration(a) : duration(a) - duration(b)));
}

async function taskListResponse(
  index: WorkloadIndex,
  pathname: string,
  reqParams: Map<string, string>,
  req: Request,
  phase: string,
): Promise<Response> {
  const sortBy = reqParams.get("sortBy");
  if (sortBy && sortBy !== "runtime" && sortBy !== "-runtime") {
    return errorResponse("not_found", `Unsupported sortBy: ${sortBy}`, 404);
  }
  const exact = pickExact(index, pathname, canonicalFromParams(reqParams), phase);
  if (exact) return serveFixture(exact, req, reqParams);

  const base = baseEntry(index, pathname, phase);
  const loaded = base ? await payloadOf(base) : undefined;
  if (!Array.isArray(loaded)) return errorResponse("not_found", `No task list for ${pathname}`, 404);
  let tasks: unknown[] = loaded;
  const status = reqParams.get("status");
  if (status) tasks = filterByStatus(tasks, status);
  if (sortBy) tasks = sortByRuntime(tasks, sortBy === "-runtime");
  const offset = intParam(reqParams.get("offset")) ?? 0;
  const length = intParam(reqParams.get("length"));
  const sliced = tasks.slice(offset, length == null ? undefined : offset + length);
  return jsonResponse(sliced, {}, req);
}

/* ── synthesized: taskSummary (quantiles derived from captured task rows) ───────────────────────────────────── */

function pickNum(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

function n(v: unknown): number {
  if (typeof v === "number") return v;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function sameQuantiles(a: unknown, b: number[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return a.every((x, i) => n(x) === b[i]);
}

function quantileAt(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return lo === hi ? a : a + (b - a) * (pos - lo);
}

function computeTaskSummary(rows: unknown[], quantiles: number[]): Record<string, unknown> {
  const tasks = rows.filter((t): t is Record<string, unknown> => !!t && typeof t === "object");
  const series = (get: (t: Record<string, unknown>) => unknown): number[] => {
    const out: number[] = [];
    for (const t of tasks) {
      const v = get(t);
      if (v === undefined || v === null || v === "") continue;
      out.push(n(v));
    }
    return out;
  };
  const q = (get: (t: Record<string, unknown>) => unknown): number[] => {
    const sorted = series(get).sort((a, b) => a - b);
    return quantiles.map((x) => quantileAt(sorted, x));
  };
  const tm = (t: Record<string, unknown>): unknown => pickNum(t, "taskMetrics");
  const srm = (t: Record<string, unknown>): unknown => pickNum(tm(t), "shuffleReadMetrics");
  const sum = (t: Record<string, unknown>, a: string, b: string): number => n(pickNum(srm(t), a)) + n(pickNum(srm(t), b));
  const pushDist = (): Record<string, number[]> => {
    const keys = [
      "corruptMergedBlockChunks",
      "mergedFetchFallbackCount",
      "remoteMergedBlocksFetched",
      "localMergedBlocksFetched",
      "remoteMergedChunksFetched",
      "localMergedChunksFetched",
      "remoteMergedBytesRead",
      "localMergedBytesRead",
      "remoteMergedReqsDuration",
    ];
    const out: Record<string, number[]> = {};
    for (const k of keys) out[k] = q((t) => pickNum(pickNum(srm(t), "shufflePushReadMetrics"), k));
    return out;
  };

  const summary: Record<string, unknown> = { quantiles };
  summary.duration = q((t) => pickNum(t, "duration"));
  summary.executorDeserializeTime = q((t) => pickNum(tm(t), "executorDeserializeTime"));
  summary.executorDeserializeCpuTime = q((t) => pickNum(tm(t), "executorDeserializeCpuTime"));
  summary.executorRunTime = q((t) => pickNum(tm(t), "executorRunTime"));
  summary.executorCpuTime = q((t) => pickNum(tm(t), "executorCpuTime"));
  summary.resultSize = q((t) => pickNum(tm(t), "resultSize"));
  summary.jvmGcTime = q((t) => pickNum(tm(t), "jvmGcTime"));
  summary.resultSerializationTime = q((t) => pickNum(tm(t), "resultSerializationTime"));
  summary.gettingResultTime = q((t) => pickNum(t, "gettingResultTime"));
  summary.schedulerDelay = q((t) => pickNum(t, "schedulerDelay"));
  summary.peakExecutionMemory = q((t) => pickNum(tm(t), "peakExecutionMemory"));
  summary.memoryBytesSpilled = q((t) => pickNum(tm(t), "memoryBytesSpilled"));
  summary.diskBytesSpilled = q((t) => pickNum(tm(t), "diskBytesSpilled"));
  summary.inputMetrics = {
    bytesRead: q((t) => pickNum(pickNum(tm(t), "inputMetrics"), "bytesRead")),
    recordsRead: q((t) => pickNum(pickNum(tm(t), "inputMetrics"), "recordsRead")),
  };
  summary.outputMetrics = {
    bytesWritten: q((t) => pickNum(pickNum(tm(t), "outputMetrics"), "bytesWritten")),
    recordsWritten: q((t) => pickNum(pickNum(tm(t), "outputMetrics"), "recordsWritten")),
  };
  summary.shuffleReadMetrics = {
    readBytes: q((t) => sum(t, "localBytesRead", "remoteBytesRead")),
    readRecords: q((t) => pickNum(srm(t), "recordsRead")),
    remoteBlocksFetched: q((t) => pickNum(srm(t), "remoteBlocksFetched")),
    localBlocksFetched: q((t) => pickNum(srm(t), "localBlocksFetched")),
    fetchWaitTime: q((t) => pickNum(srm(t), "fetchWaitTime")),
    remoteBytesRead: q((t) => pickNum(srm(t), "remoteBytesRead")),
    remoteBytesReadToDisk: q((t) => pickNum(srm(t), "remoteBytesReadToDisk")),
    totalBlocksFetched: q((t) => sum(t, "remoteBlocksFetched", "localBlocksFetched")),
    remoteReqsDuration: q((t) => pickNum(srm(t), "remoteReqsDuration")),
    shufflePushReadMetricsDist: pushDist(),
  };
  summary.shuffleWriteMetrics = {
    writeBytes: q((t) => pickNum(pickNum(tm(t), "shuffleWriteMetrics"), "writeBytes")),
    writeRecords: q((t) => pickNum(pickNum(tm(t), "shuffleWriteMetrics"), "writeRecords")),
    writeTime: q((t) => pickNum(pickNum(tm(t), "shuffleWriteMetrics"), "writeTime")),
  };
  return summary;
}

async function taskSummaryResponse(
  index: WorkloadIndex,
  pathname: string,
  reqParams: Map<string, string>,
  req: Request,
  phase: string,
): Promise<Response> {
  const qsParam = reqParams.get("quantiles");
  const qs = qsParam
    ? qsParam
        .split(",")
        .map(Number)
        .filter((x) => Number.isFinite(x))
    : null;
  const all = index.byPath.get(pathname) ?? [];

  if (!qs) {
    const exact = pickExact(index, pathname, canonicalFromParams(reqParams), phase);
    if (exact) return serveFixture(exact, req, reqParams);
  } else {
    const phaseThenAll = [...all].sort((a, b) => Number(b.phase === phase) - Number(a.phase === phase));
    for (const e of phaseThenAll) {
      if (e.status >= 400) continue;
      const p = await payloadOf(e);
      if (sameQuantiles(pickNum(p, "quantiles"), qs)) return jsonResponse(p, {}, req);
    }
  }

  const taskListPath = pathname.replace(/\/taskSummary$/, "/taskList");
  const base = baseEntry(index, taskListPath, phase);
  const loaded = base ? await payloadOf(base) : undefined;
  const tasks = Array.isArray(loaded) ? loaded : [];
  const successful = tasks.filter((t) => String(pickNum(t, "status") ?? "").toUpperCase() === "SUCCESS");
  const notFound = all.find((e) => e.status >= 400);
  if (!successful.length && notFound) return serveFixture(notFound, req, reqParams);
  if (!tasks.length) {
    return notFound ? serveFixture(notFound, req, reqParams) : errorResponse("not_found", `No task summary for ${pathname}`, 404);
  }
  return jsonResponse(computeTaskSummary(successful.length ? successful : tasks, qs ?? DEFAULT_QUANTILES), {}, req);
}

/* ── synthesized: /storage/rdd/{id} (wrapped per SparkRddResponseSchema) ────────────────────────────────────── */

async function rddResponse(
  index: WorkloadIndex,
  capturedId: string,
  rest: string[],
  reqParams: Map<string, string>,
  req: Request,
  phase: string,
): Promise<Response> {
  const rddId = rest[2] ?? "";
  const pathname = `${appBase(capturedId)}/storage/rdd/${rddId}`;
  const entry = pick(index, pathname, reqParams, canonicalFromParams(reqParams), phase);
  if (entry) {
    if (entry.status >= 400) return serveFixture(entry, req, reqParams);
    const p = await payloadOf(entry);
    const alreadyWrapped = !!p && typeof p === "object" && "rdd" in (p as Record<string, unknown>);
    return jsonResponse(alreadyWrapped ? p : { rdd: p ?? null }, {}, req);
  }
  const listEntry = baseEntry(index, `${appBase(capturedId)}/storage/rdd`, phase);
  const list = listEntry ? await payloadOf(listEntry) : undefined;
  const element = Array.isArray(list) ? list.find((r) => String(pickNum(r, "id") ?? "") === rddId) : undefined;
  if (element === undefined) return errorResponse("not_found", `No storage RDD ${rddId}`, 404);
  return jsonResponse({ rdd: element }, {}, req);
}

/* ── synthesized: single-element fallbacks (/jobs/{id}, /stages/{id}, /sql/{id}) ────────────────────────────── */

async function fallbackElement(index: WorkloadIndex, capturedId: string, rest: string[], phase: string): Promise<unknown | undefined> {
  const listOf = async (sub: string): Promise<unknown[] | undefined> => {
    const entry = baseEntry(index, `${appBase(capturedId)}/${sub}`, phase);
    const payload = entry ? await payloadOf(entry) : undefined;
    return Array.isArray(payload) ? payload : undefined;
  };
  if (rest.length === 2 && rest[0] === "jobs") {
    const list = await listOf("jobs");
    return list?.find((j) => String(pickNum(j, "jobId") ?? "") === rest[1]);
  }
  if (rest.length === 2 && rest[0] === "stages") {
    const list = await listOf("stages");
    const matches = list?.filter((s) => String(pickNum(s, "stageId") ?? "") === rest[1]);
    return matches?.length ? matches : undefined;
  }
  if (rest.length === 2 && rest[0] === "sql") {
    const list = await listOf("sql");
    return list?.find((s) => String(pickNum(s, "id") ?? "") === rest[1]);
  }
  return undefined;
}

/* ── fixture-backed routes ──────────────────────────────────────────────────────────────────────────────────── */

async function fixtureResponse(appId: string, rest: string[], url: URL, req: Request): Promise<Response> {
  const sc = resolveScenario(appId);
  const index = await loadIndex(sc);
  const capturedId = index.appId ?? appId;
  const reqParams = paramsFromSearch(url.searchParams);
  const reqQuery = canonicalFromParams(reqParams);

  if (rest.length === 4 && rest[0] === "stages" && rest[3] === "taskList") {
    return taskListResponse(index, mapPath(capturedId, rest), reqParams, req, sc.phase);
  }
  if (rest.length === 4 && rest[0] === "stages" && rest[3] === "taskSummary") {
    return taskSummaryResponse(index, mapPath(capturedId, rest), reqParams, req, sc.phase);
  }
  if (rest.length === 3 && rest[0] === "storage" && rest[1] === "rdd") {
    return rddResponse(index, capturedId, rest, reqParams, req, sc.phase);
  }

  const pathname = mapPath(capturedId, rest);
  const entry = pick(index, pathname, reqParams, reqQuery, sc.phase);
  if (entry) return serveFixture(entry, req, reqParams);

  const fallback = await fallbackElement(index, capturedId, rest, sc.phase);
  if (fallback !== undefined) return jsonResponse(fallback, {}, req);

  return errorResponse("not_found", `No Spark REST resource at ${pathname}`, 404);
}

/* ── entrypoint ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Spark slice handler. Returns `null` for anything outside `spark/...` and outside the RM identity of its own fixture
 * apps, so `mock-api.ts` falls through to the next extension (and eventually the generated router).
 */
export async function handleSpark(req: Request, path: string, url: URL): Promise<Response | null> {
  const rmIdentity = await rmIdentityResponse(path, req);
  if (rmIdentity) return rmIdentity;

  const segs = path.split("/").filter(Boolean);
  if (segs[0] !== "spark") return null;
  const appId = decodeURIComponent(segs[1] ?? "");
  if (!appId) return errorResponse("not_found", "Missing Spark application id in the request path", 404);
  const rest = segs.slice(2);

  if (rest.length === 1 && rest[0] === "source") return sourceResponse(appId, req);
  if (appId === UNAVAILABLE_APP) {
    return errorResponse("unavailable", "The Spark History Server has no event log for this application.", 503, {
      hint: "Event logging may be disabled, or the log may have been cleaned up.",
    });
  }
  if (rest[0] === "dag") return dagResponse(appId, rest, req);
  return fixtureResponse(appId, rest, url, req);
}
