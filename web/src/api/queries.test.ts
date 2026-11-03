// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const { apiGetMock, apiTextMock, topicOfMock, adaptiveMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiTextMock: vi.fn(),
  topicOfMock: vi.fn((path: string) => path),
  adaptiveMock: vi.fn(() => ({})),
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  apiGet: apiGetMock,
  apiText: apiTextMock,
  topicOf: topicOfMock,
}));
vi.mock("./refetch", () => ({ adaptive: adaptiveMock }));

import { APPS_QUERY, q } from "./queries";
import { ApiError } from "./client";
import { errorReason, isSourceUnavailable, ov } from "./queries/overview";
import { nq } from "./queries/nodes";
import { tq } from "./queries/tools";
import { nodesQuery, queueAppsQuery, schedulerActivitiesQuery, schedulerConfQuery, schedulerQuery } from "./queries/scheduler";
import { lq } from "./queries/logs";

async function execute(options: unknown): Promise<void> {
  const queryFn = (options as { queryFn?: (context: { signal: AbortSignal }) => Promise<unknown> }).queryFn;
  await queryFn?.({ signal: new AbortController().signal });
}

describe("API query option factories", () => {
  it("builds and executes each endpoint query with its selected arguments", async () => {
    apiGetMock.mockResolvedValue({});
    apiTextMock.mockResolvedValue({ data: "thread dump" });

    const options = [
      q.meta(),
      q.info(),
      q.metrics(),
      q.scheduler(),
      q.schedulerActivities(),
      q.schedulerActivities({ nodeId: "node:8041", groupBy: "user" }),
      q.schedulerConf(),
      q.apps(),
      q.appsFiltered({ state: "RUNNING" }),
      q.app("application:1"),
      q.appAttempts("application:1"),
      q.appAttemptDetail("application:1", "appattempt:2"),
      q.appContainers("application:1", "appattempt:2"),
      q.appContainer("application:1", "appattempt:2", "container:3"),
      q.appState("application:1"),
      q.appPriority("application:1"),
      q.appQueue("application:1"),
      q.appTimeout("application:1", "LIFETIME"),
      q.appTimeouts("application:1"),
      q.appActivities("application:1"),
      q.appStatisticsAll(),
      q.appStatisticsAll({ state: "RUNNING" }),
      q.nodes(),
      q.nodes({ states: "RUNNING" }),
      q.node("worker:8041"),
      q.nodeLabels(),
      q.nodeToLabels(),
      q.labelMappings(),
      q.resourceProfiles(),
      q.resourceTypes(),
      q.container("container:3"),
      q.rmConf(),
      q.rmJmx(),
      q.rmJmx("Hadoop:name=JvmMetrics"),
      q.rmStacks(),
      q.rmLogs(),
      tq.logFile("worker:8041/thread dump", { offset: 10, length: 20 }),
      q.rmLogFile("worker:8041/thread dump", { offset: 10, length: 20 }),
      q.rmLogFile("stderr"),
      q.rmMetrics(),
      nq.nodeToLabels(),
      nq.labelMappings(),
      nq.resourceTypes(),
      nq.nmApps("worker:8041"),
      nq.nodes(),
      nq.nodes({ states: "RUNNING", healthy: true }),
      nq.node("worker:8041"),
      nq.nodeLabels(),
      nq.nmInfo("worker:8041"),
      nq.nmContainers("worker:8041"),
      nq.nmConf("worker:8041"),
      nq.nmJmx("worker:8041"),
      nq.nmJmx("worker:8041", "java.lang:type=Memory"),
      tq.conf(),
      tq.jmx(),
      tq.jmx("Hadoop:name=JvmMetrics"),
      tq.stacks(),
      tq.logs(),
      tq.logFile("stderr"),
      lq.files("container_1", { node: "worker:8041" }),
      lq.files("container_1"),
      schedulerQuery(),
      schedulerActivitiesQuery(),
      schedulerActivitiesQuery({ nodeId: "worker:8041" }),
      schedulerConfQuery(),
      schedulerConfQuery("capacityScheduler"),
      queueAppsQuery("root.default"),
      queueAppsQuery("root.default", []),
      queueAppsQuery("root.default", ["RUNNING"]),
      nodesQuery(),
    ];
    for (const query of options) await execute(query);

    expect(apiGetMock).toHaveBeenCalledTimes(options.length - 6);
    expect(apiTextMock).toHaveBeenCalledTimes(6);
    expect(apiGetMock).toHaveBeenCalledWith("yarn/nodes/worker:8041", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(apiTextMock).toHaveBeenCalledWith(
      "rm/logs/worker:8041%2Fthread%20dump",
      expect.objectContaining({ query: { offset: 10, length: 20 } }),
    );
    expect(topicOfMock).toHaveBeenCalledWith("yarn/apps", APPS_QUERY);
    expect(apiGetMock).toHaveBeenCalledWith("nm/worker:8041/info", expect.anything());
    expect(apiGetMock).toHaveBeenCalledWith("nm/worker:8041/jmx", expect.objectContaining({ query: { qry: "java.lang:type=Memory" } }));
  });

  it("normalizes absent, singleton, and repeated app-list entries", () => {
    const apps = q.apps();
    const item = { id: "application_1_1" } as never;
    expect(apps.select({})).toEqual([]);
    expect(apps.select({ apps: null })).toEqual([]);
    expect(apps.select({ apps: { app: null } })).toEqual([]);
    expect(apps.select({ apps: { app: item } })).toEqual([item]);
    expect(apps.select({ apps: { app: [item, item] } })).toEqual([item, item]);
    expect(q.appsFiltered({ state: "RUNNING" }).select({ apps: { app: item } })).toEqual([item]);
    expect(q.app("application:1").select({ app: item })).toBe(item);
    expect(q.info().select({ clusterInfo: item })).toBe(item);
    expect(q.metrics().select({ clusterMetrics: item })).toBe(item);
  });

  it("normalizes node, label, queue, scheduler, and mapping selections", () => {
    const node = { id: "worker:8041" } as never;
    const label = { name: "analytics", exclusivity: true } as never;
    const mapping = { key: label, value: { nodes: ["worker:8041"] } } as never;
    expect(nq.nodes().select({})).toEqual([]);
    expect(nq.nodes().select({ nodes: null })).toEqual([]);
    expect(nq.nodes().select({ nodes: { node } })).toEqual([node]);
    expect(nq.nodes().select({ nodes: { node: [node, node] } })).toEqual([node, node]);
    expect(nq.node("worker:8041").select({ node })).toBe(node);
    expect(nq.nodeLabels().select({ nodeLabelInfo: [label] } as never)).toEqual([label]);
    expect(nq.nodeToLabels().select({ nodeToLabels: { "worker:8041": { nodeLabelInfo: [label] } } } as never)).toEqual({
      "worker:8041": [label],
    });
    expect(nq.nodeToLabels().select({} as never)).toEqual({});
    expect(nq.labelMappings().select({ labelsToNodes: { entry: [mapping] } } as never)).toEqual([mapping]);
    expect(nq.labelMappings().select({} as never)).toEqual([]);
    expect(queueAppsQuery("root.default").select({})).toEqual([]);
    expect(queueAppsQuery("root.default").select({ apps: { app: node } })).toEqual([node]);
    expect(queueAppsQuery("root.default").select({ apps: { app: [node, node] } })).toEqual([node, node]);
    expect(schedulerQuery().select({ scheduler: { schedulerInfo: node } } as never)).toBe(node);
    expect(schedulerActivitiesQuery().select({ activities: node } as never)).toBe(node);
    expect(schedulerConfQuery().select({ property: [node] } as never)).toEqual([node]);
    expect(nodesQuery().select({ nodes: { node } } as never)).toEqual([node]);
    const property = { key: "yarn.scheduler.name", value: "Capacity", isFinal: false };
    const bean = { name: "java.lang:type=Memory" };
    expect(tq.conf().select({ properties: [property] } as never)).toEqual([property]);
    expect(tq.jmx().select({ beans: [bean] } as never)).toEqual([bean]);
  });

  it("builds overview aliases and executes the scheduler overview endpoint", async () => {
    apiGetMock.mockClear();
    apiGetMock.mockResolvedValue({});
    topicOfMock.mockClear();
    adaptiveMock.mockClear();

    expect(ov.meta().queryKey).toEqual(q.meta().queryKey);
    expect(ov.info().queryKey).toEqual(q.info().queryKey);
    expect(ov.metrics().queryKey).toEqual(q.metrics().queryKey);
    expect(ov.nodes().queryKey).toEqual(q.nodes().queryKey);
    expect(ov.scheduler().queryKey).toEqual(q.scheduler().queryKey);
    expect(ov.appsActive().queryKey).toEqual(q.appsFiltered({ states: "NEW,NEW_SAVING,SUBMITTED,ACCEPTED,RUNNING" }).queryKey);
    const schedulerOverview = ov.schedulerOverview();
    await execute(schedulerOverview);
    expect(apiGetMock).toHaveBeenCalledWith("yarn/scheduler-overview", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(topicOfMock).toHaveBeenCalledWith("yarn/scheduler-overview");
  });

  it("explains endpoint failures in the unavailable-state copy", () => {
    expect(errorReason(new ApiError("missing", "http", 404))).toContain("not exposed");
    expect(errorReason(new ApiError("failed", "http", 500, null, null, "check the daemon"))).toBe("check the daemon");
    expect(errorReason(new ApiError("request failed", "http", 500))).toBe("request failed");
    expect(errorReason(new Error("network down"))).toBe("network down");
    expect(errorReason("bad response")).toBe("unknown error");
    for (const status of [404, 501, 502, 503]) expect(isSourceUnavailable(new ApiError("unavailable", "http", status))).toBe(true);
    expect(isSourceUnavailable(new ApiError("server error", "http", 500))).toBe(false);
    expect(isSourceUnavailable(new Error("network error"))).toBe(false);
  });
});
