/**
 * Overview derivations, checked against **real captured payloads** (`fixtures/rm/overview/*.json`, captured from the
 * live Hadoop 3.4.3 ResourceManager) and against the legacy text the same cluster rendered at `/cluster/cluster`.
 *
 * The three `resourceText` expectations below are byte-identical to what `#metricsoverview` showed on the live cluster
 * (`<memory:0 B, vCores:0>` / `<memory:9 GB, vCores:12>`), which is the whole point of this module (PLAN §8 P2).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClusterMetrics, SchedulerInfo, SchedulerResponse } from "~/api/schemas";
import {
  ACTIVE_STATES,
  appsCompletedAll,
  appPhase,
  byteDesc,
  containersRunning,
  customResources,
  maxAllocationText,
  maximumClusterPriority,
  minAllocationText,
  queueTeasers,
  reservedResources,
  resourceInfoText,
  resourceText,
  schedulerBusyPercent,
  schedulerDisplayName,
  schedulingResourceTypesFromInfo,
  schedulingResourceTypesText,
  subtractCustomResources,
  totalResources,
  trackingHref,
  trackingUiText,
  usedResources,
  withinWindow,
} from "../derive";

/** Fixtures live at the repo root; `vitest` runs with `web/` as cwd, and vite must not see this path (hence node:fs). */
const fixture = <T>(name: string): T => JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/overview", name), "utf8")) as T;

const metrics = fixture<{ clusterMetrics: ClusterMetrics }>("metrics.json").clusterMetrics;
const schedulerInfo = fixture<SchedulerResponse>("scheduler.json").scheduler.schedulerInfo as SchedulerInfo;
const schedulerOverview = fixture<{
  schedulerType: string;
  schedulingResourceType: string;
  minimumAllocation: { memory: string; vCores: string };
  maximumAllocation: { memory: string; vCores: string };
  applicationPriority: string;
}>("scheduler-overview.json");

describe("byteDesc (Hadoop StringUtils.byteDesc / TraditionalBinaryPrefix.long2String)", () => {
  it("prints plain bytes below 1 KiB, exactly like Hadoop", () => {
    expect(byteDesc(0)).toBe("0 B");
    expect(byteDesc(1023)).toBe("1023 B");
  });

  it("uses the exact-division fast path (no decimals)", () => {
    expect(byteDesc(1024)).toBe("1 KB");
    expect(byteDesc(1024 ** 2)).toBe("1 MB");
    expect(byteDesc(9216 * 1024 ** 2)).toBe("9 GB");
  });

  it("uses two decimals otherwise", () => {
    expect(byteDesc(1500 * 1024 ** 2)).toBe("1.46 GB");
  });

  it("promotes a value that rounds up to 1024 to the next prefix", () => {
    expect(byteDesc(1_073_738_000)).toBe("1.00 GB");
  });

  it("never produces NaN/garbage for absent or non-finite input", () => {
    expect(byteDesc(null)).toBe("");
    expect(byteDesc(undefined)).toBe("");
    expect(byteDesc(Number.NaN)).toBe("");
  });
});

describe("legacy resource strings", () => {
  it("renders Resource.getFormattedString() text", () => {
    expect(resourceText(0, 0)).toBe("<memory:0 B, vCores:0>");
    expect(resourceText(9216, 12)).toBe("<memory:9 GB, vCores:12>");
  });

  it("renders ResourceInfo.toString() text for allocation limits", () => {
    expect(resourceInfoText(Number(schedulerOverview.minimumAllocation.memory), Number(schedulerOverview.minimumAllocation.vCores))).toBe(
      "<memory:256, vCores:1>",
    );
    expect(resourceInfoText(Number(schedulerOverview.maximumAllocation.memory), Number(schedulerOverview.maximumAllocation.vCores))).toBe(
      "<memory:3072, vCores:4>",
    );
  });

  it("appends custom resource types exactly like Resource.getFormattedString", () => {
    const ris = [
      { name: "memory-mb", value: 1024, units: "Mi", tags: [] },
      { name: "vcores", value: 4, units: "", tags: [] },
      { name: "yarn.io/gpu", value: 2, units: "", tags: [] },
    ];
    const info = { memory: 1024, vCores: 4, resourceInformations: { resourceInformation: ris } } as never;
    expect(customResources(info)).toEqual([{ name: "yarn.io/gpu", value: 2, units: "" }]);
    expect(resourceText(1024, 4, customResources(info))).toBe("<memory:1 GB, vCores:4, yarn.io/gpu: 2>");
  });

  it("subtracts reserved custom resources (used = used − reserved)", () => {
    expect(subtractCustomResources([{ name: "yarn.io/gpu", value: 3, units: "" }], [{ name: "yarn.io/gpu", value: 1, units: "" }])).toEqual(
      [{ name: "yarn.io/gpu", value: 2, units: "" }],
    );
    expect(subtractCustomResources([{ name: "yarn.io/gpu", value: 1, units: "" }], [{ name: "yarn.io/gpu", value: 1, units: "" }])).toEqual(
      [],
    );
  });
});

describe("legacy #metricsoverview cells from the captured ClusterMetrics", () => {
  /**
   * The live page at http://127.0.0.1:8088/cluster/cluster, scraped at the same moment as the fixtures above
   * (Hadoop 3.4.3, Capacity Scheduler, one RUNNING Spark app):
   *   ['11','0','1','10','3','<memory:2.25 GB, vCores:3>','<memory:9 GB, vCores:12>','<memory:0 B, vCores:0>','206','0']
   * The `utilizedMBPercent` cell drifts by a point or two because the RM averages a moving quantity (the running app's
   * memory) between the two reads; every other cell is a function of the fixture and must match exactly.
   */
  it("reproduces the legacy Apps Completed cell (completed + failed + killed)", () => {
    expect(appsCompletedAll(metrics)).toBe(10);
  });

  it("takes the cross-partition branch the captured payload reports", () => {
    expect(metrics.crossPartitionMetricsAvailable).toBe(true);
    expect(containersRunning(metrics)).toBe(metrics.totalAllocatedContainersAcrossPartition);
    expect(containersRunning(metrics)).toBe(3);
    expect(resourceText(usedResources(metrics).memory, usedResources(metrics).vCores)).toBe("<memory:2.25 GB, vCores:3>");
    expect(resourceText(totalResources(metrics).memory, totalResources(metrics).vCores)).toBe("<memory:9 GB, vCores:12>");
    expect(resourceText(reservedResources(metrics).memory, reservedResources(metrics).vCores)).toBe("<memory:0 B, vCores:0>");
  });

  it("falls back to the default-partition counters when cross-partition metrics are absent", () => {
    const m = {
      ...metrics,
      crossPartitionMetricsAvailable: false,
      totalMB: 3072,
      totalVirtualCores: 4,
      allocatedMB: 512,
      allocatedVirtualCores: 1,
    } as ClusterMetrics;
    expect(totalResources(m)).toMatchObject({ memory: 3072, vCores: 4 });
    expect(usedResources(m)).toMatchObject({ memory: 512, vCores: 1 });
    expect(containersRunning(m)).toBe(m.containersAllocated);
  });

  it("maps the -1 scheduler-busy sentinel to N/A (null), never to a number", () => {
    expect(schedulerBusyPercent({ ...metrics, rmSchedulerBusyPercent: -1 } as ClusterMetrics)).toBeNull();
    expect(schedulerBusyPercent({ ...metrics, rmSchedulerBusyPercent: undefined } as ClusterMetrics)).toBeNull();
    expect(schedulerBusyPercent({ ...metrics, rmSchedulerBusyPercent: 0 } as ClusterMetrics)).toBe(0);
  });

  it("passes the RM's own utilisation percentages through untouched (it can exceed 100)", () => {
    expect(metrics.utilizedMBPercent).toBeGreaterThan(0);
  });
});

describe("scheduler block", () => {
  it("re-derives the legacy 'Scheduling Resource Type' text from the REST string", () => {
    expect(schedulingResourceTypesText(schedulerOverview.schedulingResourceType)).toBe("[memory-mb (unit=Mi), vcores]");
    expect(schedulingResourceTypesText(null)).toBeNull();
  });

  it("maps the REST discriminator to the legacy display name", () => {
    expect(schedulerDisplayName("capacityScheduler")).toBe("Capacity Scheduler");
    expect(schedulerDisplayName("fairScheduler")).toBe("Fair Scheduler");
    expect(schedulerDisplayName("fifoScheduler")).toBe("Fifo Scheduler");
    expect(schedulerDisplayName("quantumScheduler")).toBe("quantumScheduler");
  });

  it("derives the scheduling resource types, max allocation (with extra resources) from schedulerInfo", () => {
    const si = {
      type: "capacityScheduler",
      maximumAllocation: {
        memory: 3072,
        vCores: 4,
        resourceInformations: {
          resourceInformation: [
            { name: "memory-mb", units: "Mi", value: 3072 },
            { name: "vcores", units: "", value: 4 },
            { name: "yarn.io/gpu", units: "", value: 2 },
          ],
        },
      },
    } as unknown as SchedulerInfo;
    expect(schedulingResourceTypesFromInfo(si)).toBe("[memory-mb (unit=Mi), vcores, yarn.io/gpu]");
    expect(maxAllocationText(si)).toBe("<memory:3072, vCores:4, yarn.io/gpu: 2>");
    expect(schedulingResourceTypesFromInfo({ type: "fifoScheduler" } as unknown as SchedulerInfo)).toBeNull();
    expect(maxAllocationText(undefined)).toBeNull();
    const plain = {
      maximumAllocation: { memory: 3072, vCores: 4 },
    } as unknown as SchedulerInfo;
    expect(maxAllocationText(plain)).toBe("<memory:3072, vCores:4>");
  });

  it("reads min allocation and max cluster priority from the effective RM conf", () => {
    const conf = [
      { key: "yarn.scheduler.minimum-allocation-mb", value: "256" },
      { key: "yarn.scheduler.minimum-allocation-vcores", value: "1" },
      { key: "yarn.cluster.max-application-priority", value: "10" },
    ];
    expect(minAllocationText(conf)).toBe("<memory:256, vCores:1>");
    expect(maximumClusterPriority(conf)).toBe(10);
    expect(minAllocationText([])).toBeNull();
    expect(maximumClusterPriority(undefined)).toBeNull();
    expect(maximumClusterPriority([{ key: "yarn.cluster.max-application-priority", value: "x" }])).toBeNull();
  });

  it("reads the captured capacity queue tree, with the raw field ids the view stamps", () => {
    const rows = queueTeasers(schedulerInfo);
    expect(rows.map((r) => r.path)).toEqual(["root.default", "root.adhoc", "root.etl"]);
    expect(rows[0]).toMatchObject({ used: { field: "queue.usedCapacity", fmt: "pct" }, guarantee: { field: "queue.absoluteCapacity" } });
    for (const row of rows) {
      expect(typeof row.used.raw).toBe("number");
      expect(row.used.text).toBe(`${(row.used.raw as number).toFixed(1)}%`);
    }
  });

  it("has no queue tree for a scheduler that is not a tree", () => {
    expect(queueTeasers({ type: "fifoScheduler" } as SchedulerInfo)).toEqual([]);
    expect(queueTeasers(null)).toEqual([]);
  });
});

describe("application state helpers", () => {
  it("covers exactly the five non-terminal states the rail asks for", () => {
    expect(ACTIVE_STATES).toEqual(["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED", "RUNNING"]);
    expect(ACTIVE_STATES).not.toContain("FINISHED");
  });

  it("classifies phases", () => {
    expect(appPhase("RUNNING")).toBe("running");
    expect(appPhase("ACCEPTED")).toBe("queued");
    expect(appPhase("FINISHED")).toBe("terminal");
    expect(appPhase(undefined)).toBe("terminal");
  });

  it("reproduces the legacy Tracking UI text from the state, never the REST trackingUI key", () => {
    // NEW: `Unassigned` whatever the REST payload says (even a real URL).
    expect(trackingUiText({ trackingUI: "UNASSIGNED", trackingUrl: "N/A", state: "NEW" })).toBe("Unassigned");
    expect(trackingUiText({ trackingUI: "UNASSIGNED", trackingUrl: "http://x", state: "NEW" })).toBe("Unassigned");
    // Live: an ACCEPTED app whose REST `trackingUrl` is absent and whose `trackingUI` says UNASSIGNED is still
    // `ApplicationMaster` on the legacy page; the REST key must not drive the label.
    expect(trackingUiText({ trackingUI: "UNASSIGNED", trackingUrl: null, state: "ACCEPTED" })).toBe("ApplicationMaster");
    expect(trackingUiText({ trackingUI: "ApplicationMaster", trackingUrl: undefined, state: "RUNNING" })).toBe("ApplicationMaster");
    expect(trackingUiText({ trackingUI: "ApplicationMaster", trackingUrl: "http://am:4040", state: "RUNNING" })).toBe("ApplicationMaster");
    // Final states are `History` even if a URL is missing (live they always carry one).
    expect(trackingUiText({ trackingUI: "History", trackingUrl: "http://shs:18080/history/app", state: "FINISHED" })).toBe("History");
    expect(trackingUiText({ trackingUI: "History", trackingUrl: null, state: "KILLED" })).toBe("History");
  });

  it("links the REST URL when present and falls back to the RM proxy only for a live app past NEW", () => {
    expect(trackingHref({ trackingUrl: "http://am:4040", state: "RUNNING" })).toBe("http://am:4040");
    // The RM page points ACCEPTED apps at its own proxy URL even though the REST payload omits `trackingUrl`.
    expect(trackingHref({ id: "application_1_0001", trackingUrl: null, state: "ACCEPTED" }, "http://127.0.0.1:8088")).toBe(
      "http://127.0.0.1:8088/proxy/application_1_0001/",
    );
    // No configured base, no app id, a placeholder URL, NEW, or a final state without a URL: no link.
    expect(trackingHref({ id: "application_1_0001", trackingUrl: null, state: "ACCEPTED" })).toBeNull();
    expect(trackingHref({ trackingUrl: null, state: "ACCEPTED" }, "http://rm:8088")).toBeNull();
    expect(trackingHref({ trackingUrl: "UNASSIGNED", state: "RUNNING" })).toBeNull();
    expect(trackingHref({ trackingUrl: undefined, state: "RUNNING" })).toBeNull();
    expect(trackingHref({ id: "application_1_0001", trackingUrl: null, state: "NEW" }, "http://rm:8088")).toBeNull();
    expect(trackingHref({ id: "application_1_0001", trackingUrl: null, state: "FINISHED" }, "http://rm:8088")).toBeNull();
  });
});

describe("history window", () => {
  const samples = [
    { t: 0, v: 1 },
    { t: 1_900_000, v: 2 },
    { t: 2_000_000, v: 3 },
  ];
  it("filters to the requested window and keeps everything for 'all'", () => {
    // "5m" = 300 s before `now` (2 000 000), so only the newest two samples survive.
    expect(withinWindow(samples, "5m", 2_000_000)).toEqual([
      { t: 1_900_000, v: 2 },
      { t: 2_000_000, v: 3 },
    ]);
    expect(withinWindow(samples, "30m", 2_000_000)).toHaveLength(2);
    expect(withinWindow(samples, "all", 2_000_000)).toHaveLength(3);
  });
});
