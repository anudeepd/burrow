/**
 * THE status language. One table: (domain, state) -> tone + icon + shape + motion + label.
 * Lists, detail pages, DAG nodes and timelines MUST read from here (DESIGN.md §Status language).
 * Never encode status by colour alone: every entry has an icon (pills) and a shape (dots, DAG corners, timeline bars).
 */
import {
  Activity,
  ArrowDownToLine,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  Flag,
  Hourglass,
  Minus,
  Power,
  RotateCw,
  Save,
  Send,
  Square,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";

export type Tone = "live" | "ok" | "fail" | "wait" | "fresh" | "warn" | "idle";
export type Shape = "disc" | "ring" | "ring-dash" | "half" | "square" | "diamond" | "cross" | "slash" | "dash" | "triangle" | "check";
/** pulse: breathing ring (live work) · drain: slow fade (winding down) · none */
export type StatusMotion = "pulse" | "drain" | "none";

export interface StatusSpec {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  shape: Shape;
  motion: StatusMotion;
  /** one-line meaning, used for title/tooltip and docs */
  hint: string;
}

export type StatusDomain =
  | "app.state"
  | "app.finalStatus"
  | "node.state"
  | "node.health"
  | "queue.state"
  | "container.state"
  | "app.logAggregationStatus"
  | "rm.haState"
  | "service"
  | "spark.executor"
  | "spark.job"
  | "spark.stage"
  | "spark.task"
  | "spark.sql";

const s = (label: string, tone: Tone, icon: LucideIcon, shape: Shape, motion: StatusMotion, hint: string): StatusSpec => ({
  label,
  tone,
  icon,
  shape,
  motion,
  hint,
});

export const STATUS: Record<StatusDomain, Record<string, StatusSpec>> = {
  "app.state": {
    NEW: s("New", "fresh", CircleDashed, "ring-dash", "none", "Application object created, not yet persisted"),
    NEW_SAVING: s("New saving", "fresh", Save, "ring-dash", "none", "Application is being saved to the state store"),
    SUBMITTED: s("Submitted", "fresh", Send, "ring", "none", "Submitted, waiting for the scheduler to validate it"),
    ACCEPTED: s("Accepted", "wait", Hourglass, "half", "none", "Accepted by the scheduler, waiting for the ApplicationMaster container"),
    RUNNING: s("Running", "live", Activity, "disc", "pulse", "ApplicationMaster is running"),
    FINISHED: s("Finished", "idle", Flag, "square", "none", "Application ended; see the final status for the verdict"),
    FAILED: s("Failed", "fail", CircleX, "cross", "none", "Application failed"),
    KILLED: s("Killed", "idle", Ban, "slash", "none", "Application was killed"),
  },
  "app.finalStatus": {
    UNDEFINED: s("Undefined", "idle", Minus, "dash", "none", "No final status yet"),
    SUCCEEDED: s("Succeeded", "ok", CircleCheck, "check", "none", "Finished successfully"),
    FAILED: s("Failed", "fail", CircleX, "cross", "none", "Finished unsuccessfully"),
    KILLED: s("Killed", "idle", Ban, "slash", "none", "Killed by a user or the cluster"),
    ENDED: s("Ended", "idle", Flag, "square", "none", "Ended (final status not reported)"),
  },
  "node.state": {
    NEW: s("New", "fresh", CircleDashed, "ring-dash", "none", "Node registered, not yet running"),
    RUNNING: s("Running", "live", Activity, "disc", "pulse", "Heartbeating and healthy"),
    UNHEALTHY: s("Unhealthy", "warn", TriangleAlert, "triangle", "none", "Failing its health script or disk checks"),
    DECOMMISSIONING: s("Decommissioning", "warn", ArrowDownToLine, "half", "drain", "Draining containers before decommission"),
    DECOMMISSIONED: s("Decommissioned", "idle", Power, "square", "none", "Removed from the cluster"),
    LOST: s("Lost", "fail", Unplug, "diamond", "none", "Stopped heartbeating"),
    REBOOTED: s("Rebooted", "wait", RotateCw, "ring", "none", "Re-registered after a restart"),
    SHUTDOWN: s("Shutdown", "idle", Power, "dash", "none", "Shut down cleanly"),
  },
  "node.health": {
    healthy: s("Healthy", "ok", CircleCheck, "disc", "none", "Health report is empty"),
    unhealthy: s("Unhealthy", "warn", TriangleAlert, "triangle", "none", "Health report is non-empty"),
  },
  "queue.state": {
    RUNNING: s("Running", "live", Activity, "disc", "pulse", "Accepting applications"),
    STOPPED: s("Stopped", "idle", Square, "square", "none", "Not accepting applications"),
    DRAINING: s("Draining", "warn", ArrowDownToLine, "half", "drain", "Finishing existing applications, accepting none"),
  },
  "container.state": {
    NEW: s("New", "fresh", CircleDashed, "ring-dash", "none", "Allocated, not launched"),
    RUNNING: s("Running", "live", Activity, "disc", "pulse", "Running on a NodeManager"),
    COMPLETE: s("Complete", "idle", Flag, "square", "none", "Exited; see exit status"),
  },
  "app.logAggregationStatus": {
    DISABLED: s("Disabled", "idle", Ban, "slash", "none", "Log aggregation is off"),
    NOT_START: s("Not started", "idle", Minus, "dash", "none", "Aggregation has not started"),
    RUNNING: s("Running", "live", Activity, "disc", "pulse", "Aggregating"),
    RUNNING_WITH_FAILURE: s("Running with failure", "warn", TriangleAlert, "triangle", "none", "Aggregating, some nodes failed"),
    SUCCEEDED: s("Succeeded", "ok", CircleCheck, "check", "none", "All logs aggregated"),
    FAILED: s("Failed", "fail", CircleX, "cross", "none", "Aggregation failed"),
    TIME_OUT: s("Timed out", "warn", Hourglass, "triangle", "none", "Aggregation timed out"),
  },
  "rm.haState": {
    ACTIVE: s("Active", "live", Activity, "disc", "pulse", "This ResourceManager is serving"),
    STANDBY: s("Standby", "wait", Hourglass, "ring", "none", "Waiting to take over"),
    UNKNOWN: s("HA off", "idle", Minus, "dash", "none", "High availability is not configured"),
  },
  service: {
    reachable: s("Reachable", "ok", CircleCheck, "disc", "none", "Service responded"),
    unreachable: s("Unreachable", "fail", Unplug, "diamond", "none", "Service did not respond"),
    configured: s("Configured", "wait", CircleHelp, "ring", "none", "Service is configured; reachability has not been checked yet"),
    unconfigured: s("Not configured", "idle", Minus, "dash", "none", "No URL configured or discovered"),
  },
  "spark.executor": {
    ACTIVE: s("Active", "live", Activity, "disc", "pulse", "Executor is active"),
    INACTIVE: s("Inactive", "idle", Ban, "slash", "none", "Executor has stopped"),
    UNKNOWN: s("Unknown", "idle", CircleHelp, "dash", "none", "Executor activity is not reported"),
  },
  "spark.job": {
    RUNNING: s("Running", "live", Activity, "disc", "pulse", "Job has active stages"),
    SUCCEEDED: s("Succeeded", "ok", CircleCheck, "check", "none", "All stages completed"),
    FAILED: s("Failed", "fail", CircleX, "cross", "none", "Job failed"),
    UNKNOWN: s("Unknown", "idle", CircleHelp, "dash", "none", "State not reported"),
  },
  "spark.stage": {
    ACTIVE: s("Active", "live", Activity, "disc", "pulse", "Tasks are running"),
    COMPLETE: s("Complete", "ok", CircleCheck, "check", "none", "All tasks completed"),
    FAILED: s("Failed", "fail", CircleX, "cross", "none", "Stage failed"),
    PENDING: s("Pending", "wait", Hourglass, "ring", "none", "Waiting for parent stages"),
    SKIPPED: s("Skipped", "idle", Ban, "slash", "none", "Output reused from an earlier run"),
  },
  "spark.task": {
    PENDING: s("Pending", "wait", Hourglass, "ring", "none", "Waiting for an executor slot"),
    RUNNING: s("Running", "live", Activity, "disc", "pulse", "Executing"),
    SUCCESS: s("Success", "ok", CircleCheck, "check", "none", "Completed"),
    FAILED: s("Failed", "fail", CircleX, "cross", "none", "Task failed"),
    KILLED: s("Killed", "idle", Ban, "slash", "none", "Killed (speculation or cancel)"),
  },
  "spark.sql": {
    RUNNING: s("Running", "live", Activity, "disc", "pulse", "SQL execution is running"),
    COMPLETED: s("Completed", "ok", CircleCheck, "check", "none", "SQL execution completed"),
    FAILED: s("Failed", "fail", CircleX, "cross", "none", "SQL execution failed"),
  },
};

const UNKNOWN: StatusSpec = s("Unknown", "idle", CircleHelp, "dash", "none", "State not recognised by this version of Burrow");

/** Total lookup: unknown states (newer Hadoop/Spark) render as a neutral dash with their raw label, never crash. */
export function statusSpec(domain: StatusDomain, state: string | null | undefined): StatusSpec {
  if (!state) return UNKNOWN;
  return STATUS[domain][state] ?? { ...UNKNOWN, label: titleCase(state) };
}

export function titleCase(raw: string): string {
  const t = raw.toLowerCase().replaceAll("_", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** YARN app states in lifecycle order (tabs, facets). */
export const APP_STATE_ORDER = ["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED", "RUNNING", "FINISHED", "FAILED", "KILLED"] as const;
