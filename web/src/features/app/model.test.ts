import { describe, expect, it } from "vitest";
import type { App, AppAttempt } from "~/api/schemas";
import {
  attemptHostPortText,
  attemptIdFromContainerId,
  attemptIdOf,
  attemptTrackingText,
  appTimeline,
  blacklistedIds,
  blacklistedNodesText,
  containerResourceText,
  clarifyAppState,
  elapsedMs,
  finalStatusText,
  hadoopFormatTime,
  isAppFinal,
  legacyTrackingText,
  labelExpressionText,
  parseContainerId,
  priorityText,
  resourceSecondsText,
  resourceString,
  timeoutCountdownText,
  timeoutRemainingText,
  totalOutstandingResources,
  totalOutstandingText,
  trackingKind,
  trackingLabel,
  nodeHostPort,
} from "./model";

/** Minimal App/AppAttempt builders — the model only reads a handful of keys. */
function app(overrides: Partial<App> = {}): App {
  return {
    id: "application_1_0001",
    user: "alice",
    name: "job",
    queue: "root.default",
    state: "RUNNING",
    finalStatus: "UNDEFINED",
    progress: 0,
    trackingUI: "ApplicationMaster",
    trackingUrl: "http://rm:8088/proxy/application_1_0001/",
    diagnostics: "",
    clusterId: 1,
    applicationTags: "",
    priority: 0,
    startedTime: 0,
    finishedTime: 0,
    elapsedTime: 0,
    allocatedMB: -1,
    allocatedVCores: -1,
    runningContainers: -1,
    memorySeconds: 0,
    vcoreSeconds: 0,
    queueUsagePercentage: 0,
    clusterUsagePercentage: 0,
    preemptedResourceMB: 0,
    preemptedResourceVCores: 0,
    numNonAMContainerPreempted: 0,
    numAMContainerPreempted: 0,
    resourceRequests: [],
    unmanagedApplication: false,
    ...overrides,
  };
}

function attempt(id: number, overrides: Partial<AppAttempt> = {}): AppAttempt {
  return {
    id,
    startTime: 1_000,
    finishedTime: 0,
    containerId: `container_1_0001_0${id}_000001`,
    nodeHttpAddress: "127.0.0.4:8042",
    nodeId: "127.0.0.4:8041",
    logsLink: "",
    appAttemptId: `appattempt_1_0001_00000${id}`,
    appAttemptState: "RUNNING",
    ...overrides,
  };
}

describe("legacy text derivations", () => {
  it("clarifies the five non-final application states verbatim (AppBlock.java:393)", () => {
    expect(clarifyAppState("RUNNING")).toBe("RUNNING: AM has registered with RM and started running.");
    expect(clarifyAppState("ACCEPTED")).toBe("ACCEPTED: waiting for AM container to be allocated, launched and register with RM.");
    expect(clarifyAppState("FINISHED")).toBe("FINISHED");
    expect(clarifyAppState(null)).toBe("N/A");
  });

  it("expands UNDEFINED final status the way the legacy page does", () => {
    expect(finalStatusText("UNDEFINED")).toBe("Not finished yet");
    expect(finalStatusText("SUCCEEDED")).toBe("SUCCEEDED");
    expect(finalStatusText("")).toBe("N/A");
  });

  it("keeps the legacy priority tooltip text", () => {
    expect(priorityText(0)).toBe("0 (Higher Integer value indicates higher priority)");
    expect(priorityText(-1)).toBe("-1 (Higher Integer value indicates higher priority)");
  });

  it("formats elapsed exactly like org.apache.hadoop.util.StringUtils.formatTime", () => {
    expect(hadoopFormatTime(3_000)).toBe("3sec");
    expect(hadoopFormatTime(61_000)).toBe("1mins, 1sec");
    expect(hadoopFormatTime(3_661_000)).toBe("1hrs, 1mins, 1sec");
    expect(hadoopFormatTime(0)).toBe("0sec");
    expect(hadoopFormatTime(-1)).toBe("N/A");
  });

  it("derives elapsed against now only while the app is unfinished", () => {
    expect(elapsedMs(1_000, 4_000, 999_999)).toBe(3_000);
    expect(elapsedMs(1_000, 0, 5_000)).toBe(4_000);
    expect(elapsedMs(0, 0, 5_000)).toBe(0);
    // clock skew / finished before started never renders a negative duration
    expect(elapsedMs(5_000, 4_000, 9_000)).toBe(0);
  });
});

describe("timeouts", () => {
  it("prints Unlimited for the RM's negative remaining time", () => {
    expect(timeoutRemainingText(-1)).toBe("Unlimited");
    expect(timeoutRemainingText(0)).toBe("0 seconds");
    expect(timeoutRemainingText(90)).toBe("90 seconds");
    expect(timeoutRemainingText(undefined)).toBe("Unlimited");
  });

  it("renders a live countdown that never goes below expired", () => {
    expect(timeoutCountdownText(45)).toBe("45s left");
    expect(timeoutCountdownText(125)).toBe("2m 05s left");
    expect(timeoutCountdownText(7_320)).toBe("2h 02m left");
    expect(timeoutCountdownText(0)).toBe("expired");
  });
});

describe("resource strings", () => {
  it("renders the legacy Resource.toString shape", () => {
    expect(resourceString(0, 0)).toBe("<memory:0, vCores:0>");
    expect(resourceString(768, 1)).toBe("<memory:768, vCores:1>");
    // the RM sends -1 for a completed application's report
    expect(resourceString(-1, -1)).toBe("<memory:0, vCores:0>");
  });

  it("renders aggregate allocation like StringHelper.getResourceSecondsString", () => {
    expect(resourceSecondsText(4_998, 5)).toBe("4998 MB-seconds, 5 vcore-seconds");
    expect(resourceSecondsText(0, 0)).toBe("0 MB-seconds, 0 vcore-seconds");
    expect(resourceSecondsText(undefined, undefined)).toBe("0 MB-seconds, 0 vcore-seconds");
  });

  it("appends custom resources of the map after memory/vcores, ignoring the memory-mb/vcores entries", () => {
    expect(resourceSecondsText(1_602_350, 2_084, { vcores: 2_084 })).toBe("1602350 MB-seconds, 2084 vcore-seconds");
    expect(resourceSecondsText(10, 2, { "memory-mb": 10, vcores: 2, "yarn.io/gpu": 7 })).toBe(
      "10 MB-seconds, 2 vcore-seconds, 7 yarn.io/gpu-seconds",
    );
  });

  it("renders the container Resource row like ContainerBlock.getResources", () => {
    expect(containerResourceText({ allocatedMB: 768, allocatedVCores: 1, allocatedResources: { "memory-mb": 768, vcores: 1 } })).toBe(
      "768 Memory, 1 VCores",
    );
    expect(containerResourceText({ allocatedMB: 768, allocatedVCores: 1 })).toBe("768 Memory, 1 VCores");
    expect(
      containerResourceText({ allocatedMB: 1, allocatedVCores: 1, allocatedResources: { "memory-mb": 2, vcores: 3, "yarn.io/gpu": 4 } }),
    ).toBe("2 Memory, 3 VCores, 4 yarn.io/gpu");
  });

  it("totals only the ANY (*) requests for the attempt heading", () => {
    const cap = { memory: 768, vCores: 1 };
    const total = totalOutstandingResources([
      { resourceName: "*", numContainers: 2, capability: cap },
      { resourceName: "/default-rack", numContainers: 2, capability: cap },
      { resourceName: "host1", numContainers: 2, capability: cap },
    ]);
    expect(total).toEqual({ memoryMB: 1_536, vcores: 2 });
    expect(totalOutstandingText(total!)).toBe("Total Outstanding Resource Requests: <memory:1536, vCores:2>");
    expect(totalOutstandingText({ memoryMB: 768, vcores: 1 })).toBe("Total Outstanding Resource Requests: <memory:768, vCores:1>");
    expect(totalOutstandingResources([])).toBeNull();
    expect(totalOutstandingResources([{ resourceName: "*", numContainers: 0, capability: cap }])).toBeNull();
  });

  it("falls back to zeros for a preempted map the RM did not populate", () => {
    // captured running app: preemptedMemorySeconds=0, preemptedVcoreSeconds=0
    expect(resourceSecondsText(0, 0)).toBe("0 MB-seconds, 0 vcore-seconds");
  });
});

describe("tracking UI", () => {
  it("maps REST trackingUI onto the legacy label set", () => {
    expect(trackingKind(app({ state: "RUNNING", trackingUI: "ApplicationMaster" }))).toBe("am");
    expect(trackingLabel(app({ state: "RUNNING", trackingUI: "ApplicationMaster" }))).toBe("ApplicationMaster");
    expect(trackingKind(app({ state: "FINISHED", trackingUI: "History" }))).toBe("history");
    expect(trackingLabel(app({ state: "FINISHED", trackingUI: "History" }))).toBe("History");
    expect(trackingKind(app({ state: "NEW", trackingUI: "UNASSIGNED", trackingUrl: undefined }))).toBe("unassigned");
    expect(trackingLabel(app({ state: "NEW", trackingUI: "UNASSIGNED", trackingUrl: undefined }))).toBe("Unassigned");
  });

  it("falls back to the state when trackingUI is missing", () => {
    expect(trackingKind(app({ state: "FINISHED", trackingUI: "", trackingUrl: "http://jhs/job/1" }))).toBe("history");
    expect(trackingKind(app({ state: "RUNNING", trackingUI: "", trackingUrl: "http://rm/proxy/x" }))).toBe("am");
  });
});

describe("label expressions", () => {
  it("distinguishes the RM's null from its empty-string default partition", () => {
    expect(labelExpressionText(null)).toBe("<Not set>");
    expect(labelExpressionText(undefined)).toBe("<Not set>");
    expect(labelExpressionText("")).toBe("<DEFAULT_PARTITION>");
    expect(labelExpressionText("gpu")).toBe("gpu");
  });
});

describe("container ids", () => {
  it("parses the RM's container id grammar", () => {
    expect(parseContainerId("container_1791010984040_0004_03_000002")).toEqual({
      clusterTs: "1791010984040",
      appNum: "0004",
      attemptNum: 3,
      containerNum: 2,
    });
    expect(parseContainerId("not-a-container")).toBeNull();
    expect(parseContainerId(null)).toBeNull();
  });

  it("recovers the attempt id the container route needs", () => {
    expect(attemptIdFromContainerId("container_1791010984040_0004_03_000002")).toBe("appattempt_1791010984040_0004_000003");
    expect(attemptIdFromContainerId("container_1_1_1_1")).toBe("appattempt_1_1_000001");
    expect(attemptIdFromContainerId("container_e17_1791010984040_0004_03_000002")).toBe("appattempt_1791010984040_0004_000003");
    expect(attemptIdFromContainerId("garbage")).toBeNull();
  });

  it("builds the padded attempt id from the app id", () => {
    expect(attemptIdOf("application_1791010984040_0004", 1)).toBe("appattempt_1791010984040_0004_000001");
    expect(attemptIdOf("nope", 1)).toBeNull();
  });
});

describe("attempt legacy texts", () => {
  it("prints host:rpcPort only for a registered AM", () => {
    expect(attemptHostPortText("smadayma", 34_405)).toBe("smadayma:34405");
    expect(attemptHostPortText("N/A", -1)).toBe("N/A");
    expect(attemptHostPortText(undefined, 34_405)).toBe("N/A");
    expect(attemptHostPortText("h", 65_536)).toBe("N/A");
    expect(attemptHostPortText("h", 0)).toBe("h:0");
  });

  it("labels the tracking link like RMAppAttemptBlock / AppBlock", () => {
    const url = "http://rm:8088/proxy/application_1_0001/";
    expect(attemptTrackingText(url, "RUNNING")).toBe("ApplicationMaster");
    expect(attemptTrackingText(url, "SCHEDULED")).toBe("ApplicationMaster");
    expect(attemptTrackingText(url, "FINISHED")).toBe("History");
    expect(attemptTrackingText(url, "FAILED")).toBe("History");
    expect(attemptTrackingText("N/A", "RUNNING")).toBe("Unassigned");
    expect(attemptTrackingText(undefined, "FINISHED")).toBe("Unassigned");
    expect(legacyTrackingText(url, "ACCEPTED", false)).toBe("ApplicationMaster");
    expect(legacyTrackingText(url, "NEW", false)).toBe("Unassigned");
    expect(legacyTrackingText(url, "KILLED", true)).toBe("History");
  });

  it("joins blacklisted node ids with ', ' and prints '-' when empty", () => {
    expect(blacklistedNodesText("a:1,b:2")).toBe("a:1, b:2");
    expect(blacklistedNodesText("")).toBe("-");
    expect(blacklistedNodesText(undefined)).toBe("-");
  });
});

describe("blacklist lists", () => {
  it("splits the RM's comma-joined ids and treats the legacy '-' as empty", () => {
    expect(blacklistedIds("host1:8041, host2:8041")).toEqual(["host1:8041", "host2:8041"]);
    expect(blacklistedIds("")).toEqual([]);
    expect(blacklistedIds("-")).toEqual([]);
    expect(blacklistedIds(null)).toEqual([]);
  });
});

describe("status timeline", () => {
  it("anchors submitted/attempt/launched/finished and computes the gaps", () => {
    const a = app({ state: "FINISHED", finalStatus: "SUCCEEDED", startedTime: 1_000, launchTime: 3_500, finishedTime: 9_000 });
    const steps = appTimeline(a, [attempt(1, { startTime: 1_200, finishedTime: 9_000, appAttemptState: "FINISHED" })], 20_000);
    expect(steps.map((s) => s.label)).toEqual(["Submitted", "Attempt #1 created", "Launched", "Finished"]);
    expect(steps.map((s) => s.at)).toEqual([1_000, 1_200, 3_500, 9_000]);
    // each milestone owns the gap to the next one: 1000->1200 submitted, 1200->3500 attempt, 3500->9000 launched
    expect(steps.find((s) => s.key === "submitted")?.durationMs).toBe(200);
    expect(steps.find((s) => s.key === "attempt")?.durationMs).toBe(2_300);
    expect(steps.find((s) => s.key === "launched")?.durationMs).toBe(5_500);
    const finished = steps.find((s) => s.key === "finished");
    expect(finished?.durationMs).toBeNull();
    expect(finished?.tone).toBe("ok");
  });

  it("keeps the running milestone open and failing apps red", () => {
    const a = app({ state: "RUNNING", finalStatus: "UNDEFINED", startedTime: 1_000, launchTime: 2_000 });
    const steps = appTimeline(a, [attempt(1, { startTime: 1_500 })], 7_000);
    expect(steps.find((s) => s.key === "finished")?.at).toBeNull();
    expect(steps.find((s) => s.key === "finished")?.label).toBe("Running");
    expect(steps.find((s) => s.key === "launched")?.durationMs).toBe(5_000);
    expect(steps.find((s) => s.key === "finished")?.detail).toBe("No finish time reported yet.");

    const failed = app({ state: "FAILED", finalStatus: "FAILED", startedTime: 1, launchTime: 2, finishedTime: 3 });
    const failedSteps = appTimeline(failed, [attempt(3, { appAttemptState: "FINISHED", startTime: 2, finishedTime: 3 })], 3);
    expect(failedSteps.find((s) => s.key === "finished")?.label).toBe("Failed");
    expect(failedSteps.find((s) => s.key === "finished")?.tone).toBe("fail");

    const finalStatusMissing = app({ state: "FINISHED", finalStatus: "UNDEFINED", startedTime: 1, launchTime: 2, finishedTime: 3 });
    const finalStatusMissingSteps = appTimeline(finalStatusMissing, [attempt(1, { appAttemptState: "FINISHED", startTime: 2 })], 3);
    expect(finalStatusMissingSteps.find((s) => s.key === "finished")?.detail).toBe("Final status unreported");
  });

  it("knows which states are final", () => {
    expect(isAppFinal("FAILED")).toBe(true);
    expect(isAppFinal("RUNNING")).toBe(false);
    expect(isAppFinal(undefined)).toBe(false);
  });
});

describe("nodeHostPort", () => {
  it("prefers the HTTP address, never the scheduler ids", () => {
    // Live payload: nodeHttpAddress is the NM's HTTP endpoint, assignedNodeId/nodeId are the :8041 scheduler ids.
    expect(nodeHostPort({ assignedNodeId: "127.0.0.3:8041", nodeId: "127.0.0.3:8041", nodeHttpAddress: "http://127.0.0.3:8042" })).toBe(
      "127.0.0.3:8042",
    );
    // Falls back to the id forms only when the HTTP address is missing entirely.
    expect(nodeHostPort({ nodeId: "127.0.0.3:8041" })).toBe("127.0.0.3:8041");
  });

  it("strips the URL form the container payload uses", () => {
    // Exactly what ContainerInfo.nodeHttpAddress returns; the backend rejects it as "not a host:port".
    expect(nodeHostPort({ nodeHttpAddress: "http://127.0.0.3:8042" })).toBe("127.0.0.3:8042");
    expect(nodeHostPort({ nodeHttpAddress: "https://127.0.0.3:8042/" })).toBe("127.0.0.3:8042");
  });

  it("is total for absent/empty values", () => {
    expect(nodeHostPort({})).toBeNull();
    expect(nodeHostPort({ nodeHttpAddress: "" })).toBeNull();
    expect(nodeHostPort({ nodeHttpAddress: "http://" })).toBeNull();
  });
});
