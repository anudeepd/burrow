import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type {
  SparkEnvironment,
  SparkExecutor,
  SparkJob,
  SparkRdd,
  SparkSqlExecution,
  SparkStage,
  SparkTask,
  SparkTaskSummary,
} from "../data/schemas";

window.__BURROW_PARITY__ = true;

vi.mock("~/features/dag/react/DagViewLazy", () => ({
  DagViewLazy: ({ ariaLabel, onSelectRdd }: { ariaLabel: string; onSelectRdd?: (rddId: number) => void }) => (
    <div role="img" aria-label={ariaLabel}>
      {onSelectRdd && (
        <button type="button" onClick={() => onSelectRdd(52)}>
          Select stage RDD
        </button>
      )}
    </div>
  ),
}));

const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { ExecutorsPage } = await import("./ExecutorsPage");
const { JobsPage } = await import("./JobsPage");
const { StagesPage } = await import("./StagesPage");
const { EnvironmentPage } = await import("./EnvironmentPage");
const { StoragePage } = await import("./StoragePage");
const { TimelinePage } = await import("./TimelinePage");
const { StageDetailPage } = await import("./StageDetailPage");
const { RddDetailPage } = await import("./RddDetailPage");
const { SqlDetailPage } = await import("./SqlDetailPage");
const { firstLine } = await import("../ui/StageTable");
const { SparkProvider } = await import("../ui/context");
const { sp } = await import("../data/queries");
const { sparkSearch } = await import("../data/search");
const { q } = await import("~/api/queries");
const { parityStore } = await import("~/state/parity");
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
const originalAnchorClick = HTMLAnchorElement.prototype.click;

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
const rdd52 = readJson("final.storage.rdd-52.json") as SparkRdd;
const stageDetail = readJson("final.stage-0-0.withSummaries.json") as SparkStage;
const stageAttempts = readJson("final.stage-0.json") as SparkStage[];
const stageTasks = readJson("final.stage-0-0.taskList.json") as SparkTask[];
const successfulTasks = readJson("final.stage-0-0.taskList.status-success.json") as SparkTask[];
const taskSummary = readJson("final.stage-0-0.taskSummary.json") as SparkTaskSummary;

function renderListPage(
  page: "executors" | "jobs" | "stages" | "environment" | "storage" | "timeline" | "stage-detail" | "sql-detail",
  search = "",
  configure?: (client: InstanceType<typeof QueryClient>) => void,
) {
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, path: "/apps/$appId" });
  const spark = createRoute({ getParentRoute: () => app, path: "spark" });
  const routeFor = (path: string, component: () => ReactElement) =>
    createRoute({ getParentRoute: () => spark, path, validateSearch: sparkSearch, component });
  const pagePath =
    page === "jobs" || page === "stages"
      ? `${page}/`
      : page === "storage"
        ? "storage/"
        : page === "stage-detail"
          ? "stages/0/0"
          : page === "sql-detail"
            ? "sql/0"
            : page;
  const pageRoutes = [
    routeFor("executors", () => <ExecutorsPage />),
    routeFor("jobs/", () => <JobsPage />),
    routeFor("stages/", () => <StagesPage />),
    routeFor("environment", () => <EnvironmentPage />),
    routeFor("storage/", () => <StoragePage />),
    routeFor("timeline", () => <TimelinePage />),
    routeFor("jobs/$jobId", () => <div />),
    routeFor("stages/$stageId/$attemptId", () => <StageDetailPage />),
    routeFor("storage/$rddId", () => <RddDetailPage />),
    routeFor("sql/$executionId", () => <SqlDetailPage />),
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
  client.setQueryData(sp.rdd(APP_ID, 52, kind, null).queryKey, { rdd: rdd52 });
  client.setQueryData(sp.jobs(APP_ID, { kind, attempt: null }).queryKey, allJobs);
  const sqlDetail = {
    id: 0,
    status: "COMPLETED",
    description: "Fixture SQL execution",
    successJobIds: [0],
    nodes: [],
    edges: [],
  } as SparkSqlExecution;
  client.setQueryData(sp.sqlExecution(APP_ID, 0, { kind, attempt: null }).queryKey, sqlDetail);
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

function markQueryError(client: InstanceType<typeof QueryClient>, queryKey: readonly unknown[], error: Error, keepData: boolean) {
  const query = client.getQueryCache().find({ queryKey });
  if (!query) throw new Error("Expected query to be present in the cache");
  query.setState({
    ...query.state,
    data: keepData ? query.state.data : undefined,
    status: "error",
    error,
    errorUpdatedAt: Date.now(),
    errorUpdateCount: query.state.errorUpdateCount + 1,
    fetchStatus: "idle",
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  parityStore.setState(() => ({ enabled: true }));
  if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
  HTMLAnchorElement.prototype.click = originalAnchorClick;
});

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

  it("shows optional executor columns, updates its sort and filter, and exports the current records", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:executor-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const full: SparkExecutor = {
      ...executors[0]!,
      id: "complete",
      isActive: true,
      isBlacklisted: true,
      blacklistedInStages: [3],
      isExcluded: true,
      excludedInStages: [5],
      totalCores: 8,
      maxTasks: 16,
      addTime: "2026-10-03T12:00:00.000GMT",
      peakMemoryMetrics: { JVMHeapMemory: 1024 },
      memoryMetrics: {
        usedOnHeapStorageMemory: 20,
        usedOffHeapStorageMemory: 10,
        totalOnHeapStorageMemory: 200,
        totalOffHeapStorageMemory: 100,
      },
      executorLogs: { stdout: "http://rm:8088/containerlogs/stdout" },
      resources: { gpu: { addresses: ["gpu-0"] } },
      attributes: { rack: "rack-a" },
      removeTime: "2026-10-03T13:00:00.000GMT",
      removeReason: "Executor removed",
    };
    const { router } = renderListPage("executors", "?all=1", (client) => {
      client.setQueryData(sp.allExecutors(APP_ID, "static", null).queryKey, [
        full,
        { ...full, id: "complete-2", peakMemoryMetrics: { JVMHeapMemory: 2048 }, addTime: "2026-10-04T12:00:00.000GMT" },
      ]);
    });
    const table = await screen.findByRole("table", { name: "Spark executors" });

    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    await waitFor(() => expect(router.state.location.search.cols).toBeTruthy());
    for (const field of [
      "spark.executor.totalCores",
      "spark.executor.maxTasks",
      "spark.executor.addTime",
      "spark.executor.isExcluded",
      "spark.executor.resourceProfileId",
      "spark.executor.peakMemoryMetrics",
      "spark.executor.resources",
      "spark.executor.attributes",
      "spark.executor.removeTime",
      "spark.executor.removeReason",
    ]) {
      expect(table.querySelector(`[data-yf="${field}"]`), field).not.toBeNull();
    }

    fireEvent.click(table.querySelector('[data-col="peakJvmHeap"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("peakJvmHeap"));
    fireEvent.click(table.querySelector('[data-col="addTime"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("addTime"));

    fireEvent.click(table.querySelector('[data-col="status"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("status"));

    fireEvent.change(screen.getByPlaceholderText("Filter id / host…"), { target: { value: "complete" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("complete"));

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getAllByRole("menuitem", { name: /CSV/ }).at(-1)!);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(clickAnchor).toHaveBeenCalledTimes(2);
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "retry failed" } }), { status: 500 })),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    stale.unmount();

    renderListPage("executors", "", (client) => errorState(client, false));
    expect(await screen.findByRole("heading", { name: "Spark request failed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("renders successful jobs with their task and stage summaries", async () => {
    renderListPage("jobs", "?status=SUCCEEDED");
    expect(await screen.findByRole("link", { name: "79" })).toBeTruthy();
    expect(screen.getAllByText(/Streaming job from/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Succeeded").length).toBeGreaterThan(0);
  });

  it("opens a job row and retries stale and fatal job-list errors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "retry failed" } }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const queryKey = sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey;
    const jobsView = renderListPage("jobs", "", (client) => client.setQueryDefaults(queryKey, { enabled: false }));
    const table = await screen.findByRole("table", { name: "Spark jobs" });
    fireEvent.click(within(table).getAllByRole("row")[1]!);
    await waitFor(() => expect(jobsView.router.state.location.pathname).toContain("/spark/jobs/"));
    jobsView.unmount();

    const stale = renderListPage("jobs", "", (client) => {
      client.setQueryDefaults(queryKey, { enabled: false });
      markQueryError(client, queryKey, new Error("jobs refresh failed"), true);
    });
    expect(await screen.findByText(/Could not refresh the job list/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    stale.unmount();

    renderListPage("jobs", "", (client) => {
      client.setQueryDefaults(queryKey, { enabled: false });
      markQueryError(client, queryKey, new Error("jobs unavailable"), false);
    });
    expect(await screen.findByRole("heading", { name: "Spark request failed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
  });

  it("sorts, filters, and exports the Spark jobs table", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:spark-jobs-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const failedJobs = allJobs.slice(0, 1).map((job) => ({ ...job, status: "FAILED" }));
    const { container, router } = renderListPage("jobs", "?status=SUCCEEDED", (client) => {
      client.setQueryData(sp.jobs(APP_ID, { status: "FAILED", kind: "static", attempt: null }).queryKey, failedJobs);
    });
    const table = await screen.findByRole("table", { name: "Spark jobs" });
    fireEvent.click(table.querySelector('[data-col="jobId"] button')!);
    fireEvent.click(table.querySelector('[data-col="duration"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("duration"));

    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clickAnchor).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("combobox", { name: "Job status filter" }));
    const failed = await screen.findByRole("option", { name: "Failed" });
    fireEvent.pointerDown(failed, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(failed, { button: 0, pointerType: "mouse" });
    fireEvent.click(failed);
    await waitFor(() => expect(router.state.location.search.status).toBe("FAILED"));
    const search = screen.getByRole("searchbox", { name: "Filter jobs by name or id" });
    fireEvent.change(search, { target: { value: "no-such-job" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("no-such-job"));
    await waitFor(() => expect(container.querySelector('[data-burrow-table="spark-jobs"]')?.getAttribute("data-burrow-rows")).toBe("0"));
  });

  it("renders completed stage attempts in the grouped view", async () => {
    const repeated = { ...stages[0]!, attemptId: 1 };
    const { router } = renderListPage("stages", "?status=COMPLETE&agg=1", (client) => {
      client.setQueryData(sp.stages(APP_ID, { status: "COMPLETE", kind: "static", attempt: null }).queryKey, [...stages, repeated]);
    });
    expect(await screen.findByRole("switch", { name: "Group attempts of the same stage" })).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ status: "COMPLETE", agg: "1" });

    const createObjectURL = vi.fn(() => "blob:stage-export");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    expect(createObjectURL).toHaveBeenCalledOnce();

    const attemptSelector = await screen.findByRole("combobox", { name: `Attempts of stage ${repeated.stageId}` });
    fireEvent.click(attemptSelector);
    const option = await screen.findByRole("option", { name: `Attempt ${stages[0]!.attemptId ?? 0} · ${stages[0]!.status}` });
    fireEvent.pointerDown(option, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => expect(router.state.location.pathname).toContain(`/stages/${repeated.stageId}/${stages[0]!.attemptId ?? 0}`));
  });

  it("filters, groups, sorts, and opens stage rows", async () => {
    const repeated = { ...stages[0]!, attemptId: (stages[0]!.attemptId ?? 0) + 1 };
    const { router } = renderListPage("stages", "?agg=1", (client) => {
      client.setQueryData(sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, [...stages, repeated]);
      client.setQueryData(sp.stages(APP_ID, { status: "COMPLETE", kind: "static", attempt: null }).queryKey, [...stages, repeated]);
    });
    await screen.findByRole("table", { name: "Spark stages" });

    const statusFilter = screen.getByRole("combobox", { name: "Stage status filter" });
    fireEvent.click(statusFilter);
    const complete = await screen.findByRole("option", { name: "Complete" });
    fireEvent.pointerDown(complete, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(complete, { button: 0, pointerType: "mouse" });
    fireEvent.click(complete);
    await waitFor(() => expect(router.state.location.search.status).toBe("COMPLETE"));

    const search = screen.getByRole("searchbox", { name: "Filter stages by id, name or description" });
    fireEvent.change(search, { target: { value: "does-not-exist" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("does-not-exist"));
    fireEvent.change(search, { target: { value: "" } });

    const grouping = screen.getByRole("switch", { name: "Group attempts of the same stage" });
    fireEvent.click(grouping);
    await waitFor(() => expect(router.state.location.search.agg).toBeUndefined());
    fireEvent.click(grouping);
    await waitFor(() => expect(router.state.location.search.agg).toBe("1"));

    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    const table = screen.getByRole("table", { name: "Spark stages" });
    fireEvent.click(table.querySelector('[data-col="duration"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("duration"));
    fireEvent.click(table.querySelector('[data-col="attemptCount"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("attemptCount"));
  });

  it("renders and shortens multi-line stage failure reasons", async () => {
    const reason = `\n  ${"x".repeat(200)}\n at Executor.run`;
    renderListPage("stages", "", (client) => {
      client.setQueryData(sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, [
        { ...stages[0]!, stageId: 90, failureReason: reason },
        { ...stages[1]!, stageId: 91, failureReason: "single line failure" },
      ]);
    });
    const table = await screen.findByRole("table", { name: "Spark stages" });
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    expect(table.querySelector('[data-yf="spark.stage.failureReason"]')?.textContent).toContain(`${`  ${"x".repeat(200)}`.slice(0, 157)}…`);
    expect(firstLine("\n  first line\nsecond line")).toBe("  first line");
    expect(firstLine("\n\n")).toBe("\n\n");
  });

  it("activates a stage row and retries stale or fatal stage-list errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const navigable = renderListPage("stages");
    const table = await screen.findByRole("table", { name: "Spark stages" });
    fireEvent.click(table.querySelectorAll('[role="row"]')[1]!);
    await waitFor(() => expect(navigable.router.state.location.pathname).toMatch(/\/stages\/\d+\/\d+$/));
    navigable.unmount();
    cleanup();

    const stale = renderListPage("stages");
    await screen.findByRole("table", { name: "Spark stages" });
    markQueryError(stale.client, sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, new Error("stage refresh failed"), true);
    expect(await screen.findByText(/Could not refresh the stage list/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    stale.unmount();
    cleanup();

    const fatal = renderListPage("stages");
    await screen.findByRole("table", { name: "Spark stages" });
    markQueryError(fatal.client, sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, new Error("stage list unavailable"), false);
    expect((await screen.findAllByText("stage list unavailable")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
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

  it("filters and sorts environment tables, expands panes, and shows custom resources", async () => {
    parityStore.setState(() => ({ enabled: false }));
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:environment-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const richEnvironment: SparkEnvironment = {
      ...environment,
      resourceProfiles: [
        {
          id: 7,
          executorResources: {
            cores: { resourceName: "cores", amount: 2 },
            memory: { resourceName: "memory", amount: 4096 },
            gpu: { resourceName: "gpu", amount: 2, vendor: "NVIDIA", discoveryScript: "/opt/find-gpu" },
          },
          taskResources: { cpus: { resourceName: "cpus", amount: 1 }, gpu: { resourceName: "gpu", amount: 1 } },
        },
      ],
    } as SparkEnvironment;
    const { router } = renderListPage("environment", "", (queryClient) => {
      queryClient.setQueryData(sp.environment(APP_ID, null).queryKey, richEnvironment);
    });
    await screen.findByText("Spark Properties");
    const sparkProperties = screen.getByRole("searchbox", { name: "Filter Spark Properties" });
    fireEvent.change(sparkProperties, { target: { value: "burrow" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("burrow"));

    const systemPane = screen.getByRole("button", { name: "System Properties" });
    fireEvent.click(systemPane);
    expect(systemPane.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(systemPane);
    expect(systemPane.getAttribute("aria-expanded")).toBe("true");

    const propertyTable = screen.getByRole("table", { name: "Spark Properties" });
    fireEvent.click(within(propertyTable).getByRole("button", { name: "Value" }));
    fireEvent.click(within(propertyTable.closest("[data-burrow-table-root]")!).getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
    expect(createUrl).toHaveBeenCalledOnce();
    expect(clickAnchor).toHaveBeenCalledOnce();

    const classpath = screen.getByRole("table", { name: "Classpath entries" });
    fireEvent.click(within(classpath).getByRole("button", { name: "Kind" }));
    fireEvent.click(within(classpath).getByRole("button", { name: "Classpath entry" }));
    fireEvent.click(within(classpath.closest("[data-burrow-table-root]")!).getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getAllByRole("menuitem", { name: /CSV/ }).at(-1)!);
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(clickAnchor).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Executor gpu:")).toBeTruthy();
    expect(screen.getByText("NVIDIA")).toBeTruthy();
    expect(screen.getByText("/opt/find-gpu")).toBeTruthy();
    expect(screen.getByText("Task gpu:")).toBeTruthy();
  });

  it("renders an empty environment, and handles fatal and stale environment errors", async () => {
    const empty = renderListPage("environment", "", (client) => {
      client.setQueryData(sp.environment(APP_ID, null).queryKey, {
        runtime: {},
        sparkProperties: [],
        hadoopProperties: [],
        systemProperties: [],
        metricsProperties: [],
        classpathEntries: [],
        resourceProfiles: [],
      } as unknown as SparkEnvironment);
    });
    expect(await screen.findByText("No resource profiles reported.")).toBeTruthy();
    expect(screen.getByText("Spark returned no classpath entries.")).toBeTruthy();
    empty.unmount();

    const fatal = renderListPage("environment", "", (client) => {
      client.setQueryDefaults(sp.environment(APP_ID, null).queryKey, { enabled: false });
    });
    const fatalQuery = fatal.client.getQueryCache().find({ queryKey: sp.environment(APP_ID, null).queryKey })!;
    fatalQuery.setState({
      ...fatalQuery.state,
      data: undefined,
      status: "error",
      error: new Error("environment unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: fatalQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Spark request failed" })).toBeTruthy();
    fatal.unmount();

    const stale = renderListPage("environment", "", (client) => {
      client.setQueryDefaults(sp.environment(APP_ID, null).queryKey, { enabled: false });
    });
    const staleQuery = stale.client.getQueryCache().find({ queryKey: sp.environment(APP_ID, null).queryKey })!;
    staleQuery.setState({
      ...staleQuery.state,
      status: "error",
      error: new Error("environment refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: staleQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Could not refresh the Spark environment" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
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

  it("sorts, exports, and opens cached RDDs while handling empty and unavailable lists", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:storage-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { router, unmount } = renderListPage("storage");
    const table = await screen.findByRole("table", { name: "Cached RDDs" });
    for (const header of table.querySelectorAll('[role="columnheader"] button')) fireEvent.click(header);
    await waitFor(() => expect(router.state.location.search.sort).toBeTruthy());
    fireEvent.click(within(table.closest("[data-burrow-table-root]")!).getByRole("button", { name: "Choose columns" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    fireEvent.click(table.querySelector('[data-col="fraction"] button')!);
    fireEvent.click(within(table.closest("[data-burrow-table-root]")!).getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
    expect(createUrl).toHaveBeenCalledOnce();
    expect(clickAnchor).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Show partitions and executor distribution of RDD 52" }));
    expect(await screen.findByRole("region", { name: "RDD 52 detail" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse RDD 52" }));
    const row = within(table).getAllByRole("row", { name: /PythonRDD/ })[0]!;
    fireEvent.click(row);
    await waitFor(() => expect(router.state.location.pathname).toContain("/storage/"));
    expect(router.state.location.pathname).not.toBe(`/apps/${APP_ID}/spark/storage/`);
    expect(await screen.findByRole("heading", { name: "RDD 52" })).toBeTruthy();
    unmount();

    const empty = renderListPage("storage", "", (client) => {
      client.setQueryData(sp.rdds(APP_ID, "static", null).queryKey, []);
    });
    expect(await screen.findByRole("heading", { name: "No RDD is cached in this application" })).toBeTruthy();
    empty.unmount();

    const missing = renderListPage("storage", "?rdd=999");
    expect(await screen.findByText(/RDD 999 is not in this list/)).toBeTruthy();
    missing.unmount();

    const stale = renderListPage("storage");
    const staleQuery = stale.client.getQueryCache().find({ queryKey: sp.rdds(APP_ID, "static", null).queryKey })!;
    staleQuery.setState({
      ...staleQuery.state,
      status: "error",
      error: new Error("cached RDD refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: staleQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Could not refresh the cached RDD list" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    stale.unmount();

    const fatal = renderListPage("storage", "", (client) => {
      client.setQueryDefaults(sp.rdds(APP_ID, "static", null).queryKey, { enabled: false });
    });
    const query = fatal.client.getQueryCache().find({ queryKey: sp.rdds(APP_ID, "static", null).queryKey })!;
    query.setState({
      ...query.state,
      data: undefined,
      status: "error",
      error: new Error("cached RDD list unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Spark request failed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("keeps stale RDD details and explains an RDD missing from storage", async () => {
    const stale = renderListPage("storage");
    await screen.findByRole("table", { name: "Cached RDDs" });
    await act(async () => {
      await stale.router.navigate({
        to: "/apps/$appId/spark/storage/$rddId",
        params: { appId: APP_ID, rddId: "52" },
      });
    });
    expect(await screen.findByRole("heading", { name: "RDD 52" })).toBeTruthy();
    const staleQuery = stale.client.getQueryCache().find({ queryKey: sp.rdd(APP_ID, 52, "static", null).queryKey })!;
    staleQuery.setState({
      ...staleQuery.state,
      status: "error",
      error: new Error("RDD refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: staleQuery.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
    expect(await screen.findByText(/Could not refresh RDD 52/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    stale.unmount();

    const missing = renderListPage("storage", "", (client) => {
      client.setQueryData(sp.rdd(APP_ID, 999, "static", null).queryKey, { rdd: undefined });
    });
    await screen.findByRole("table", { name: "Cached RDDs" });
    await act(async () => {
      await missing.router.navigate({
        to: "/apps/$appId/spark/storage/$rddId",
        params: { appId: APP_ID, rddId: "999" },
      });
    });
    expect(await screen.findByRole("heading", { name: "RDD 999 is not cached in this application" })).toBeTruthy();
  });

  it("renders the combined timeline and keeps zoom windows shareable", async () => {
    const { router } = renderListPage("timeline", "?zoom=2");
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    expect(timeline.textContent).toMatch(/rows/);
    expect(timeline.querySelector("svg")).toBeTruthy();
    expect(router.state.location.pathname).toContain("/timeline");

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(router.state.location.search.zoom).toBe("4.00"));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await waitFor(() => expect(router.state.location.search.zoom).toBe("2.00"));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(router.state.location.search.zoom).toBe("2.00"));

    const figure = timeline.querySelector(".select-none") as HTMLDivElement;
    const list = timeline.querySelector(".burrow-scroll > .relative") as HTMLDivElement;
    Object.defineProperty(list, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1_000, bottom: 400, width: 1_000, height: 400, toJSON: () => ({}) }),
    });
    const pan = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    Object.defineProperty(pan, "shiftKey", { value: true });
    figure.dispatchEvent(pan);
    await waitFor(() => expect(router.state.location.search.from).toBeDefined());

    Object.defineProperty(figure, "setPointerCapture", { configurable: true, value: () => {} });
    fireEvent.pointerDown(figure, { pointerId: 5, clientX: 700 });
    fireEvent.pointerMove(figure, { pointerId: 5, clientX: 300 });
    fireEvent.pointerUp(figure, { pointerId: 5 });
    await waitFor(() => expect(router.state.location.search.to).toBeDefined());
  });

  it("shows an empty timeline when every source returns no bars", async () => {
    renderListPage("timeline", "", (client) => {
      client.setQueryData(sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, []);
      client.setQueryData(sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, []);
      client.setQueryData(sp.executors(APP_ID, "static", null).queryKey, []);
      client.setQueryData(sp.allExecutors(APP_ID, "static", null).queryKey, []);
    });

    expect(await screen.findByRole("region", { name: "Timeline" })).toBeTruthy();
    expect(screen.getByText("Nothing to plot yet")).toBeTruthy();
    expect(screen.getByText("No time range")).toBeTruthy();
  });

  it("reports stale, single-source, and multiple-source timeline failures", async () => {
    const fail = (client: InstanceType<typeof QueryClient>, key: readonly unknown[], keepData: boolean) => {
      const query = client.getQueryCache().find({ queryKey: key })!;
      query.setState({
        ...query.state,
        data: keepData ? query.state.data : undefined,
        status: "error",
        error: new Error("timeline source failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    };
    const empty = (client: InstanceType<typeof QueryClient>) => {
      client.setQueryData(sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, []);
      client.setQueryData(sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, []);
      client.setQueryData(sp.executors(APP_ID, "static", null).queryKey, []);
      client.setQueryData(sp.allExecutors(APP_ID, "static", null).queryKey, []);
    };

    const stale = renderListPage("timeline");
    fail(stale.client, sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, true);
    expect(await screen.findByText(/1 of four timeline sources failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry failed sources" }));
    stale.unmount();

    const single = renderListPage("timeline");
    empty(single.client);
    fail(single.client, sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, false);
    expect(await screen.findByText("The Spark source is unreachable")).toBeTruthy();
    single.unmount();

    const multiple = renderListPage("timeline");
    empty(multiple.client);
    fail(multiple.client, sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, false);
    fail(multiple.client, sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, false);
    expect(await screen.findByText("2 Spark timeline sources could not be loaded")).toBeTruthy();
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

  it("keeps SQL detail visible and retries a stale jobs lookup", async () => {
    const view = renderListPage("sql-detail");
    expect(await screen.findByRole("heading", { name: /SQL execution 0/ })).toBeTruthy();
    const queryKey = sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey;
    markQueryError(view.client, queryKey, new Error("SQL jobs refresh failed"), true);
    expect(await screen.findByText(/Could not refresh the jobs for this SQL execution/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("keeps stale stage data visible and retries each stale panel", async () => {
    const { taskMetricsDistributions: _ignored, ...stageWithoutDistributions } = stageDetail;
    renderListPage("stage-detail", "", (client) => {
      const opts = {
        details: true,
        withSummaries: true,
        quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
        kind: "static" as const,
        attempt: null,
      };
      client.setQueryData(sp.stageAttempt(APP_ID, 0, 0, opts).queryKey, stageWithoutDistributions);
      client.setQueryData(sp.taskSummary(APP_ID, 0, 0, opts.quantiles, "static", null).queryKey, taskSummary);
      markQueryError(client, sp.stageAttempt(APP_ID, 0, 0, opts).queryKey, new Error("stage refresh failed"), true);
      markQueryError(client, sp.stageAttempts(APP_ID, 0, "static", null).queryKey, new Error("attempt refresh failed"), true);
      markQueryError(
        client,
        sp.taskSummary(APP_ID, 0, 0, opts.quantiles, "static", null).queryKey,
        new Error("summary refresh failed"),
        true,
      );
      markQueryError(client, sp.allTasks(APP_ID, 0, 0, "static", null).queryKey, new Error("task refresh failed"), true);
    });

    expect(await screen.findByRole("heading", { name: /Stage 0 · attempt 0/ })).toBeTruthy();
    expect(screen.getByText("stage refresh failed")).toBeTruthy();
    expect(screen.getByText("attempt refresh failed")).toBeTruthy();
    expect(screen.getByText("summary refresh failed")).toBeTruthy();
    expect(screen.getByText("task refresh failed")).toBeTruthy();
    for (const button of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(button);
  });

  it("shows retryable stage and summary failures when no cached response exists", async () => {
    const stageOptions = sp.stageAttempt(APP_ID, 0, 0, {
      details: true,
      withSummaries: true,
      quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
      kind: "static",
      attempt: null,
    });
    const failedStage = renderListPage("stage-detail", "", (client) => {
      markQueryError(client, stageOptions.queryKey, new Error("stage endpoint failed"), false);
    });
    expect((await screen.findAllByText(/Cannot reach Burrow at \/api\/spark\/.*\/stages\/0\/0/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    failedStage.unmount();

    const { taskMetricsDistributions: _ignored, ...stageWithoutDistributions } = stageDetail;
    const quantiles = [0.05, 0.25, 0.5, 0.75, 0.95] as const;
    renderListPage("stage-detail", "", (client) => {
      client.setQueryData(stageOptions.queryKey, stageWithoutDistributions);
      const summaryKey = sp.taskSummary(APP_ID, 0, 0, [...quantiles], "static", null).queryKey;
      client.setQueryData(summaryKey, taskSummary);
      markQueryError(client, summaryKey, new Error("summary endpoint failed"), false);
    });
    expect((await screen.findAllByText(/Cannot reach Burrow at \/api\/spark\/.*taskSummary/)).length).toBeGreaterThan(0);
    for (const button of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(button);
  });

  it("retries unavailable stage-attempt and task lists", async () => {
    const attemptsQuery = sp.stageAttempts(APP_ID, 0, "static", null);
    const tasksQuery = sp.taskList(APP_ID, 0, 0, {
      offset: 0,
      length: 25,
      status: "SUCCESS",
      kind: "static",
      attempt: null,
    });
    const view = renderListPage("stage-detail", "?size=25&taskStatus=SUCCESS", (client) => {
      client.setQueryData(tasksQuery.queryKey, successfulTasks);
    });
    await screen.findByRole("heading", { name: /Stage 0 · attempt 0/ });
    act(() => {
      markQueryError(view.client, attemptsQuery.queryKey, new Error("attempt list failed"), false);
      markQueryError(view.client, tasksQuery.queryKey, new Error("task list failed"), false);
    });

    expect(await screen.findByText("attempt list failed")).toBeTruthy();
    expect((await screen.findAllByText("task list failed")).length).toBeGreaterThan(0);
    for (const button of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(button);
  });

  it("updates task filters, page size, sorting, columns, and follows a selected RDD", async () => {
    const { router } = renderListPage("stage-detail", "", (client) => {
      client.setQueryData(sp.dagStage(APP_ID, 0, 0, null).queryKey, {
        kind: "stage",
        granularity: "rdd",
        stages: [
          {
            stageId: 0,
            attempt: 0,
            skipped: false,
            label: "Stage 0",
            clusters: [],
            nodes: [{ id: 52, name: "Scan", clusterId: null }],
            edges: [],
          },
        ],
        edges: [],
      } as never);
    });
    await screen.findByRole("region", { name: "Tasks of stage 0 attempt 0" });

    const status = screen.getByRole("combobox", { name: "Task status filter" });
    fireEvent.click(status);
    const failedOption = await screen.findByRole("option", { name: "Failed" });
    fireEvent.pointerDown(failedOption, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(failedOption, { button: 0, pointerType: "mouse" });
    fireEvent.click(failedOption);
    await waitFor(() => expect(router.state.location.search.taskStatus).toBe("FAILED"));

    const pageSize = screen.getByRole("combobox", { name: "Tasks per page" });
    fireEvent.click(pageSize);
    const pageOption = await screen.findByRole("option", { name: "25 per page" });
    fireEvent.pointerDown(pageOption, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(pageOption, { button: 0, pointerType: "mouse" });
    fireEvent.click(pageOption);
    await waitFor(() => expect(router.state.location.search.size).toBe("25"));

    const taskTable = screen.getByRole("table", { name: "Tasks of stage 0 attempt 0" });
    fireEvent.click(taskTable.querySelector('[data-col="duration"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("duration"));
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));

    fireEvent.click(screen.getByRole("button", { name: "Select stage RDD" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/apps/${APP_ID}/spark/storage/52`));
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
      { ...stageTasks[0]!, taskId: 9000, status: "FAILED", errorMessage: "Executor lost\ncontainer exited" },
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
    const { router } = renderListPage("stage-detail", "", (client) => {
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
      client.setQueryData(
        sp.stageAttempt(APP_ID, 0, 1, {
          details: true,
          withSummaries: true,
          quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
          kind: "static",
          attempt: null,
        }).queryKey,
        { ...failedStage, attemptId: 1 },
      );
      client.setQueryData(sp.stageAttempts(APP_ID, 0, "static", null).queryKey, retriedAttempts);
    });

    expect(await screen.findByRole("heading", { name: "Stage failed" })).toBeTruthy();
    expect(screen.getByText("Executor exited unexpectedly")).toBeTruthy();
    expect(screen.getByText(/This stage was retried/)).toBeTruthy();
    const attemptSelect = screen.getByRole("combobox", { name: "Stage attempt" });
    fireEvent.click(attemptSelect);
    const retryOption = await screen.findByRole("option", { name: "Attempt 1 · FAILED" });
    fireEvent.pointerDown(retryOption, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(retryOption, { button: 0, pointerType: "mouse" });
    fireEvent.click(retryOption);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/apps/${APP_ID}/spark/stages/0/1`));
  });

  it("explains a missing stage and reports a stage query failure", async () => {
    const stageOptions = sp.stageAttempt(APP_ID, 0, 0, {
      details: true,
      withSummaries: true,
      quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
      kind: "static",
      attempt: null,
    });
    renderListPage("stage-detail", "", (client) => client.setQueryData(stageOptions.queryKey, null as never));
    expect(await screen.findByText(/Stage 0 attempt 0 is not in this application/)).toBeTruthy();
    cleanup();

    const failed = renderListPage("stage-detail", "", (client) => {
      const query = client.getQueryCache().find({ queryKey: stageOptions.queryKey })!;
      query.setState({
        ...query.state,
        data: undefined,
        status: "error",
        error: new Error("stage endpoint failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect((await screen.findAllByText(/Cannot reach Burrow at \/api\/spark\/.*\/stages\/0\/0/)).length).toBeGreaterThan(0);
    failed.unmount();
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
