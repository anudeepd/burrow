import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import type { SparkEnvironment, SparkExecutor, SparkJob, SparkRdd, SparkStage, SparkTask, SparkTaskSummary } from "../data/schemas";

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { ExecutorsPage } = await import("./ExecutorsPage");
const { JobsPage } = await import("./JobsPage");
const { StagesPage } = await import("./StagesPage");
const { EnvironmentPage } = await import("./EnvironmentPage");
const { StoragePage } = await import("./StoragePage");
const { TimelinePage } = await import("./TimelinePage");
const { StageDetailPage } = await import("./StageDetailPage");
const { SparkProvider } = await import("../ui/context");
const { sp } = await import("../data/queries");
const { sparkSearch } = await import("../data/search");
const { q } = await import("~/api/queries");

const APP_ID = "application_1791010984040_0033";
const FIXTURE = resolve(process.cwd(), "../fixtures/spark/3.5.9/dstream/rest");
const readJson = (name: string) => JSON.parse(readFileSync(`${FIXTURE}/${name}`, "utf8")) as unknown;
const executors = readJson("final.executors.json") as SparkExecutor[];
const allExecutors = readJson("final.allexecutors.json") as SparkExecutor[];
const jobs = readJson("final.jobs.status-succeeded.json") as SparkJob[];
const allJobs = readJson("final.jobs.json") as SparkJob[];
const stages = readJson("final.stages.status-complete.json") as SparkStage[];
const allStages = readJson("final.stages.json") as SparkStage[];
const environment = readJson("final.environment.json") as SparkEnvironment;
const rdds = readJson("final.storage.rdd.json") as SparkRdd[];
const stageDetail = readJson("final.stage-0-0.withSummaries.json") as SparkStage;
const stageAttempts = readJson("final.stage-0.json") as SparkStage[];
const stageTasks = readJson("final.stage-0-0.taskList.json") as SparkTask[];
const successfulTasks = readJson("final.stage-0-0.taskList.status-success.json") as SparkTask[];
const taskSummary = readJson("final.stage-0-0.taskSummary.json") as SparkTaskSummary;

function renderListPage(
  page: "executors" | "jobs" | "stages" | "environment" | "storage" | "timeline" | "stage-detail",
  search = "",
  configure?: (client: InstanceType<typeof QueryClient>) => void,
) {
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, path: "/apps/$appId" });
  const spark = createRoute({ getParentRoute: () => app, path: "spark" });
  const routeFor = (path: string, component: () => ReactElement) =>
    createRoute({ getParentRoute: () => spark, path, validateSearch: sparkSearch, component });
  const pagePath =
    page === "jobs" || page === "stages" ? `${page}/` : page === "storage" ? "storage/" : page === "stage-detail" ? "stages/0/0" : page;
  const pageRoutes = [
    routeFor("executors", () => <ExecutorsPage />),
    routeFor("jobs/", () => <JobsPage />),
    routeFor("stages/", () => <StagesPage />),
    routeFor("environment", () => <EnvironmentPage />),
    routeFor("storage/", () => <StoragePage />),
    routeFor("timeline", () => <TimelinePage />),
    routeFor("jobs/$jobId", () => <div />),
    routeFor("stages/$stageId/$attemptId", () => <StageDetailPage />),
    routeFor("storage/$rddId", () => <div />),
  ];
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([spark.addChildren(pageRoutes)])]),
    history: createMemoryHistory({ initialEntries: [`/apps/${APP_ID}/spark/${pagePath}${search}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  const kind = "static" as const;
  client.setQueryData(sp.executors(APP_ID, kind, null).queryKey, executors);
  client.setQueryData(sp.allExecutors(APP_ID, kind, null).queryKey, allExecutors);
  client.setQueryData(sp.jobs(APP_ID, { status: "SUCCEEDED", kind, attempt: null }).queryKey, jobs);
  client.setQueryData(sp.stages(APP_ID, { status: "COMPLETE", kind, attempt: null }).queryKey, stages);
  client.setQueryData(sp.environment(APP_ID, null).queryKey, environment);
  client.setQueryData(sp.rdds(APP_ID, kind, null).queryKey, rdds);
  client.setQueryData(sp.jobs(APP_ID, { kind, attempt: null }).queryKey, allJobs);
  client.setQueryData(sp.stages(APP_ID, { kind, attempt: null }).queryKey, allStages);
  client.setQueryData(
    sp.stageAttempt(APP_ID, 0, 0, { details: true, withSummaries: true, quantiles: [0.05, 0.25, 0.5, 0.75, 0.95], kind, attempt: null })
      .queryKey,
    stageDetail,
  );
  client.setQueryData(sp.stageAttempts(APP_ID, 0, kind, null).queryKey, stageAttempts);
  client.setQueryData(sp.allTasks(APP_ID, 0, 0, kind, null).queryKey, stageTasks);
  client.setQueryData(
    sp.taskList(APP_ID, 0, 0, { offset: 0, length: 25, sortBy: "-runtime", status: "SUCCESS", kind, attempt: null }).queryKey,
    successfulTasks,
  );
  client.setQueryData(
    sp.taskList(APP_ID, 0, 0, { offset: 25, length: 25, sortBy: "-runtime", status: "SUCCESS", kind, attempt: null }).queryKey,
    [],
  );
  client.setQueryData(sp.dagStage(APP_ID, 0, 0, null).queryKey, { kind: "stage", granularity: "rdd", stages: [], edges: [] });
  client.setQueryData(sp.executors(APP_ID, kind, null).queryKey, executors);
  client.setQueryData(sp.allExecutors(APP_ID, kind, null).queryKey, allExecutors);
  client.setQueryData(q.meta().queryKey, {
    name: "Burrow",
    version: "0.1.0",
    now: 1_791_011_000_000,
    readOnly: true,
    rm: { urls: ["http://rm:8088"], active: "http://rm:8088", haState: "ACTIVE", hadoopVersion: "3.5.9", reachable: true },
    services: {
      sparkHistory: { configured: true, url: "http://history:18080", reachable: true },
      jobHistory: { configured: false, url: null, reachable: null },
      timeline: { configured: false, url: null, reachable: null },
    },
    features: { sparkLive: true, sparkHistory: true, aggregatedLogs: true, nodeLogs: true, events: true, kerberos: false },
    yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
  });
  configure?.(client);
  const view = render(
    <QueryClientProvider client={client}>
      <SparkProvider value={{ appId: APP_ID, kind, sparkAppId: APP_ID, attempt: null, source: null, application: null, resolving: false }}>
        <RouterProvider router={router} />
      </SparkProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

afterEach(() => cleanup());

describe("Spark list pages", () => {
  it("summarizes executors and switches between live and all executor records", async () => {
    const { router } = renderListPage("executors", "?q=driver");
    await screen.findByText("driver");
    expect(screen.getByText("Total cores")).toBeTruthy();
    const includeDead = screen.getByRole("switch", { name: "Include dead executors" });
    fireEvent.click(includeDead);
    await waitFor(() => expect(router.state.location.search.all).toBe("1"));
    fireEvent.click(screen.getByRole("switch", { name: "Include dead executors" }));
    await waitFor(() => expect(router.state.location.search.all).toBeUndefined());
  });

  it("renders optional executor status, memory, removal, blacklist, exclusion, and log details", async () => {
    const rich: SparkExecutor = {
      ...executors[0]!,
      id: "rich",
      hostPort: "worker-1:8041",
      isActive: true,
      isBlacklisted: true,
      blacklistedInStages: [4, 8],
      memoryUsed: 10,
      totalCores: 2,
      totalShuffleRead: 50,
      totalShuffleWrite: 30,
      memoryMetrics: {
        usedOnHeapStorageMemory: 100,
        usedOffHeapStorageMemory: null,
        totalOnHeapStorageMemory: 500,
        totalOffHeapStorageMemory: 250,
      },
      peakMemoryMetrics: { JVMHeapMemory: 42 },
      executorLogs: { stdout: "http://rm-host:8088/proxy/app/containerlogs/stdout" },
      isExcluded: true,
      excludedInStages: [3, 9],
      resources: { gpu: { addresses: ["gpu-0"] } },
      attributes: { rack: "rack-a" },
      removeTime: null,
      removeReason: null,
    };
    const dead: SparkExecutor = {
      ...executors[0]!,
      id: "dead",
      isActive: false,
      isBlacklisted: false,
      blacklistedInStages: [],
      isExcluded: false,
      excludedInStages: [],
      peakMemoryMetrics: { JVMHeapMemory: "not-a-number" },
      memoryMetrics: null,
      executorLogs: {},
      removeTime: "2026-10-03T12:00:00.000GMT",
      removeReason: "Executor exited",
    };
    const unknown: SparkExecutor = {
      ...executors[0]!,
      id: "unknown",
      isActive: null,
      isBlacklisted: null,
      blacklistedInStages: [],
      isExcluded: null,
      excludedInStages: null,
      executorLogs: null,
      removeTime: null,
      removeReason: null,
    };
    renderListPage("executors", "?all=1", (client) => {
      client.setQueryData(sp.allExecutors(APP_ID, "static", null).queryKey, [rich, dead, unknown]);
    });

    const table = await screen.findByRole("table", { name: "Spark executors" });
    expect(table.textContent).toContain("Active");
    expect(table.textContent).toContain("Dead");
    expect(table.textContent).toContain("Unknown");
    expect(table.textContent).toContain("Yes");
    expect(table.querySelector('[data-yf="spark.executor.blacklistedInStages"]')?.getAttribute("data-yv")).toBe("[4,8]");
    expect(table.textContent).toContain("2 stages");
    expect(table.textContent).toContain("Executor exited");
    expect(table.textContent).toContain("42");
    expect(table.querySelector('[data-yf="spark.executor.peakMemoryMetrics.JVMHeapMemory"][data-yv="not-a-number"]')).toBeNull();
    expect(table.querySelector('a[href="http://rm:8088/proxy/app/containerlogs/stdout"]')).not.toBeNull();
    expect(document.querySelector('[data-yf="spark.executor.derived.totalCoresSum"]')?.getAttribute("data-yv")).toBe("8");
  });

  it("uses different empty states for live-only and all-executor lists", async () => {
    const live = renderListPage("executors", "", (client) => {
      client.setQueryData(sp.executors(APP_ID, "static", null).queryKey, []);
    });
    expect(await screen.findByText(/Turn on “Include dead executors”/)).toBeTruthy();
    live.unmount();

    renderListPage("executors", "?all=1", (client) => {
      client.setQueryData(sp.allExecutors(APP_ID, "static", null).queryKey, []);
    });
    expect(await screen.findByText("Spark knows no executor for this application yet.")).toBeTruthy();
  });

  it("keeps stale executor data visible and shows a failure when there is no cached list", async () => {
    const errorState = (client: InstanceType<typeof QueryClient>, keepData: boolean) => {
      const query = client.getQueryCache().find({ queryKey: sp.executors(APP_ID, "static", null).queryKey })!;
      query.setState({
        ...query.state,
        data: keepData ? query.state.data : undefined,
        status: "error",
        error: new Error("executor list unavailable"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    };
    const stale = renderListPage("executors", "", (client) => errorState(client, true));
    expect(await screen.findByText(/Could not refresh the executor list/)).toBeTruthy();
    expect(screen.getByRole("table", { name: "Spark executors" })).toBeTruthy();
    stale.unmount();

    renderListPage("executors", "", (client) => errorState(client, false));
    expect(await screen.findByText("The Spark source is unreachable")).toBeTruthy();
  });

  it("renders successful jobs with their task and stage summaries", async () => {
    renderListPage("jobs", "?status=SUCCEEDED");
    expect(await screen.findByRole("link", { name: "79" })).toBeTruthy();
    expect(screen.getAllByText(/Streaming job from/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Succeeded").length).toBeGreaterThan(0);
  });

  it("renders completed stage attempts in the grouped view", async () => {
    const { router } = renderListPage("stages", "?status=COMPLETE&agg=1");
    expect(await screen.findByRole("switch", { name: "Group attempts of the same stage" })).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ status: "COMPLETE", agg: "1" });
  });

  it("shows Spark runtime properties, filters them, and exposes resource profiles", async () => {
    renderListPage("environment", "?q=burrow");
    expect(await screen.findByText("Spark Properties")).toBeTruthy();
    expect(screen.getByText("burrow-dstream")).toBeTruthy();
    expect(screen.getByText("System Properties")).toBeTruthy();
    expect(screen.getByText("Classpath Entries")).toBeTruthy();
    expect(screen.getByText("Resource Profiles")).toBeTruthy();
    expect(screen.getByText("Profile")).toBeTruthy();
  });

  it("filters cached RDDs and expands their captured partition details", async () => {
    renderListPage("storage");
    expect((await screen.findAllByText("PythonRDD")).length).toBeGreaterThan(0);
    const expand = screen.getByRole("button", { name: "Show partitions and executor distribution of RDD 52" });
    fireEvent.click(expand);
    expect(await screen.findByRole("region", { name: "RDD 52 detail" })).toBeTruthy();
    const filter = screen.getByRole("searchbox", { name: "Filter RDDs by name, id or storage level" });
    fireEvent.change(filter, { target: { value: "absent" } });
    await waitFor(() => expect(document.querySelector('[data-burrow-table-root="spark-storage"]')?.textContent).toContain("0 of 5"));
  });

  it("renders the combined timeline and keeps zoom windows shareable", async () => {
    const { router } = renderListPage("timeline");
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    expect(timeline.textContent).toMatch(/rows/);
    expect(timeline.querySelector("svg")).toBeTruthy();
    expect(router.state.location.pathname).toContain("/timeline");
  });

  it("renders a stage attempt with metrics, task distributions, its DAG panel, and retained tasks", async () => {
    renderListPage("stage-detail");
    expect(await screen.findByRole("heading", { name: /Stage 0 · attempt 0/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "All stages" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "RDD graph of stage 0 attempt 0" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Tasks of stage 0 attempt 0" })).toBeTruthy();
    expect(screen.getByText(/retained task attempts/)).toBeTruthy();
    expect(screen.getByText("Peak memory metrics")).toBeTruthy();
  });

  it("filters and pages a server-sorted task table while keeping controls URL-backed", async () => {
    const { router } = renderListPage("stage-detail", "?size=25&page=2&taskStatus=SUCCESS&sort=duration&dir=desc&level=more");
    expect(await screen.findByRole("region", { name: "Tasks of stage 0 attempt 0" })).toBeTruthy();
    expect(document.body.textContent).toContain("showing");
    expect(document.body.textContent).toContain("task attempts");
    expect(screen.getByRole("switch", { name: "Show additional task metrics" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(router.state.location.search.page).toBeUndefined());
    fireEvent.click(screen.getByRole("switch", { name: "Show additional task metrics" }));
    await waitFor(() => expect(router.state.location.search.level).toBeUndefined());
  });

  it("loads all task attempts before applying the failed-plus-killed filter", async () => {
    const errorTasks: SparkTask[] = [
      { ...stageTasks[0]!, taskId: 9000, status: "FAILED" },
      { ...stageTasks[1]!, taskId: 9001, status: "KILLED" },
      { ...stageTasks[0]!, taskId: 9002, status: "SUCCESS" },
    ];
    renderListPage("stage-detail", "?size=25&taskStatus=errors", (client) => {
      client.setQueryData(sp.allTasks(APP_ID, 0, 0, "static", null).queryKey, errorTasks);
    });

    expect(await screen.findByText("all failed + killed attempts loaded")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Tasks of stage 0 attempt 0" }).textContent).toContain("2 retained task attempts");
    const rawStatuses = [
      ...screen.getByRole("region", { name: "Tasks of stage 0 attempt 0" }).querySelectorAll('[data-yf="spark.task.status"]'),
    ].map((element) => element.getAttribute("data-yv"));
    expect(new Set(rawStatuses)).toEqual(new Set(["FAILED", "KILLED"]));
  });

  it("shows retry context and a stage-level failure reason", async () => {
    const failedStage: SparkStage = { ...stageDetail, status: "FAILED", failureReason: "Executor exited unexpectedly" };
    const retriedAttempts: SparkStage[] = [stageAttempts[0]!, { ...stageAttempts[0]!, attemptId: 1, status: "FAILED" }];
    renderListPage("stage-detail", "", (client) => {
      client.setQueryData(
        sp.stageAttempt(APP_ID, 0, 0, {
          details: true,
          withSummaries: true,
          quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
          kind: "static",
          attempt: null,
        }).queryKey,
        failedStage,
      );
      client.setQueryData(sp.stageAttempts(APP_ID, 0, "static", null).queryKey, retriedAttempts);
    });

    expect(await screen.findByRole("heading", { name: "Stage failed" })).toBeTruthy();
    expect(screen.getByText("Executor exited unexpectedly")).toBeTruthy();
    expect(screen.getByText(/This stage was retried/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Stage attempt" })).toBeTruthy();
  });

  it("uses task-summary fallback distributions when stage detail omits them", async () => {
    const { taskMetricsDistributions: _ignored, ...stageWithoutDistributions } = stageDetail;
    renderListPage("stage-detail", "", (client) => {
      client.setQueryData(
        sp.stageAttempt(APP_ID, 0, 0, {
          details: true,
          withSummaries: true,
          quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
          kind: "static",
          attempt: null,
        }).queryKey,
        stageWithoutDistributions,
      );
      client.setQueryData(sp.taskSummary(APP_ID, 0, 0, [0.05, 0.25, 0.5, 0.75, 0.95], "static", null).queryKey, taskSummary);
    });

    expect(await screen.findByRole("region", { name: "Summary Metrics" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Tasks of stage 0 attempt 0" })).toBeTruthy();
  });

  it("explains an empty task list for a skipped stage", async () => {
    const skippedStage: SparkStage = {
      ...stageDetail,
      numTasks: 0,
      numCompleteTasks: 0,
      numActiveTasks: 0,
      numFailedTasks: 0,
      numKilledTasks: 0,
      rddIds: [],
    };
    renderListPage("stage-detail", "", (client) => {
      client.setQueryData(
        sp.stageAttempt(APP_ID, 0, 0, {
          details: true,
          withSummaries: true,
          quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
          kind: "static",
          attempt: null,
        }).queryKey,
        skippedStage,
      );
      client.setQueryData(sp.allTasks(APP_ID, 0, 0, "static", null).queryKey, []);
    });

    expect(await screen.findByText("Spark has no task records for this attempt")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Tasks of stage 0 attempt 0" }).textContent).toContain("0 retained task attempts");
  });

  it("filters an unpaged single status in the browser", async () => {
    const mixedTasks: SparkTask[] = [stageTasks[0]!, { ...stageTasks[1]!, taskId: 9200, status: "FAILED" }];
    renderListPage("stage-detail", "?taskStatus=SUCCESS", (client) => {
      client.setQueryData(sp.allTasks(APP_ID, 0, 0, "static", null).queryKey, mixedTasks);
    });

    const region = await screen.findByRole("region", { name: "Tasks of stage 0 attempt 0" });
    const statuses = [...region.querySelectorAll('[data-yf="spark.task.status"]')].map((element) => element.getAttribute("data-yv"));
    expect(statuses).toEqual(["SUCCESS"]);
    expect(region.textContent).toContain("1 retained task attempt");
  });

  it("pages client-sorted task results and enables next only for a full page", async () => {
    const page: SparkTask[] = Array.from({ length: 25 }, (_, i) => ({
      ...stageTasks[i % stageTasks.length]!,
      taskId: 10_000 + i,
      index: i,
    }));
    const secondPage: SparkTask[] = [{ ...stageTasks[0]!, taskId: 20_000, index: 25 }];
    const { router } = renderListPage("stage-detail", "?size=25&page=1&taskStatus=SUCCESS&sort=status&dir=desc", (client) => {
      client.setQueryData(
        sp.taskList(APP_ID, 0, 0, { offset: 0, length: 25, status: "SUCCESS", kind: "static", attempt: null }).queryKey,
        page,
      );
      client.setQueryData(
        sp.taskList(APP_ID, 0, 0, { offset: 25, length: 25, status: "SUCCESS", kind: "static", attempt: null }).queryKey,
        secondPage,
      );
    });
    expect(await screen.findByText("server sorts runtime only")).toBeTruthy();
    const next = screen.getByRole("button", { name: "Next" });
    expect(next.hasAttribute("disabled")).toBe(false);
    fireEvent.click(next);
    await waitFor(() => expect(router.state.location.search.page).toBe("2"));
    expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(router.state.location.search.page).toBeUndefined());
  });

  it("shows the no-metrics note when a summary payload contains no distributions", async () => {
    const { taskMetricsDistributions: _ignored, ...stageWithoutDistributions } = stageDetail;
    const summaryOptions = sp.taskSummary(APP_ID, 0, 0, [0.05, 0.25, 0.5, 0.75, 0.95], "static", null);
    renderListPage("stage-detail", "", (client) => {
      client.setQueryData(
        sp.stageAttempt(APP_ID, 0, 0, {
          details: true,
          withSummaries: true,
          quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
          kind: "static",
          attempt: null,
        }).queryKey,
        stageWithoutDistributions,
      );
      client.setQueryData(summaryOptions.queryKey, {} as SparkTaskSummary);
    });
    expect(await screen.findByText("No task summary metrics have been reported for this stage attempt.")).toBeTruthy();
  });
});
