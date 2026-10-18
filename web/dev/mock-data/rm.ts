/**
 * JSON builders mirroring Hadoop 3.4.3 ResourceManager REST DAOs (RMWebServices).
 * Field names/wrappers come from the DAO sources (JAXB field access, "natural" JSON, null fields omitted).
 */
import {
  CLUSTER_TS,
  JHS,
  RM_HOST,
  SHS,
  type AppState,
  type MockApp,
  type MockAttempt,
  type MockCluster,
  type MockNode,
} from "./cluster.ts";
import { Rng, iso8601, longMap, pad, resourceInfo, round, seedOf } from "./util.ts";
import { queueAbsCapacityPct, queueCapacityMb } from "./scheduler.ts";

export class RmError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super("rm error");
  }
}

/** Hadoop's `RemoteException` JSON. */
export function remoteException(status: number, exception: string, javaClassName: string, message: string): RmError {
  return new RmError(status, { RemoteException: { exception, message, javaClassName } });
}

const notFound = (msg: string) =>
  remoteException(404, "NotFoundException", "org.apache.hadoop.yarn.webapp.NotFoundException", `java.lang.Exception: ${msg}`);
const badRequest = (msg: string) => remoteException(400, "BadRequestException", "org.apache.hadoop.yarn.webapp.BadRequestException", msg);

export const ALL_STATES: AppState[] = ["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED", "RUNNING", "FINISHED", "FAILED", "KILLED"];
const FINAL_STATUSES = ["UNDEFINED", "SUCCEEDED", "FAILED", "KILLED"];

// ------------------------------------------------------------------ ids / nodes

export const nodeIdOf = (n: MockNode) => `${n.host}:${n.port}`;
export const nodeHttpOf = (n: MockNode) => `${n.host}:${n.httpPort}`;
export const containerIdOf = (app: MockApp, attempt: number, n: number) =>
  `container_${CLUSTER_TS}_${pad(app.num, 4)}_${pad(attempt, 2)}_${pad(n, 6)}`;
export const attemptIdOf = (app: MockApp, attempt: number) => `appattempt_${CLUSTER_TS}_${pad(app.num, 4)}_${pad(attempt, 6)}`;

function validateAppId(id: string) {
  if (!id.startsWith("application"))
    throw badRequest(`Invalid ApplicationId prefix: ${id}. The valid ApplicationId should start with prefix application`);
  if (!/^application_\d+_\d+$/.test(id)) throw badRequest(`For input string: "${id}"`);
}

function appOrThrow(c: MockCluster, id: string): MockApp {
  validateAppId(id);
  const app = c.getApp(id);
  if (!app) throw notFound(`app with id: ${id} not found`);
  return app;
}

const prefixOfPending = (s: AppState) => s === "NEW" || s === "NEW_SAVING" || s === "SUBMITTED" || s === "ACCEPTED";

function partitionMembers(c: MockCluster, label: string): MockNode[] {
  return c.nodes.filter((n) => n.schedulable && (label === "" ? n.labels.length === 0 : n.labels.includes(label)));
}

// ------------------------------------------------------------------ apps

export function queueUsagePct(c: MockCluster, a: MockApp): number {
  const cap = queueCapacityMb(c, a.queue, a.label);
  return cap > 0 ? round(((a.containers * a.cmb) / cap) * 100, 4) : 0;
}

export function appJson(c: MockCluster, a: MockApp, deSelects: ReadonlySet<string>) {
  const pending = prefixOfPending(a.state);
  const finishedLike = a.state === "FINISHED" || a.state === "FAILED" || a.state === "KILLED";
  const attempt = a.attempts.length ? a.attempts[a.attempts.length - 1]! : undefined;
  const amNode = attempt && attempt.nodeIdx >= 0 ? c.nodes[attempt.nodeIdx]! : undefined;
  const notReady = pending || (a.noTracking && !finishedLike);
  let trackingUrl: string | undefined;
  if (!notReady) {
    if (a.state === "RUNNING") trackingUrl = `http://${RM_HOST}/proxy/${a.id}/`;
    else if (a.noTracking) trackingUrl = "http://N/A";
    else if (a.type === "MAPREDUCE") trackingUrl = `http://${JHS}/jobhistory/job/job_${CLUSTER_TS}_${pad(a.num, 4)}`;
    else if (a.type === "SPARK") trackingUrl = `http://${SHS}/history/${a.id}/1`;
    else trackingUrl = `http://${RM_HOST}/cluster/app/${a.id}`;
  }
  const running = a.state === "RUNNING";
  const allocMb = running ? a.containers * a.cmb : 0;
  const allocVc = running ? a.containers * a.cvc : 0;
  const elapsed = c.elapsed(a);
  const am = amNode ? `container_${CLUSTER_TS}_${pad(a.num, 4)}_${pad(attempt!.id, 2)}_000001` : undefined;
  const prng = new Rng(a.seed);
  const out: Record<string, unknown> = {
    id: a.id,
    user: a.user,
    name: a.name,
    queue: a.queue,
    state: a.state,
    finalStatus: a.finalStatus,
    progress: a.progress,
    trackingUI: notReady ? "UNASSIGNED" : a.finishedTime === 0 ? "ApplicationMaster" : "History",
    ...(trackingUrl ? { trackingUrl } : {}),
    diagnostics: a.diag,
    clusterId: CLUSTER_TS,
    rmClusterId: "mock-yarn",
    applicationType: a.type,
    applicationTags: a.tags.join(","),
    priority: a.priority,
    startedTime: a.startedTime,
    launchTime: a.launchTime,
    finishedTime: a.finishedTime,
    elapsedTime: elapsed,
    ...(amNode && am
      ? { amContainerLogs: `http://${nodeHttpOf(amNode)}/node/containerlogs/${am}/${a.user}`, amHostHttpAddress: nodeHttpOf(amNode) }
      : {}),
    ...(amNode ? { amRPCAddress: `${amNode.host}:${30000 + prng.int(0, 9999)}` } : {}),
    masterNodeId: amNode ? nodeIdOf(amNode) : "",
    allocatedMB: allocMb,
    allocatedVCores: allocVc,
    // The mock cluster simulates a GPU resource type being configured, so these are real numbers (0 when unused) rather
    // than the -1 an RM without GPU support reports.
    allocatedGpus: running && a.label === "gpu" ? 1 : 0,
    reservedGpus: 0,
    reservedMB: running ? a.reservedMb : 0,
    reservedVCores: running ? a.reservedVc : 0,
    runningContainers: running ? a.containers : 0,
    memorySeconds: a.memSec,
    vcoreSeconds: a.vcSec,
    queueUsagePercentage: running ? queueUsagePct(c, a) : 0,
    clusterUsagePercentage: running ? round((allocMb / Math.max(1, clusterTotalMb(c))) * 100, 4) : 0,
    resourceSecondsMap: longMap({ "memory-mb": a.memSec, vcores: a.vcSec }),
    preemptedResourceMB: a.preemptedMb,
    preemptedResourceVCores: Math.floor(a.preemptedMb / 2048),
    numNonAMContainerPreempted: a.preemptedNonAm,
    numAMContainerPreempted: a.preemptedAm,
    preemptedMemorySeconds: a.preemptedMb * 30,
    preemptedVcoreSeconds: Math.floor(a.preemptedMb / 2048) * 30,
    preemptedResourceSecondsMap: longMap({ "memory-mb": a.preemptedMb * 30, vcores: Math.floor(a.preemptedMb / 2048) * 30 }),
    resourceRequests: deSelects.has("resourcerequests") ? [] : resourceRequests(a),
    logAggregationStatus: a.logAgg,
    unmanagedApplication: a.unmanaged,
    appNodeLabelExpression: a.label,
  };
  if (!deSelects.has("amnodelabelexpression") && !a.unmanaged) out.amNodeLabelExpression = a.label;
  if (deSelects.has("appnodelabelexpression")) delete out.appNodeLabelExpression;
  if (deSelects.has("amnodelabelexpression")) delete out.amNodeLabelExpression;
  if (!deSelects.has("resourceinfo") && (a.state === "ACCEPTED" || running)) out.resourceInfo = appResourceInfo(a);
  if (!deSelects.has("timeouts")) out.timeouts = { timeout: timeoutsOf(c, a) };
  return out;
}

function clusterTotalMb(c: MockCluster): number {
  return c.defaultNodes().reduce((s, n) => s + n.totalMb, 0);
}

function resourceRequests(a: MockApp) {
  const mk = (priority: number, num: number, mb: number, vc: number) => ({
    priority,
    allocationRequestId: 0,
    resourceName: "*",
    capability: resourceInfo(mb, vc),
    numContainers: num,
    relaxLocality: true,
    nodeLabelExpression: a.label,
    executionTypeRequest: { executionType: "GUARANTEED", enforceExecutionType: false },
  });
  if (a.state === "ACCEPTED") return [mk(0, 1, Math.max(a.cmb, 1024), a.cvc)];
  if (a.state === "RUNNING" && a.containers < a.planContainers) return [mk(1, a.planContainers - a.containers, a.cmb, a.cvc)];
  return [];
}

function appResourceInfo(a: MockApp) {
  const running = a.state === "RUNNING";
  const used = running ? [a.containers * a.cmb, a.containers * a.cvc] : [0, 0];
  const pend =
    a.state === "ACCEPTED"
      ? [a.planContainers * a.cmb, a.planContainers * a.cvc]
      : a.containers < a.planContainers && running
        ? [(a.planContainers - a.containers) * a.cmb, (a.planContainers - a.containers) * a.cvc]
        : [0, 0];
  return {
    resourceUsagesByPartition: [
      {
        partitionName: a.label,
        used: resourceInfo(used[0]!, used[1]!),
        reserved: resourceInfo(running ? a.reservedMb : 0, running ? a.reservedVc : 0),
        pending: resourceInfo(pend[0]!, pend[1]!),
        amUsed: resourceInfo(running && !a.unmanaged ? a.cmb : 0, running && !a.unmanaged ? a.cvc : 0),
        amLimit: resourceInfo(19660, 1),
        userAmLimit: resourceInfo(19660, 1),
      },
    ],
  };
}

function timeoutsOf(c: MockCluster, a: MockApp) {
  if (a.lifetimeSec < 0) return [{ type: "LIFETIME", expiryTime: "UNLIMITED", remainingTimeInSeconds: -1 }];
  const expiry = a.startedTime + a.lifetimeSec * 1000;
  const done = a.state === "FINISHED" || a.state === "FAILED" || a.state === "KILLED";
  return [
    { type: "LIFETIME", expiryTime: iso8601(expiry), remainingTimeInSeconds: done ? 0 : Math.max(0, Math.floor((expiry - c.now) / 1000)) },
  ];
}

function csv(v: string | null): string[] {
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function longParam(q: URLSearchParams, name: string, dflt: number): number {
  const v = q.get(name);
  if (v === null || v === "") return dflt;
  if (!/^-?\d+$/.test(v)) throw badRequest(`Invalid number format: ${name}=${v}`);
  return Number(v);
}

export function filteredApps(c: MockCluster, q: URLSearchParams): MockApp[] {
  const stateParams = [...csv(q.get("states")), ...csv(q.get("applicationStates")), ...csv(q.get("state"))].map((s) => s.toUpperCase());
  for (const s of stateParams) {
    if (!ALL_STATES.includes(s as AppState))
      throw badRequest(`Invalid application-state ${s} specified. It should be one of ${ALL_STATES.join(", ")}`);
  }
  const states = new Set(stateParams);
  const finalStatus = q.get("finalStatus")?.toUpperCase();
  if (finalStatus && !FINAL_STATUSES.includes(finalStatus))
    throw badRequest(`Invalid application-state ${finalStatus} specified. It should be one of ${FINAL_STATUSES.join(", ")}`);
  const user = q.get("user");
  const queue = q.get("queue");
  const limitRaw = q.get("limit");
  let limit = Infinity;
  if (limitRaw !== null && limitRaw !== "") {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0) throw badRequest("limit value must be greater then 0");
  }
  const sb = longParam(q, "startedTimeBegin", 0);
  const se = longParam(q, "startedTimeEnd", Number.MAX_SAFE_INTEGER);
  const fb = longParam(q, "finishedTimeBegin", 0);
  const fe = longParam(q, "finishedTimeEnd", Number.MAX_SAFE_INTEGER);
  const types = new Set(csv(q.get("applicationTypes")).map((s) => s.toUpperCase()));
  const tags = new Set(csv(q.get("applicationTags")).map((s) => s.toLowerCase()));
  const name = q.get("name");
  const out: MockApp[] = [];
  for (let i = c.apps.length - 1; i >= 0 && out.length < limit; i--) {
    const a = c.apps[i]!;
    if (states.size && !states.has(a.state)) continue;
    if (finalStatus && a.finalStatus !== finalStatus) continue;
    if (user && a.user !== user) continue;
    if (queue && a.queue !== queue && !a.queue.endsWith(`.${queue}`)) continue;
    if (a.startedTime < sb || a.startedTime > se) continue;
    if (fb > 0 || fe !== Number.MAX_SAFE_INTEGER) if (a.finishedTime < fb || a.finishedTime > fe) continue;
    if (types.size && !types.has(a.type.toUpperCase())) continue;
    if (tags.size && !a.tags.some((t) => tags.has(t.toLowerCase()))) continue;
    if (name && a.name !== name) continue;
    out.push(a);
  }
  return out;
}

export function appsResponse(c: MockCluster, q: URLSearchParams) {
  const des = new Set(csv(q.get("deSelects")).map((s) => s.toLowerCase()));
  const list = filteredApps(c, q).map((a) => appJson(c, a, des));
  return { apps: list.length ? { app: list } : null };
}

export function appResponse(c: MockCluster, id: string, q: URLSearchParams) {
  const des = new Set(csv(q.get("deSelects")).map((s) => s.toLowerCase()));
  return { app: appJson(c, appOrThrow(c, id), des) };
}

export function appStateResponse(c: MockCluster, id: string) {
  return { state: appOrThrow(c, id).state };
}
export function appPriorityResponse(c: MockCluster, id: string) {
  return { priority: appOrThrow(c, id).priority };
}
export function appQueueResponse(c: MockCluster, id: string) {
  return { queue: appOrThrow(c, id).queue };
}
export function appTimeoutsResponse(c: MockCluster, id: string, type?: string) {
  const a = appOrThrow(c, id);
  const list = timeoutsOf(c, a);
  if (type) {
    const t = list.find((x) => x.type === type.toUpperCase());
    if (!t) throw notFound(`Timeout type '${type}' not configured for app ${id}`);
    return { timeout: t };
  }
  return { timeouts: { timeout: list } };
}

export function appStatisticsResponse(c: MockCluster, q: URLSearchParams) {
  const stateParams = csv(q.get("states")).map((s) => s.toUpperCase());
  for (const s of stateParams) {
    if (!ALL_STATES.includes(s as AppState))
      throw badRequest(`Invalid application-state ${s} specified. It should be one of ${ALL_STATES.join(", ")}`);
  }
  const states = (stateParams.length ? stateParams : ALL_STATES) as AppState[];
  const typeParams = csv(q.get("applicationTypes"));
  const types = typeParams.length ? typeParams : ["*"];
  const counts = new Map<string, number>();
  for (const a of c.apps) counts.set(`${a.state}|${a.type.toLowerCase()}`, (counts.get(`${a.state}|${a.type.toLowerCase()}`) ?? 0) + 1);
  const statItem: Array<{ state: string; type: string; count: number }> = [];
  for (const s of states) {
    for (const t of types) {
      let count = 0;
      if (t === "*") {
        for (const [k, v] of counts) if (k.startsWith(`${s}|`)) count += v;
      } else count = counts.get(`${s}|${t.toLowerCase()}`) ?? 0;
      statItem.push({ state: s, type: t, count });
    }
  }
  return { appStatInfo: { statItem } };
}

// ------------------------------------------------------------------ attempts / containers

export function attemptJson(c: MockCluster, a: MockApp, at: MockAttempt) {
  const node = at.nodeIdx >= 0 ? c.nodes[at.nodeIdx] : undefined;
  const cid = node ? containerIdOf(a, at.id, 1) : "";
  const done = at.state === "FAILED" || at.state === "FINISHED" || at.state === "KILLED";
  return {
    id: at.id,
    startTime: at.startTime,
    finishedTime: at.finishedTime,
    containerId: cid,
    nodeHttpAddress: node ? nodeHttpOf(node) : "",
    nodeId: node ? nodeIdOf(node) : "",
    logsLink: node
      ? done
        ? `http://${JHS}/jobhistory/logs/${nodeIdOf(node)}/${cid}/${cid}/${a.user}`
        : `http://${nodeHttpOf(node)}/node/containerlogs/${cid}/${a.user}`
      : "",
    blacklistedNodes: "",
    ...(node ? { nodesBlacklistedBySystem: "" } : {}),
    appAttemptId: attemptIdOf(a, at.id),
    exportPorts: node ? (a.type === "yarn-service" ? JSON.stringify({ http: [8080] }) : "{}") : "",
    appAttemptState: at.state,
  };
}

export function attemptsResponse(c: MockCluster, id: string) {
  const a = appOrThrow(c, id);
  return { appAttempts: { appAttempt: a.attempts.map((at) => attemptJson(c, a, at)) } };
}

function parseAttemptId(a: MockApp, aid: string): MockAttempt {
  const m = /^appattempt_(\d+)_(\d+)_(\d+)$/.exec(aid);
  if (!m) throw badRequest(`Invalid AppAttemptId: ${aid}`);
  const at = a.attempts.find((x) => attemptIdOf(a, x.id) === aid);
  if (!at) throw notFound(`appattempt with id: ${aid} not found`);
  return at;
}

export type ContainerJson = Record<string, unknown> & { containerId: string; nodeId: string };

function containerJson(c: MockCluster, a: MockApp, at: MockAttempt, n: number): ContainerJson {
  const members = partitionMembers(c, a.label);
  const finishedAttempt = at.state === "FAILED" || at.state === "FINISHED" || at.state === "KILLED";
  const nodeIdx = n === 1 && at.nodeIdx >= 0 ? at.nodeIdx : (members[(a.num * 7 + n * 3) % Math.max(1, members.length)] ?? c.nodes[1]!).idx;
  const node = c.nodes[nodeIdx]!;
  const started = Math.min(at.startTime + 1500 + n * 350, finishedAttempt ? at.finishedTime : c.now);
  const finished = finishedAttempt ? at.finishedTime : 0;
  const cid = containerIdOf(a, at.id, n);
  const mb = a.cmb;
  const vc = a.cvc;
  return {
    containerId: cid,
    allocatedMB: mb,
    allocatedVCores: vc,
    assignedNodeId: nodeIdOf(node),
    priority: n === 1 ? 0 : 1,
    startedTime: started,
    finishedTime: finished,
    elapsedTime: Math.max(0, (finished || c.now) - started),
    ...(finishedAttempt
      ? {
          diagnosticsInfo:
            n === 1
              ? "Container released on a *lost* node"
              : "Container killed by the ApplicationMaster.\nContainer killed on request. Exit code is 143\nContainer exited with a non-zero exit code 143",
        }
      : {}),
    logUrl: `http://${nodeHttpOf(node)}/node/containerlogs/${cid}/${a.user}`,
    containerExitStatus: finishedAttempt ? (n === 1 ? -100 : 143) : -1000,
    containerState: finishedAttempt ? "COMPLETE" : "RUNNING",
    nodeHttpAddress: `http://${nodeHttpOf(node)}`,
    nodeId: nodeIdOf(node),
    allocatedResources: [
      { key: "memory-mb", value: String(mb) },
      { key: "vcores", value: String(vc) },
    ],
    ...(a.type === "yarn-service" && n > 1 ? { exposedPorts: JSON.stringify({ http: [8080 + n] }) } : {}),
  };
}

export function containersResponse(c: MockCluster, id: string, aid: string) {
  const a = appOrThrow(c, id);
  const at = parseAttemptId(a, aid);
  const finishedAttempt = at.state === "FAILED" || at.state === "FINISHED" || at.state === "KILLED";
  const isCurrent = at === a.attempts[a.attempts.length - 1];
  let count = 0;
  if (a.state === "RUNNING" && isCurrent) count = a.containers;
  else if (finishedAttempt && a.attempts.length > 1 && !isCurrent) count = 3; // earlier failed attempt of a multi-attempt app
  const list = [];
  for (let n = 1; n <= Math.min(count, 500); n++) list.push(containerJson(c, a, at, n));
  return { containers: list.length ? { container: list } : null };
}

export function containerResponse(c: MockCluster, id: string, aid: string, cid: string) {
  const a = appOrThrow(c, id);
  const at = parseAttemptId(a, aid);
  const m = /^container_(?:e\d+_)?\d+_(\d+)_(\d+)_(\d+)$/.exec(cid);
  if (!m) throw badRequest(`Invalid ContainerId: ${cid}`);
  const n = Number(m[3]);
  if (Number(m[1]) !== a.num || Number(m[2]) !== at.id || n < 1 || n > Math.max(a.containers, 3))
    throw notFound(`container with id: ${cid} not found`);
  return { container: containerJson(c, a, at, n) };
}

/** `/containers/{cid}` (no app/attempt in path). */
export function containerByIdResponse(c: MockCluster, cid: string) {
  const m = /^container_(?:e\d+_)?\d+_(\d+)_(\d+)_(\d+)$/.exec(cid);
  if (!m) throw badRequest(`Invalid ContainerId: ${cid}`);
  const a = c.getApp(`application_${CLUSTER_TS}_${m[1]}`);
  if (!a) throw notFound(`container with id: ${cid} not found`);
  return containerResponse(c, a.id, attemptIdOf(a, Number(m[2])), cid);
}

/** All live container ids of a node (for the NM endpoints). */
export function nodeContainers(c: MockCluster, node: MockNode) {
  const out: Array<{ app: MockApp; json: ContainerJson; at: MockAttempt; n: number }> = [];
  for (let i = c.apps.length - 1; i >= 0 && out.length < 400; i--) {
    const a = c.apps[i]!;
    if (a.state !== "RUNNING") continue;
    const at = a.attempts[a.attempts.length - 1]!;
    for (let n = 1; n <= Math.min(a.containers, 200); n++) {
      const j = containerJson(c, a, at, n);
      if (j.nodeId === nodeIdOf(node)) out.push({ app: a, json: j, at, n });
    }
  }
  return out;
}

// ------------------------------------------------------------------ cluster info / metrics

export function clusterInfoResponse(c: MockCluster, haState: "ACTIVE" | "STANDBY" = "ACTIVE") {
  return {
    clusterInfo: {
      id: CLUSTER_TS,
      startedOn: c.startedOn,
      state: "STARTED",
      haState,
      rmStateStoreName: "org.apache.hadoop.yarn.server.resourcemanager.recovery.ZKRMStateStore",
      resourceManagerVersion: "3.4.3",
      resourceManagerBuildVersion: "3.4.3 from 5a7cd8b4 by mock source checksum 0123456789abcdef0123456789abcdef",
      resourceManagerVersionBuiltOn: "2026-01-01T00:00Z",
      hadoopVersion: "3.4.3",
      hadoopBuildVersion: "3.4.3 from 5a7cd8b4 by mock source checksum 0123456789abcdef0123456789abcdef",
      hadoopVersionBuiltOn: "2026-01-01T00:00Z",
      haZooKeeperConnectionState: "Connected to ZooKeeper at zk1.mock.local:2181,zk2.mock.local:2181,zk3.mock.local:2181",
      subClusterId: "mock-yarn",
    },
  };
}

export function metricsResponse(c: MockCluster) {
  const g = c.agg;
  const total = c.defaultNodes();
  const totalMb = total.reduce((s, n) => s + n.totalMb, 0);
  const totalVc = total.reduce((s, n) => s + n.totalVc, 0);
  const count = (s: string) => c.nodes.filter((n) => n.state === s).length;
  const allSched = c.nodes.filter((n) => n.schedulable);
  const allMb = allSched.reduce((s, n) => s + n.totalMb, 0);
  const allVc = allSched.reduce((s, n) => s + n.totalVc, 0);
  const rng = new Rng(seedOf(c.version, 99));
  return {
    clusterMetrics: {
      appsSubmitted: g.submitted,
      appsCompleted: g.completed,
      appsPending: g.pending,
      appsRunning: g.running,
      appsFailed: g.failed,
      appsKilled: g.killed,
      reservedMB: g.reservedMb,
      availableMB: Math.max(0, totalMb - g.allocMb),
      allocatedMB: g.allocMb,
      pendingMB: g.pendingMb,
      reservedVirtualCores: g.reservedVc,
      availableVirtualCores: Math.max(0, totalVc - g.allocVc),
      allocatedVirtualCores: g.allocVc,
      pendingVirtualCores: g.pendingVc,
      containersAllocated: g.containers,
      containersReserved: g.reservedMb > 0 ? 1 : 0,
      containersPending: g.pendingContainers,
      totalMB: totalMb,
      utilizedMB: g.allocMb,
      totalVirtualCores: totalVc,
      utilizedVirtualCores: g.allocVc,
      utilizedMBPercent: Math.floor((g.allocMb * 100) / Math.max(1, totalMb)),
      utilizedVirtualCoresPercent: Math.floor((g.allocVc * 100) / Math.max(1, totalVc)),
      rmSchedulerBusyPercent: rng.int(2, 18),
      totalNodes: c.nodes.length,
      lostNodes: count("LOST"),
      unhealthyNodes: count("UNHEALTHY"),
      decommissioningNodes: count("DECOMMISSIONING"),
      decommissionedNodes: count("DECOMMISSIONED"),
      rebootedNodes: count("REBOOTED"),
      activeNodes: count("RUNNING"),
      shutdownNodes: count("SHUTDOWN"),
      containerAssignedPerSecond: rng.int(0, 25),
      totalUsedResourcesAcrossPartition: resourceInfo(g.allocMb + g.gpuMb, g.allocVc + g.gpuVc),
      totalClusterResourcesAcrossPartition: resourceInfo(allMb, allVc),
      totalReservedResourcesAcrossPartition: resourceInfo(g.reservedMb, g.reservedVc),
      totalAllocatedContainersAcrossPartition:
        g.containers + [...c.apps].reduce((s, a) => (a.state === "RUNNING" && a.label ? s + a.containers : s), 0),
      crossPartitionMetricsAvailable: true,
      rmEventQueueSize: rng.int(0, 3),
      schedulerEventQueueSize: rng.int(0, 3),
    },
  };
}

// ------------------------------------------------------------------ nodes

export function nodeJson(c: MockCluster, n: MockNode) {
  const sched = n.schedulable;
  const seed = new Rng(seedOf(n.idx, 0x4e0de));
  const cpuUse = sched ? round(Math.min(0.99, n.usedVc / n.totalVc + seed.float() * 0.1), 4) : 0;
  const phys = Math.floor(n.totalMb * 0.92);
  const usedPhys = Math.min(phys, Math.floor(n.usedMb * 0.7 + 800 + seed.int(0, 400)));
  const out: Record<string, unknown> = {
    rack: n.rack,
    state: n.state,
    id: nodeIdOf(n),
    nodeHostName: n.host,
    nodeHTTPAddress: nodeHttpOf(n),
    lastHealthUpdate: c.now - n.lastHealthAge,
    version: n.version,
    healthReport: n.healthReport,
    numContainers: sched ? n.containers : 0,
    usedMemoryMB: sched ? n.usedMb : 0,
    availMemoryMB: sched ? n.totalMb - n.usedMb : 0,
    usedVirtualCores: sched ? n.usedVc : 0,
    availableVirtualCores: sched ? n.totalVc - n.usedVc : 0,
    memUtilization: sched ? round((usedPhys * 100) / phys, 2) : 0,
    cpuUtilization: sched ? round(cpuUse * 100, 2) : 0,
    numRunningOpportContainers: 0,
    usedMemoryOpportGB: 0,
    usedVirtualCoresOpport: 0,
    numQueuedContainers: 0,
    nodeLabels: [...n.labels].sort(),
    allocationTags: sched && n.containers > 0 ? { allocationTagInfo: [{ allocationTag: "spark", allocationsCount: n.containers }] } : {},
    resourceUtilization: {
      nodePhysicalMemoryMB: sched ? usedPhys : 0,
      nodeVirtualMemoryMB: sched ? Math.floor(usedPhys * 2.1) : 0,
      nodeCPUUsage: cpuUse,
      aggregatedContainersPhysicalMemoryMB: sched ? Math.floor(n.usedMb * 0.7) : 0,
      aggregatedContainersVirtualMemoryMB: sched ? Math.floor(n.usedMb * 1.4) : 0,
      containersCPUUsage: sched ? round(Math.min(0.99, n.usedVc / n.totalVc), 4) : 0,
    },
    nodeAttributesInfo: {
      nodeAttributeInfo: [{ prefix: "nm.yarn.io", name: "os", type: "STRING", value: "linux" }],
    },
    totalResource: resourceInfo(n.totalMb, n.totalVc),
    subClusterId: "mock-yarn",
  };
  if (sched) {
    out.usedResource = resourceInfo(n.usedMb, n.usedVc);
    out.availableResource = resourceInfo(n.totalMb - n.usedMb, n.totalVc - n.usedVc);
  }
  return out;
}

export function nodesResponse(c: MockCluster, q: URLSearchParams) {
  const states = new Set(csv(q.get("states")).map((s) => s.toUpperCase()));
  const valid = ["NEW", "RUNNING", "UNHEALTHY", "DECOMMISSIONING", "DECOMMISSIONED", "LOST", "REBOOTED", "SHUTDOWN"];
  for (const s of states)
    if (!valid.includes(s))
      throw remoteException(
        400,
        "IllegalArgumentException",
        "java.lang.IllegalArgumentException",
        `No enum constant org.apache.hadoop.yarn.api.records.NodeState.${s}`,
      );
  const list = c.nodes.filter((n) => !states.size || states.has(n.state)).map((n) => nodeJson(c, n));
  return { nodes: list.length ? { node: list } : null };
}

export function nodeResponse(c: MockCluster, id: string) {
  const n = c.nodes.find((x) => nodeIdOf(x) === id || x.host === id);
  if (!n) throw notFound(`nodeId, ${id}, is not found`);
  return { node: nodeJson(c, n) };
}

// ------------------------------------------------------------------ labels

const LABEL_EXCLUSIVITY: Record<string, boolean> = { gpu: true, highmem: false };

export function labelInfo(c: MockCluster, name: string, full: boolean) {
  const members = partitionMembers(c, name);
  const availMb = members.reduce((s, n) => s + n.totalMb - n.usedMb, 0);
  const availVc = members.reduce((s, n) => s + n.totalVc - n.usedVc, 0);
  return full
    ? {
        name,
        exclusivity: LABEL_EXCLUSIVITY[name]!,
        partitionInfo: { resourceAvailable: resourceInfo(availMb, availVc) },
        activeNMs: members.filter((n) => n.state === "RUNNING").length,
      }
    : { name, exclusivity: LABEL_EXCLUSIVITY[name]! };
}

export const LABELS = ["gpu", "highmem"];

export function nodeLabelsResponse(c: MockCluster) {
  return { nodeLabelInfo: LABELS.map((l) => labelInfo(c, l, true)) };
}

export function nodeToLabelsResponse(c: MockCluster) {
  return {
    nodeToLabels: {
      entry: c.nodes
        .filter((n) => n.labels.length)
        .map((n) => ({ key: nodeIdOf(n), value: { nodeLabelInfo: n.labels.map((l) => labelInfo(c, l, false)) } })),
    },
  };
}

export function labelMappingsResponse(c: MockCluster) {
  return {
    labelsToNodes: {
      entry: LABELS.map((l) => {
        const members = c.nodes.filter((n) => n.labels.includes(l));
        const info = labelInfo(c, l, true) as { partitionInfo: unknown };
        return {
          key: { name: l, exclusivity: LABEL_EXCLUSIVITY[l]! },
          value: { nodes: members.map(nodeIdOf), partitionInfo: info.partitionInfo },
        };
      }),
    },
  };
}

// ------------------------------------------------------------------ misc

export function schedulerActivitiesResponse(c: MockCluster) {
  return {
    activities: {
      nodeId: "N/A",
      timestamp: c.now,
      dateTime: new Date(c.now).toString(),
      diagnostic: "waiting for next allocation",
    },
  };
}

export { validateAppId, queueAbsCapacityPct };
