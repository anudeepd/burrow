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
import { errorReason, ov } from "./queries/overview";
import { nq } from "./queries/nodes";
import { tq } from "./queries/tools";

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
    ];
    for (const query of options) await execute(query);

    expect(apiGetMock).toHaveBeenCalledTimes(options.length - 4);
    expect(apiTextMock).toHaveBeenCalledTimes(4);
    expect(apiGetMock).toHaveBeenCalledWith("yarn/nodes/worker:8041", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(apiTextMock).toHaveBeenCalledWith(
      "rm/logs/worker:8041%2Fthread%20dump",
      expect.objectContaining({ query: { offset: 10, length: 20 } }),
    );
    expect(topicOfMock).toHaveBeenCalledWith("yarn/apps", APPS_QUERY);
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
  });
});
