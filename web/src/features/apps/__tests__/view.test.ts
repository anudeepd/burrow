import { describe, expect, it } from "vitest";
import type { App } from "~/api/schemas";
import { blacklistedNodesCount, filterApps, computeFacets } from "~/features/apps/view";
import { appsSearchSchema } from "~/features/apps/search";

/** Minimal-but-complete App: every required REST field, overridable per test. */
function makeApp(over: Partial<App> = {}): App {
  return {
    id: "application_1767000000000_0001",
    user: "alice",
    name: "spark-job-1",
    queue: "root.prod.etl",
    state: "RUNNING",
    finalStatus: "UNDEFINED",
    progress: 12.5,
    trackingUI: "ApplicationMaster",
    trackingUrl: "http://rm:8088/proxy/application_1767000000000_0001/",
    diagnostics: "",
    clusterId: 1767000000000,
    applicationType: "SPARK",
    applicationTags: "etl,nightly",
    priority: 0,
    startedTime: 1_000_000,
    launchTime: 1_000_500,
    finishedTime: 0,
    elapsedTime: 60_000,
    allocatedMB: 4096,
    allocatedVCores: 2,
    reservedMB: 0,
    reservedVCores: 0,
    runningContainers: 3,
    memorySeconds: 100,
    vcoreSeconds: 10,
    queueUsagePercentage: 4.5,
    clusterUsagePercentage: 0.5,
    preemptedResourceMB: 0,
    preemptedResourceVCores: 0,
    numNonAMContainerPreempted: 0,
    numAMContainerPreempted: 0,
    unmanagedApplication: false,
    resourceRequests: [],
    ...over,
  };
}

const RUNNING = makeApp();
const FINISHED_OK = makeApp({
  id: "application_1767000000000_0002",
  name: "mr-wordcount",
  user: "bob",
  queue: "root.dev.bob",
  state: "FINISHED",
  finalStatus: "SUCCEEDED",
  applicationType: "MAPREDUCE",
  applicationTags: "",
  progress: 100,
  finishedTime: 2_000_000,
  runningContainers: 0,
  allocatedMB: 0,
  allocatedVCores: 0,
  startedTime: 1_500_000,
});
const FAILED = makeApp({
  id: "application_1767000000000_0003",
  name: "spark-job-broken",
  user: "alice",
  state: "FAILED",
  finalStatus: "FAILED",
  applicationType: "SPARK",
  finishedTime: 3_000_000,
  startedTime: 2_500_000,
});
const KILLED = makeApp({
  id: "application_1767000000000_0004",
  name: "spark-streaming",
  user: "svc-ml",
  queue: "root.prod.reports",
  state: "KILLED",
  finalStatus: "KILLED",
  finishedTime: 4_000_000,
  startedTime: 3_500_000,
});
const ACCEPTED = makeApp({
  id: "application_1767000000000_0005",
  name: "pending-job",
  user: "bob",
  state: "ACCEPTED",
  finalStatus: "UNDEFINED",
  trackingUI: "UNASSIGNED",
  trackingUrl: undefined,
  runningContainers: 0,
  allocatedMB: 0,
  allocatedVCores: 0,
  startedTime: 4_500_000,
});
const ALL = [RUNNING, FINISHED_OK, FAILED, KILLED, ACCEPTED];

const parse = (input: Record<string, unknown>) => appsSearchSchema.parse(input);

describe("computeFacets", () => {
  const facets = computeFacets(ALL);
  it("counts every state and the active roll-up", () => {
    expect(facets.total).toBe(5);
    expect(facets.byState.RUNNING).toBe(1);
    expect(facets.byState.FAILED).toBe(1);
    expect(facets.active).toBe(2); // RUNNING + ACCEPTED
  });
  it("counts final statuses, users, queues, types and tags", () => {
    expect(facets.byFinal.SUCCEEDED).toBe(1);
    expect(facets.byFinal.KILLED).toBe(1);
    expect(facets.users.find((u) => u.value === "alice")?.count).toBe(2);
    expect(facets.queues.find((q) => q.value === "root.prod.etl")?.count).toBe(3);
    expect(facets.types.find((t) => t.value === "SPARK")?.count).toBe(4);
    expect(facets.tags.map((t) => t.value)).toEqual(["etl", "nightly"]);
  });
  it("is empty for no apps", () => {
    expect(computeFacets([]).total).toBe(0);
  });
});

describe("filterApps", () => {
  it("returns everything by default", () => {
    expect(filterApps(ALL, parse({})).length).toBe(5);
  });
  it("filters by state list", () => {
    expect(filterApps(ALL, parse({ states: "FAILED,KILLED" })).map((a) => a.id)).toEqual([FAILED.id, KILLED.id]);
  });
  it("treats states=ALL as no filter", () => {
    expect(filterApps(ALL, parse({ states: "ALL" })).length).toBe(5);
  });
  it("ignores unknown states instead of throwing", () => {
    expect(filterApps(ALL, parse({ states: "BOGUS" })).length).toBe(5);
  });
  it("filters by final status, user, queue and type", () => {
    expect(filterApps(ALL, parse({ final: "SUCCEEDED" })).map((a) => a.name)).toEqual(["mr-wordcount"]);
    expect(filterApps(ALL, parse({ user: "alice" })).length).toBe(2);
    expect(filterApps(ALL, parse({ queue: "root.prod.reports" })).length).toBe(1);
    expect(filterApps(ALL, parse({ type: "MAPREDUCE" })).length).toBe(1);
  });
  it("filters by tag (case-insensitive, exact tag)", () => {
    expect(filterApps(ALL, parse({ tag: "ETL" })).length).toBe(4);
    expect(filterApps(ALL, parse({ tag: "e" })).length).toBe(0);
  });
  it("searches the name, or the id when the needle looks like one", () => {
    expect(filterApps(ALL, parse({ name: "wordcount" })).length).toBe(1);
    expect(filterApps(ALL, parse({ name: "spark" })).length).toBe(3);
    expect(filterApps(ALL, parse({ name: "application_1767000000000_0003" })).map((a) => a.name)).toEqual(["spark-job-broken"]);
  });
  it("filters started/finished ranges", () => {
    expect(filterApps(ALL, parse({ startedAfter: 2_000_000 })).map((a) => a.name)).toEqual([
      "spark-job-broken",
      "spark-streaming",
      "pending-job",
    ]);
    expect(filterApps(ALL, parse({ startedBefore: 1_500_000 })).map((a) => a.name)).toEqual(["spark-job-1", "mr-wordcount"]);
    expect(filterApps(ALL, parse({ finishedAfter: 3_500_000 })).map((a) => a.name)).toEqual(["spark-streaming"]);
    // RM semantics: `finishedBefore` alone keeps not-yet-finished apps (finishedTime 0 <= end) …
    expect(filterApps(ALL, parse({ finishedBefore: 1 })).map((a) => a.name)).toEqual(["spark-job-1", "pending-job"]);
    // … while `finishedAfter` excludes them (0 < begin).
    expect(filterApps(ALL, parse({ finishedAfter: 1 })).map((a) => a.name)).toEqual([
      "mr-wordcount",
      "spark-job-broken",
      "spark-streaming",
    ]);
  });
  it("combines filters (AND)", () => {
    expect(filterApps(ALL, parse({ user: "alice", final: "FAILED" })).map((a) => a.name)).toEqual(["spark-job-broken"]);
  });
});

describe("blacklistedNodesCount", () => {
  it("is undefined (legacy N/A) when the app has no attempt", () => {
    expect(blacklistedNodesCount([])).toBeUndefined();
  });
  it("counts the comma-joined blacklisted nodes of the current (highest-numbered) attempt only", () => {
    expect(
      blacklistedNodesCount([
        { id: 1, blacklistedNodes: "n1:8041, n2:8041, n3:8041" },
        { id: 3, blacklistedNodes: "n4:8041,n5:8041" },
        { id: 2, blacklistedNodes: "n1:8041" },
      ]),
    ).toBe(2);
  });
  it("is 0 for an empty or absent list", () => {
    expect(blacklistedNodesCount([{ id: 1, blacklistedNodes: "" }])).toBe(0);
    expect(blacklistedNodesCount([{ id: 1, blacklistedNodes: "-" }])).toBe(0);
    expect(blacklistedNodesCount([{ id: 1 }])).toBe(0);
  });
});
