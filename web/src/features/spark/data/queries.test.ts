import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sp } from "./queries";
import { compact, serializeColumns } from "./search";

const APP = "application_123_0001";
afterEach(() => vi.unstubAllGlobals());

describe("Spark task capture", () => {
  it("loads explicit pages past Spark's 20-row default and keeps the application attempt", async () => {
    const requests: URL[] = [];
    const tasks = Array.from({ length: 1005 }, (_, taskId) => ({ taskId, index: taskId, status: "SUCCESS", accumulatorUpdates: [] }));
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input, "http://localhost");
      requests.push(url);
      const offset = Number(url.searchParams.get("offset"));
      const length = Number(url.searchParams.get("length"));
      return new Response(JSON.stringify(tasks.slice(offset, offset + length)), { headers: { "content-type": "application/json" } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const captured = await client.fetchQuery(sp.allTasks(APP, 3, 1, "static", "2"));
    expect(captured).toHaveLength(1005);
    expect(captured.at(-1)?.taskId).toBe(1004);
    expect(requests.map((r) => r.searchParams.get("offset"))).toEqual(["0", "1000"]);
    expect(requests.every((r) => r.searchParams.get("length") === "1000" && r.searchParams.get("attempt") === "2")).toBe(true);
    client.clear();
  });

  it("clears explicit columns when the table resets to defaults", () => {
    expect(compact({ cols: "-host", ...serializeColumns({}) })).toEqual({});
  });

  it("builds query options with optional filters both omitted and fully specified", () => {
    const defaults = [
      sp.source(APP),
      sp.application(APP),
      sp.jobs(APP),
      sp.job(APP, 3),
      sp.stages(APP),
      sp.stageAttempts(APP, 3),
      sp.stageAttempt(APP, 3, 1),
      sp.taskSummary(APP, 3, 1),
      sp.taskList(APP, 3, 1),
      sp.allTasks(APP, 3, 1),
      sp.executors(APP),
      sp.allExecutors(APP),
      sp.rdds(APP),
      sp.rdd(APP, 7),
      sp.environment(APP),
      sp.sql(APP),
      sp.sqlExecution(APP, 5),
      sp.streamingStatistics(APP),
      sp.streamingReceivers(APP),
      sp.streamingBatches(APP),
      sp.streamingBatch(APP, 0),
      sp.dagJob(APP, 3),
      sp.dagStage(APP, 3, 1),
    ];
    const configured = [
      sp.source(APP, "2"),
      sp.jobs(APP, { status: "RUNNING", kind: "static", attempt: "2" }),
      sp.stages(APP, {
        status: "ACTIVE",
        details: true,
        withSummaries: true,
        quantiles: [0.5, 0.95],
        taskStatus: "RUNNING",
        kind: "static",
        attempt: "2",
      }),
      sp.stageAttempt(APP, 3, 1, { details: true, withSummaries: true, quantiles: [0.5], kind: "static", attempt: "2" }),
      sp.taskSummary(APP, 3, 1, [0.25, 0.75], "static", "2"),
      sp.taskList(APP, 3, 1, { offset: 0, length: 50, sortBy: "duration", status: "SUCCESS", kind: "static", attempt: "2" }),
      sp.executors(APP, "static", "2"),
      sp.allExecutors(APP, "static", "2"),
      sp.rdds(APP, "static", "2"),
      sp.rdd(APP, 7, "static", "2"),
      sp.environment(APP, "2"),
      sp.sql(APP, { details: true, planDescription: true, offset: 0, length: 20, kind: "static", attempt: "2" }),
      sp.sqlExecution(APP, 5, { details: false, planDescription: false, kind: "live", attempt: "2" }),
      sp.streamingStatistics(APP, "static", "2"),
      sp.streamingReceivers(APP, "static", "2"),
      sp.streamingBatches(APP, "live", "2"),
      sp.streamingBatch(APP, 0, "live", "2"),
      sp.dagJob(APP, 3, "2"),
      sp.dagStage(APP, 3, 1, "2"),
    ];

    expect(defaults.every((query) => query.queryKey.length > 0)).toBe(true);
    expect(configured.every((query) => query.queryKey.length > 0)).toBe(true);
    expect(sp.sqlExecution(APP, 5).queryKey).not.toEqual(sp.sqlExecution(APP, 5, { details: false }).queryKey);
  });
});
