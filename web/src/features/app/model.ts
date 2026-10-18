/**
 * Pure model for the YARN application-detail domain: legacy labels, derivations and field ids.
 *
 * Every derivation here mirrors the *legacy* RM page it replaces, with the Java source quoted next to it so the parity
 * harness can audit the mapping (PLAN §8 P0/P2). Nothing in this file touches the DOM or React.
 *
 * Field ids follow docs/contracts/parity-dom.md `<entity>.<path>`; values the legacy UI derives (no REST key) carry the
 * `derived.` prefix and document their canonical `data-yv` encoding:
 *   - numeric derivations -> the raw NUMBER as a string (data-yfmt tells the harness the normaliser)
 *   - text derivations    -> the derived value in the legacy rendering, so differential comparison is text-to-text
 */
import type { App, AppAttempt } from "~/api/schemas";

// --------------------------------------------------------------------------------------------------------- constants

export const UNAVAILABLE = "N/A";
export const NOT_SET = "<Not set>";
/** Label-expression default printed by the legacy page when the value is an empty string (the RM's default partition). */
export const DEFAULT_PARTITION = "<DEFAULT_PARTITION>";
export const PRIORITY_HINT = "Higher Integer value indicates higher priority";
export const FINAL_STATUS_UNDEFINED_TEXT = "Not finished yet";

const APP_FINAL_STATES: Record<string, true> = { FINISHED: true, FAILED: true, KILLED: true };
const APP_LIVE_STATES: Record<string, true> = { NEW: true, NEW_SAVING: true, SUBMITTED: true, ACCEPTED: true, RUNNING: true };

/** `Apps.isApplicationFinalState` (hadoop-yarn-common Apps.java). Durable guard used across the slice. */
export const isAppFinal = (state: string | null | undefined): boolean => !!state && APP_FINAL_STATES[state] === true;
export const isAppLive = (state: string | null | undefined): boolean => !!state && APP_LIVE_STATES[state] === true;

/** `AppBlock.clarifyAppState` (hadoop-yarn-server-common/.../webapp/AppBlock.java:393). */
const APP_STATE_CLARIFY: Record<string, string> = {
  NEW: "waiting for application to be initialized",
  NEW_SAVING: "waiting for application to be persisted in state-store.",
  SUBMITTED: "waiting for application to be accepted by scheduler.",
  ACCEPTED: "waiting for AM container to be allocated, launched and register with RM.",
  RUNNING: "AM has registered with RM and started running.",
};

export function clarifyAppState(state: string | null | undefined): string {
  if (!state) return UNAVAILABLE;
  const clarify = APP_STATE_CLARIFY[state];
  return clarify ? `${state}: ${clarify}` : state;
}

/** `AppBlock.clairfyAppFinalStatus` (AppBlock.java:416). */
export function finalStatusText(status: string | null | undefined): string {
  if (!status) return UNAVAILABLE;
  return status === "UNDEFINED" ? FINAL_STATUS_UNDEFINED_TEXT : status;
}

/** `AppBlock.clarifyAppPriority` (AppBlock.java:412): `"<n> (Higher Integer value indicates higher priority)"`. */
export function priorityText(priority: number | null | undefined): string {
  if (priority == null) return UNAVAILABLE;
  return `${priority} (${PRIORITY_HINT})`;
}

// ---------------------------------------------------------------------------------------------- legacy time formats

/**
 * `org.apache.hadoop.util.StringUtils.formatTime` (hadoop-common StringUtils.java:307) — "Xhrs, Ymins, Zsec".
 * Used by the legacy app/attempt/container pages for Elapsed, so the derived text id stamps exactly this string.
 */
export function hadoopFormatTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return UNAVAILABLE;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  let out = "";
  if (hours !== 0) out += `${hours}hrs, `;
  if (minutes !== 0) out += `${minutes}mins, `;
  return `${out}${seconds}sec`;
}

/**
 * `Times.elapsed(started, finished)` — finishedTime 0 means "still running", so live pages compute against now.
 * Field: `app.elapsedTime` (the same REST key the legacy page reads through `AppInfo.getElapsedTime()`).
 */
export function elapsedMs(startedTime: number | null | undefined, finishedTime: number | null | undefined, now: number): number {
  const started = startedTime ?? 0;
  if (started <= 0) return 0;
  const finished = finishedTime ?? 0;
  return finished > 0 ? Math.max(0, finished - started) : Math.max(0, now - started);
}

export const attemptElapsedMs = (attempt: Pick<AppAttempt, "startTime" | "finishedTime">, now: number): number =>
  elapsedMs(attempt.startTime, attempt.finishedTime, now);

/**
 * "Application Timeout (Remaining Time)" — `AppBlock.generateOverviewTable` prints "Unlimited" when the remaining
 * seconds are < 0, else `String.format("%d seconds", timeout)`.
 * Field: `app.timeouts.timeout.remainingTimeInSeconds` (raw seconds, so the harness can recompute the text).
 */
export function timeoutRemainingText(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "Unlimited";
  return `${seconds} seconds`;
}

/** Live countdown for a positive remaining time; the raw seconds stay in data-yv. */
export function timeoutCountdownText(seconds: number): string {
  if (seconds <= 0) return "expired";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m left`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s left`;
  return `${s}s left`;
}

// ----------------------------------------------------------------------------------------------- resource strings

/**
 * Legacy `Resource.toString()` -> `"<memory:1024, vCores:1>"` (hadoop-yarn-api Resource.java).
 * Fields: `app.derived.totalResourcePreemptedText`, `container.derived.resourceText`.
 */
export function resourceString(memoryMB: number | null | undefined, vcores: number | null | undefined): string {
  const m = memoryMB == null || memoryMB < 0 ? 0 : memoryMB;
  const v = vcores == null || vcores < 0 ? 0 : vcores;
  return `<memory:${m}, vCores:${v}>`;
}

/**
 * `StringHelper.getResourceSecondsString` (hadoop-yarn-common StringHelper.java:184) ->
 * `"4998 MB-seconds, 5 vcore-seconds"`, then `", <value> <name>-seconds"` per custom resource of the map.
 * Memory/vcores come from the dedicated REST keys (`memorySeconds`/`vcoreSeconds`): RM mapped notation can drop the
 * `memory-mb` entry from `resourceSecondsMap` while the dedicated key stays correct (verified live).
 * Fields: `app.derived.resourceSecondsText`, `app.derived.preemptedResourceSecondsText`.
 */
export function resourceSecondsText(
  memorySeconds: number | null | undefined,
  vcoreSeconds: number | null | undefined,
  map?: Readonly<Record<string, number>> | null,
): string {
  let out = `${memorySeconds ?? 0} MB-seconds, ${vcoreSeconds ?? 0} vcore-seconds`;
  for (const [name, value] of Object.entries(map ?? {})) {
    if (name === "memory-mb" || name === "vcores") continue;
    out += `, ${value} ${name}-seconds`;
  }
  return out;
}

/**
 * `RMAppAttemptBlock.createResourceRequestsTable` heading total: `getTotalResource` sums `capability x numContainers`
 * over the requests whose `resourceName` is ANY (`*`) — node/rack requests are the same containers again.
 * Returns null when there is nothing outstanding (the legacy page hides the heading and the table then).
 */
export function totalOutstandingResources(
  requests: readonly { resourceName?: string | null; numContainers: number; capability?: { memory?: number; vCores?: number } | null }[],
): { memoryMB: number; vcores: number } | null {
  const any = requests.filter((r) => r.resourceName === "*" && r.numContainers > 0);
  if (any.length === 0) return null;
  return {
    memoryMB: any.reduce((a, r) => a + (r.capability?.memory ?? 0) * r.numContainers, 0),
    vcores: any.reduce((a, r) => a + (r.capability?.vCores ?? 0) * r.numContainers, 0),
  };
}

/** The whole legacy heading text, the datum value of `attempt.derived.totalOutstandingResourceRequestsText`. */
export const totalOutstandingText = (total: { memoryMB: number; vcores: number }): string =>
  `Total Outstanding Resource Requests: ${resourceString(total.memoryMB, total.vcores)}`;

/** `ContainerBlock.getResources`: `"<memory-mb> Memory, <vcores> VCores"` plus `", <value> <name>"` per custom resource. */
export function containerResourceText(c: {
  allocatedMB: number;
  allocatedVCores: number;
  allocatedResources?: Readonly<Record<string, number>> | null;
}): string {
  const res = c.allocatedResources ?? {};
  let out = `${res["memory-mb"] ?? c.allocatedMB} Memory, ${res.vcores ?? c.allocatedVCores} VCores`;
  for (const [name, value] of Object.entries(res)) {
    if (name === "memory-mb" || name === "vcores") continue;
    out += `, ${value} ${name}`;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ tracking / links

export type TrackingKind = "unassigned" | "am" | "history";

/**
 * `RMAppsBlock.java:201-212` tracking-URL branch: a finished app shows "History", a live one "ApplicationMaster",
 * otherwise "Unassigned". REST `trackingUI` already encodes this; the raw value stays in data-yv and this only
 * normalises the label.
 */
export function trackingKind(app: Pick<App, "trackingUI" | "trackingUrl" | "state">): TrackingKind {
  const ui = (app.trackingUI ?? "").toUpperCase();
  if (ui === "HISTORY") return "history";
  if (ui === "APPLICATIONMASTER") return "am";
  if (!app.trackingUrl || app.trackingUrl === UNAVAILABLE || app.state === "NEW") return "unassigned";
  return isAppFinal(app.state) ? "history" : "am";
}

const TRACKING_LABEL: Record<TrackingKind, string> = { unassigned: "Unassigned", am: "ApplicationMaster", history: "History" };

export const trackingLabel = (app: Pick<App, "trackingUI" | "trackingUrl" | "state">): string => TRACKING_LABEL[trackingKind(app)];

/**
 * Legacy tracking-link label from the *report's* tracking URL (`AppBlock.java:250-258`, `RMAppAttemptBlock.java:499-511`):
 * no URL (null/"N/A") or app state NEW -> "Unassigned"; final state -> "History"; otherwise "ApplicationMaster".
 * Fields: `app.derived.trackingUiText`, `attempt.derived.trackingUiText`.
 */
export function legacyTrackingText(trackingUrl: string | null | undefined, state: string | null | undefined, isFinal: boolean): string {
  if (!trackingUrl || trackingUrl === UNAVAILABLE || state === "NEW") return TRACKING_LABEL.unassigned;
  return isFinal ? TRACKING_LABEL.history : TRACKING_LABEL.am;
}

/** Attempt flavour of {@link legacyTrackingText}: final = FINISHED | FAILED | KILLED attempt state. */
export const attemptTrackingText = (trackingUrl: string | null | undefined, attemptState: string | null | undefined): string =>
  legacyTrackingText(trackingUrl, attemptState, isAppFinal(attemptState));

/**
 * `AppAttemptBlock.java:131-136`: `host:rpcPort` when the host is known and the port a real one, else `N/A`.
 * Field: `attempt.derived.hostPortText`.
 */
export function attemptHostPortText(host: string | null | undefined, rpcPort: number | null | undefined): string {
  return host != null && host !== "" && rpcPort != null && rpcPort >= 0 && rpcPort < 65536 ? `${host}:${rpcPort}` : UNAVAILABLE;
}

// ------------------------------------------------------------------------------------------ container id plumbing

const CONTAINER_ID_RE = /^container_(?:e\d+_)?(\d+)_(\d+)_(\d+)_(\d+)$/;
const APP_ID_RE = /^application_(\d+)_(\d+)$/;
const ATTEMPT_ID_RE = /^appattempt_(\d+)_(\d+)_(\d+)$/;

export interface ContainerIdParts {
  clusterTs: string;
  appNum: string;
  attemptNum: number;
  containerNum: number;
}

/**
 * `container_<clusterTs>_<appNum>_<attemptNum>_<containerNum>` (ContainerId.fromString).
 * The SPA container route (`/apps/$appId/containers/$containerId`) only receives the container id, so the attempt id
 * is recovered from it the same way the RM does.
 */
export function parseContainerId(containerId: string | null | undefined): ContainerIdParts | null {
  const m = CONTAINER_ID_RE.exec(containerId ?? "");
  if (!m) return null;
  return { clusterTs: m[1]!, appNum: m[2]!, attemptNum: Number(m[3]), containerNum: Number(m[4]) };
}

/** `container_1_2_000003_000001` -> `appattempt_1_2_000003`. */
export function attemptIdFromContainerId(containerId: string | null | undefined): string | null {
  const p = parseContainerId(containerId);
  return p ? `appattempt_${p.clusterTs}_${p.appNum}_${String(p.attemptNum).padStart(6, "0")}` : null;
}

export function attemptIdOf(appId: string, attemptNum: number): string | null {
  const m = APP_ID_RE.exec(appId);
  return m ? `appattempt_${m[1]}_${m[2]}_${String(attemptNum).padStart(6, "0")}` : null;
}

export function appIdFromAttemptId(attemptId: string | null | undefined): string | null {
  const m = ATTEMPT_ID_RE.exec(attemptId ?? "");
  return m ? `application_${m[1]}_${m[2]}` : null;
}

// ------------------------------------------------------------------------------------------------- misc derivations

/**
 * Legacy label-expression text: null -> `<Not set>`, `""` (the RM's default partition) -> `<DEFAULT_PARTITION>`.
 * `AppBlock.java:284-289` prints `getAppNodeLabelExpression() == null ? "<Not set>" : value`.
 */
export function labelExpressionText(value: string | null | undefined, fallback: string = NOT_SET): string {
  if (value == null) return fallback;
  if (value === "") return DEFAULT_PARTITION;
  return value;
}

/**
 * `attempt.blacklistedNodes` / `attempt.nodesBlacklistedBySystem` are comma-joined id lists; the legacy attempt table
 * shows their SIZE (`RMAppBlock.java` builds `appBlacklistedNodesCount`/`rmBlacklistedNodesCount` from `Set.size()`).
 * The RM's own `getNodeString` returns "-" for an empty set.
 */
export function blacklistedIds(joined: string | null | undefined): string[] {
  if (!joined) return [];
  return joined
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "-");
}

/** Progress of a running app for the ring/timeline: REST gives 0..100 already. */
export const appProgress = (app: Pick<App, "progress">): number =>
  Number.isFinite(app.progress) ? Math.max(0, Math.min(100, app.progress)) : 0;

// ------------------------------------------------------------------------------------------------------ timeline

export type TimelineTone = "fresh" | "wait" | "live" | "ok" | "fail" | "idle";

export interface TimelineStep {
  key: string;
  /** legacy label vocabulary */
  label: string;
  /** epoch ms; null = the milestone never happened (yet) */
  at: number | null;
  /** parity field id for the milestone timestamp (real REST keys where one exists) */
  field: string;
  tone: TimelineTone;
  /** ms until the next milestone (= how long this phase took); for the last milestone while the app is live, now − at */
  durationMs: number | null;
  /** parity field id for the derived gap; `derived.` prefix = computed by us */
  durationField: string;
  detail?: string;
}

const FINISHED_LABEL: Record<string, string> = { FINISHED: "Finished", FAILED: "Failed", KILLED: "Killed" };
const FINISHED_TONE: Record<string, TimelineTone> = { FINISHED: "ok", FAILED: "fail", KILLED: "idle" };

/**
 * Status timeline (our addition — the legacy page has no timeline; the *labels* it replaces stay verbatim).
 *
 * Anchors, in the order the RM learns them: `startedTime` (app accepted) → the first attempt's `startTime` (attempt
 * created) → `launchTime` (AM container launched, i.e. "running") → `finishedTime`. The RM has no submitTime in
 * `/apps/{id}`, so "Submitted" anchors on `startedTime`, exactly what the legacy "Started:" row shows.
 */
export function appTimeline(app: App, attempts: readonly AppAttempt[], now: number): TimelineStep[] {
  const started = app.startedTime > 0 ? app.startedTime : null;
  const launched = app.launchTime && app.launchTime > 0 ? app.launchTime : null;
  const finished = app.finishedTime > 0 ? app.finishedTime : null;
  let firstAttempt: AppAttempt | null = null;
  for (const a of attempts) if (firstAttempt == null || a.id < firstAttempt.id) firstAttempt = a;
  const finishedState = isAppFinal(app.state) ? app.state : null;

  const steps: TimelineStep[] = [
    {
      key: "submitted",
      label: "Submitted",
      at: started,
      field: "app.startedTime",
      tone: "fresh",
      durationMs: null,
      durationField: "app.derived.timeline.durationMs.submitted",
      detail: "Accepted by the ResourceManager",
    },
    {
      key: "attempt",
      label: `Attempt ${firstAttempt ? `#${firstAttempt.id} ` : ""}created`,
      at: firstAttempt?.startTime ?? null,
      field: "app.derived.firstAttemptCreatedAt",
      tone: "wait",
      durationMs: null,
      durationField: "app.derived.timeline.durationMs.attempt",
      detail: firstAttempt ? "The RM created the application attempt" : "No attempt has been created yet",
    },
    {
      key: "launched",
      label: "Launched",
      at: launched,
      field: "app.launchTime",
      tone: "live",
      durationMs: null,
      durationField: "app.derived.timeline.durationMs.launched",
      detail: "ApplicationMaster container launched and registered",
    },
    {
      key: "finished",
      label: finishedState ? FINISHED_LABEL[finishedState]! : app.state === "RUNNING" ? "Running" : "In progress",
      at: finished,
      field: "app.finishedTime",
      tone: finishedState ? FINISHED_TONE[finishedState]! : "wait",
      durationMs: null,
      durationField: "app.derived.timeline.durationMs.finished",
      detail: finishedState
        ? app.finalStatus === "UNDEFINED"
          ? "Final status unreported"
          : finalStatusText(app.finalStatus)
        : app.state === "RUNNING"
          ? "No finish time reported yet."
          : "The application has not finished yet.",
    },
  ];

  const anchored = steps.filter((s): s is TimelineStep & { at: number } => s.at != null);
  for (let i = 0; i < anchored.length; i++) {
    const cur = anchored[i]!;
    const next = anchored[i + 1];
    cur.durationMs = next ? Math.max(0, next.at - cur.at) : isAppFinal(app.state) ? null : Math.max(0, now - cur.at);
  }
  return steps;
}

/** Per-attempt band on the timeline (multi-attempt apps: the story is the retries). */
export interface AttemptBand {
  attemptId: string;
  num: number;
  state: string;
  startMs: number;
  endMs: number | null;
  durationMs: number | null;
}

export function attemptBands(attempts: readonly AppAttempt[], now: number): AttemptBand[] {
  return attempts.map((a) => {
    const end = a.finishedTime > 0 ? a.finishedTime : null;
    return {
      attemptId: a.appAttemptId,
      num: a.id,
      state: a.appAttemptState,
      startMs: a.startTime,
      endMs: end,
      durationMs: end != null ? Math.max(0, end - a.startTime) : Math.max(0, now - a.startTime),
    };
  });
}

// ------------------------------------------------------------------------------------- attempt request locality

/**
 * The legacy attempt page's locality matrix headers (`RMAppAttemptBlock.java:403-410`):
 *   "" | Node Local Request | Rack Local Request | Off Switch Request
 * and rows `Num {Node,Rack,Off Switch} Local Containers (satisfied by)`.
 *
 * The RM builds the cells from `RMAppAttemptMetrics.getLocalityStatistics()`, which the REST API does **not expose**
 * (`AppAttemptInfo` has no locality field). The matrix structure is therefore rendered with every cell in the explicit
 * "not exposed by RM REST" state and `data-yn="1"` — never invented numbers.
 */
export const LOCALITY_MATRIX = {
  columns: ["Node Local Request", "Rack Local Request", "Off Switch Request"],
  columnKeys: ["nodeLocalRequest", "rackLocalRequest", "offSwitchRequest"],
  rows: [
    "Num Node Local Containers (satisfied by)",
    "Num Rack Local Containers (satisfied by)",
    "Num Off Switch Containers (satisfied by)",
  ],
  rowKeys: ["nodeLocalContainers", "rackLocalContainers", "offSwitchContainers"],
  /** Cell [row][col] is the count of containers of row-locality satisfied by requests of col-locality. */
  cells: [
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ],
} as const;

/** `AppAttemptInfo.exportPorts` is a Gson-encoded map; the legacy page prints `{}` for none and "null" for absent. */
export function exportPortsText(exportPorts: string | null | undefined): string {
  if (!exportPorts || exportPorts === "null") return "{}";
  return exportPorts;
}

/** Raw attempt `exportPorts` value (`"null"` in captured payloads) — kept separate from the display text. */
export const rawExportPorts = (exportPorts: string | null | undefined): string | null =>
  exportPorts === "null" ? null : (exportPorts ?? null);

/**
 * NodeManager **HTTP** authority (`host:port`) for a container — what the log routes need.
 *
 * Three different addresses appear on a container, and only one of them is right here:
 *   - `nodeHttpAddress`  `http://127.0.0.4:8042`  ← the NodeManager's HTTP endpoint (what we call); the URL form
 *                                                  is what `ContainerInfo` serialises, so strip the scheme
 *   - `assignedNodeId`   `127.0.0.4:8041`         ← the RM's scheduler/container-manager address, NOT HTTP
 *   - `nodeId`           `127.0.0.4:8041`         ← same
 * Preferring the id forms produced "127.0.0.4:8041 is not a NodeManager of this cluster" from the log routes,
 * whose membership check is against the RM's node list of *HTTP* addresses.
 */
export function nodeHostPort(c: {
  nodeHttpAddress?: string | null;
  assignedNodeId?: string | null;
  nodeId?: string | null;
}): string | null {
  const candidate = c.nodeHttpAddress ?? c.assignedNodeId ?? c.nodeId ?? null;
  if (!candidate) return null;
  const stripped = candidate.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return stripped.length > 0 ? stripped : null;
}

/** `RMAppAttemptBlock.getNodeString`: ids joined with ", ", `-` when empty. Fields: `attempt.derived.{app,rm}BlacklistedNodesText`. */
export const blacklistedNodesText = (joined: string | null | undefined): string => {
  const ids = blacklistedIds(joined);
  return ids.length ? ids.join(", ") : "-";
};
