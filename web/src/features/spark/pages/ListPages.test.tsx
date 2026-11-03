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
const { nowStore } = await import("../ui/use-now");
const initialNow = nowStore.get().now;
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
  kind: "static" | "live" = "static",
  attempt: string | null = null,
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
  client.setQueryData(sp.executors(APP_ID, kind, null).queryKey, executors);
  client.setQueryData(sp.allExecutors(APP_ID, kind, null).queryKey, allExecutors);
  client.setQueryData(sp.jobs(APP_ID, { status: "SUCCEEDED", kind, attempt: null }).queryKey, jobs);
  client.setQueryData(sp.stages(APP_ID, { status: "COMPLETE", kind, attempt: null }).queryKey, stages);
  client.setQueryData(sp.environment(APP_ID, null).queryKey, environment);
  client.setQueryData(sp.rdds(APP_ID, kind, null).queryKey, rdds);
  client.setQueryData(sp.rdd(APP_ID, 52, kind, null).queryKey, { rdd: rdd52 });
  client.setQueryData(sp.jobs(APP_ID, { kind, attempt }).queryKey, allJobs);
  const sqlDetail = {
    id: 0,
    status: "COMPLETED",
    description: "Fixture SQL execution",
    successJobIds: [0],
    nodes: [],
    edges: [],
  } as SparkSqlExecution;
  client.setQueryData(sp.sqlExecution(APP_ID, 0, { kind, attempt }).queryKey, sqlDetail);
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
      <SparkProvider value={{ appId: APP_ID, kind, sparkAppId: APP_ID, attempt, source: null, application: null, resolving: false }}>
        <RouterProvider router={router} />
      </SparkProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

function markQueryError(client: InstanceType<typeof QueryClient>, queryKey: readonly unknown[], error: Error | string, keepData: boolean) {
  const query = client.getQueryCache().find({ queryKey, exact: true });
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
  nowStore.setState(() => ({ now: initialNow }));
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
      activeTasks: 2,
      isExcluded: true,
      excludedInStages: [5],
      totalCores: 8,
      maxTasks: 16,
      memoryUsed: 1024,
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
    const sparse: SparkExecutor = {
      ...full,
      id: "sparse",
      hostPort: "sparse-host",
      activeTasks: null,
      totalCores: null,
      memoryUsed: null,
      totalShuffleRead: null,
      totalShuffleWrite: null,
      memoryMetrics: null,
      peakMemoryMetrics: null,
      isBlacklisted: null,
      blacklistedInStages: null as unknown as number[],
      resources: null,
      attributes: null,
    };
    const offHeapOnly: SparkExecutor = {
      ...full,
      id: "off-heap-only",
      memoryMetrics: {
        usedOnHeapStorageMemory: null,
        usedOffHeapStorageMemory: 64,
        totalOnHeapStorageMemory: null,
        totalOffHeapStorageMemory: 128,
      },
    };
    const { router } = renderListPage("executors", "?all=1", (client) => {
      client.setQueryData(sp.allExecutors(APP_ID, "static", null).queryKey, [
        full,
        { ...full, id: "complete-2", peakMemoryMetrics: { JVMHeapMemory: 2048 }, addTime: "2026-10-04T12:00:00.000GMT" },
        sparse,
        offHeapOnly,
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
    for (const field of ["spark.executor.peakMemoryMetrics", "spark.executor.resources", "spark.executor.attributes"]) {
      expect(
        Array.from(table.querySelectorAll(`[data-yf="${field}"]`)).some((cell) => cell.textContent === "—"),
        field,
      ).toBe(true);
    }

    fireEvent.click(table.querySelector('[data-col="peakJvmHeap"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("peakJvmHeap"));
    fireEvent.click(table.querySelector('[data-col="addTime"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("addTime"));

    fireEvent.click(table.querySelector('[data-col="status"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("status"));

    const filter = screen.getByPlaceholderText("Filter id / host…");
    fireEvent.change(filter, { target: { value: "complete-2" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("complete-2"));
    fireEvent.change(filter, { target: { value: "" } });
    await waitFor(() => expect(router.state.location.search.q).toBeUndefined());

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

  it("renders sparse job metadata and clears status and text filters", async () => {
    const sparseJobs = [
      {
        ...allJobs[0]!,
        jobId: 80,
        status: "FAILED",
        description: "optimized query",
        name: "original query",
        submissionTime: null,
        completionTime: null,
        numCompletedIndices: 1,
        numCompletedTasks: 2,
        numActiveTasks: null,
        numFailedTasks: null,
        numKilledTasks: null,
        numTasks: null,
      },
      {
        ...allJobs[0]!,
        jobId: 81,
        status: "SUCCEEDED",
        description: null,
        name: "",
        submissionTime: "1791822000000",
        completionTime: null,
        numCompletedIndices: null,
        numCompletedTasks: 2,
        numActiveTasks: 1,
        numFailedTasks: 1,
        numKilledTasks: 1,
        numTasks: 4,
      },
      {
        ...allJobs[0]!,
        jobId: 82,
        status: "RUNNING",
        description: "same name",
        name: "same name",
        submissionTime: null,
        completionTime: null,
        numCompletedIndices: null,
        numCompletedTasks: null,
        numActiveTasks: null,
        numFailedTasks: null,
        numKilledTasks: null,
        numTasks: null,
      },
    ] as SparkJob[];
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sparse-jobs");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { container, router } = renderListPage("jobs", "?status=FAILED&q=missing", (client) => {
      client.setQueryData(sp.jobs(APP_ID, { status: "FAILED", kind: "static", attempt: null }).queryKey, sparseJobs);
      client.setQueryData(sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, sparseJobs);
    });
    const table = await screen.findByRole("table", { name: "Spark jobs" });

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter jobs by name or id" }), { target: { value: "" } });
    await waitFor(() => expect(router.state.location.search.q).toBeUndefined());
    fireEvent.click(screen.getByRole("combobox", { name: "Job status filter" }));
    const allStatuses = await screen.findByRole("option", { name: "All statuses" });
    fireEvent.pointerDown(allStatuses, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(allStatuses, { button: 0, pointerType: "mouse" });
    fireEvent.click(allStatuses);
    await waitFor(() => expect(router.state.location.search.status).toBeUndefined());

    expect(screen.getByText("optimized query")).toBeTruthy();
    expect(screen.getByText("original query")).toBeTruthy();
    const durationButton = table.querySelector<HTMLElement>('[data-col="duration"] button');
    expect(durationButton).toBeTruthy();
    fireEvent.click(durationButton!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("duration"));

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clickAnchor).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-burrow-table="spark-jobs"]')?.getAttribute("data-burrow-rows")).toBe("3");
  });

  it("shows both empty job states and the initial loading skeleton", async () => {
    const failedEmpty = renderListPage("jobs", "?status=FAILED", (client) => {
      client.setQueryData(sp.jobs(APP_ID, { status: "FAILED", kind: "static", attempt: null }).queryKey, []);
    });
    expect(await screen.findByRole("heading", { name: "No failed jobs" })).toBeTruthy();
    expect(screen.getByText("Clear the status filter to see every job.")).toBeTruthy();
    failedEmpty.unmount();

    const empty = renderListPage("jobs", "", (client) => {
      client.setQueryData(sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, []);
    });
    expect(await screen.findByRole("heading", { name: "No jobs yet" })).toBeTruthy();
    expect(screen.getByText("Jobs appear as soon as the application submits one.")).toBeTruthy();
    empty.unmount();

    const queryKey = sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey;
    const loading = renderListPage("jobs", "", (client) => {
      client.setQueryDefaults(queryKey, { enabled: false });
      client.removeQueries({ queryKey, exact: true });
    });
    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    loading.unmount();
  });

  it("renders completed stage attempts in the grouped view", async () => {
    const repeated = { ...stages[0]!, attemptId: 1 };
    const sparse = { ...stages[1]!, stageId: 900, attemptId: null, status: null };
    const sparseZero = { ...sparse, attemptId: 0 };
    const reverseZero = { ...sparse, stageId: 901, attemptId: 0 };
    const reverseMissing = { ...sparse, stageId: 901, attemptId: null };
    const { router } = renderListPage("stages", "?status=COMPLETE&agg=1", (client) => {
      client.setQueryData(sp.stages(APP_ID, { status: "COMPLETE", kind: "static", attempt: null }).queryKey, [
        ...stages,
        repeated,
        sparse,
        sparseZero,
        reverseZero,
        reverseMissing,
      ]);
    });
    expect(await screen.findByRole("switch", { name: "Group attempts of the same stage" })).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ status: "COMPLETE", agg: "1" });
    expect(await screen.findByRole("combobox", { name: "Attempts of stage 900" })).toBeTruthy();

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
    fireEvent.click(statusFilter);
    const allStatuses = await screen.findByRole("option", { name: "All statuses" });
    fireEvent.pointerDown(allStatuses, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(allStatuses, { button: 0, pointerType: "mouse" });
    fireEvent.click(allStatuses);
    await waitFor(() => expect(router.state.location.search.status).toBeUndefined());

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

  it("handles missing attempt metadata and navigates to attempt zero", async () => {
    const incomplete: SparkStage = {
      ...stages[0]!,
      stageId: 909,
      attemptId: null,
      status: null,
      numActiveTasks: null,
      numCompleteTasks: null,
    };
    const { router } = renderListPage("stages", "", (client) => {
      client.setQueryData(sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, [incomplete]);
    });
    const table = await screen.findByRole("table", { name: "Spark stages" });
    fireEvent.click(table.querySelectorAll('[role="row"]')[1]!);
    await waitFor(() => expect(router.state.location.pathname).toContain("/stages/909/0"));
  });

  it("shows empty and loading states for the stage list", async () => {
    const empty = renderListPage("stages", "", (client) => {
      client.setQueryData(sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, []);
    });
    expect(await screen.findByRole("heading", { name: "No stages yet" })).toBeTruthy();
    empty.unmount();

    const filtered = renderListPage("stages", "?status=FAILED", (client) => {
      client.setQueryData(sp.stages(APP_ID, { status: "FAILED", kind: "static", attempt: null }).queryKey, []);
    });
    expect(await screen.findByRole("heading", { name: "No failed stages" })).toBeTruthy();
    filtered.unmount();

    renderListPage("stages", "", (client) => {
      client.removeQueries({ queryKey: sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey });
    });
    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
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

  it("handles missing environment keys, values, classpath parts, and resource maps", async () => {
    const sparseEnvironment = {
      runtime: {},
      sparkProperties: [[], ["spark.nullValue"], ["spark.empty", ""], ["spark.present", "value"]],
      systemProperties: undefined,
      hadoopProperties: null,
      metricsProperties: [],
      classpathEntries: [[], ["/opt/lib", "jar"]],
      resourceProfiles: [
        { executorResources: null, taskResources: null },
        { id: 1, executorResources: { gpu: { amount: 1 } }, taskResources: { gpu: { amount: 2 } } },
      ],
    } as unknown as SparkEnvironment;
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sparse-environment");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { router } = renderListPage("environment", "", (client) => {
      client.setQueryData(sp.environment(APP_ID, null).queryKey, sparseEnvironment);
    });
    await screen.findByText("Spark Properties");

    const sparkSearch = screen.getByRole("searchbox", { name: "Filter Spark Properties" });
    fireEvent.change(sparkSearch, { target: { value: "spark" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("spark"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter Spark Properties" }), { target: { value: "" } });
    await waitFor(() => expect(router.state.location.search.q).toBeUndefined());
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter System Properties" }), { target: { value: "missing" } });

    const propertyTable = screen.getByRole("table", { name: "Spark Properties" });
    fireEvent.click(within(propertyTable).getByRole("button", { name: "Value" }));
    fireEvent.click(within(propertyTable.closest("[data-burrow-table-root]")!).getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    expect(createUrl).toHaveBeenCalledOnce();
    expect(clickAnchor).toHaveBeenCalledOnce();
    const classpath = screen.getByRole("table", { name: "Classpath entries" });
    fireEvent.click(within(classpath).getByRole("button", { name: "Kind" }));
    fireEvent.click(within(classpath.closest("[data-burrow-table-root]")!).getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getAllByRole("menuitem", { name: /CSV/ }).at(-1)!);
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(clickAnchor).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Profile").length).toBeGreaterThan(1);
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
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
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

  it("shows the Spark environment loading skeleton before its first response", async () => {
    const queryKey = sp.environment(APP_ID, null).queryKey;
    const loading = renderListPage("environment", "", (client) => {
      client.setQueryDefaults(queryKey, { enabled: false });
      client.removeQueries({ queryKey, exact: true });
    });
    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    loading.unmount();
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
    fireEvent.change(filter, { target: { value: "" } });
    await waitFor(() => expect(document.querySelector('[data-burrow-table-root="spark-storage"]')?.textContent).toContain("5 shown"));
  });

  it("handles missing RDD fields and starts with a URL-expanded detail row", async () => {
    const incomplete: SparkRdd = {
      ...rdds[0]!,
      id: 999,
      name: null,
      numPartitions: 0,
      numCachedPartitions: null,
      memoryUsed: null,
      diskUsed: null,
      dataDistribution: [],
      partitions: [],
    };
    const { router } = renderListPage("storage", "?rdd=999", (queryClient) => {
      queryClient.setQueryData(sp.rdds(APP_ID, "static", null).queryKey, [...rdds, incomplete]);
      queryClient.setQueryData(sp.rdd(APP_ID, 999, "static", null).queryKey, { rdd: incomplete });
    });
    const table = await screen.findByRole("table", { name: "Cached RDDs" });
    fireEvent.click(table.querySelector('[data-col="fraction"] button')!);
    const row = within(table).getByRole("row", { name: /999/ });
    expect(row.textContent).toContain("—");
    const hide = screen.getByRole("button", { name: "Hide partitions and executor distribution of RDD 999" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("region", { name: "RDD 999 detail" })).toBeTruthy();
    fireEvent.click(hide);
    await waitFor(() => expect(router.state.location.search.rdd).toBeUndefined());
  });

  it("shows a loading skeleton while cached RDDs are still pending", async () => {
    renderListPage("storage", "", (client) => {
      client.removeQueries({ queryKey: sp.rdds(APP_ID, "static", null).queryKey });
    });
    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
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

  it("renders sparse RDD executor and partition details", async () => {
    const sparse: SparkRdd = {
      ...rdd52,
      numPartitions: undefined,
      numCachedPartitions: null,
      dataDistribution: [
        { ...rdd52.dataDistribution[0]!, address: null, memoryUsed: null, memoryRemaining: null },
        { ...rdd52.dataDistribution[0]!, address: "worker-1", memoryUsed: 10, memoryRemaining: 10 },
      ],
      partitions: [
        { ...rdd52.partitions[0]!, blockName: null, storageLevel: null, memoryUsed: null, diskUsed: null, executors: [] },
        { ...rdd52.partitions[0]!, blockName: "rdd_52_1", executors: ["worker-1"] },
      ],
    };
    const view = renderListPage("storage", "", (client) => {
      client.setQueryData(sp.rdd(APP_ID, 52, "static", null).queryKey, { rdd: sparse });
    });
    await act(async () => {
      await view.router.navigate({
        to: "/apps/$appId/spark/storage/$rddId",
        params: { appId: APP_ID, rddId: "52" },
      });
    });
    expect(await screen.findByRole("heading", { name: "RDD 52" })).toBeTruthy();
    expect(screen.getAllByRole("region", { name: "Partitions of RDD 52" }).some((region) => region.textContent?.includes("worker-1"))).toBe(
      true,
    );
    expect(
      screen
        .getAllByRole("region", { name: "Executor distribution of RDD 52" })
        .some((region) => region.querySelectorAll("tbody tr").length === 2),
    ).toBe(true);
  });

  it("shows pending and fatal RDD detail states", async () => {
    const queryKey = sp.rdd(APP_ID, 52, "static", null).queryKey;
    const pending = renderListPage("storage", "", (client) => {
      client.setQueryDefaults(queryKey, { enabled: false });
      client.removeQueries({ queryKey, exact: true });
    });
    await act(async () => {
      await pending.router.navigate({
        to: "/apps/$appId/spark/storage/$rddId",
        params: { appId: APP_ID, rddId: "52" },
      });
    });
    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    pending.unmount();

    const failed = renderListPage("storage", "", (client) => {
      client.setQueryDefaults(queryKey, { enabled: false });
      const query = client.getQueryCache().find({ queryKey, exact: true })!;
      query.setState({
        ...query.state,
        data: undefined,
        status: "error",
        error: new Error("RDD detail unavailable"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    await act(async () => {
      await failed.router.navigate({
        to: "/apps/$appId/spark/storage/$rddId",
        params: { appId: APP_ID, rddId: "52" },
      });
    });
    expect(await screen.findByRole("heading", { name: "Spark request failed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    failed.unmount();
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

  it("extends live timeline bounds through now", async () => {
    nowStore.setState(() => ({ now: Date.now() + 10_000_000 }));
    const { container } = renderListPage("timeline", "", undefined, "live");
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    expect(timeline.querySelector("svg")).toBeTruthy();
    expect(container.textContent).toContain("rows");
  });

  it("shows the page skeleton while one timeline source is still pending", async () => {
    renderListPage("timeline", "", (client) => {
      client.removeQueries({ queryKey: sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey });
    });
    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
  });

  it("centers a single-time-point timeline in the minimum window", async () => {
    const at = "2026-10-03T12:00:00.000GMT";
    const { container } = renderListPage("timeline", "", (client) => {
      client.setQueryData(sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, [
        { ...jobs[0]!, submissionTime: at, completionTime: at, stageIds: [] },
      ]);
      client.setQueryData(sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, []);
      client.setQueryData(sp.executors(APP_ID, "static", null).queryKey, []);
      client.setQueryData(sp.allExecutors(APP_ID, "static", null).queryKey, []);
    });
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    expect(timeline.querySelector("svg")).toBeTruthy();
    expect(container.textContent).toContain("1 rows");
  });

  it("reports stale, single-source, and multiple-source timeline failures", async () => {
    const fail = async (
      client: InstanceType<typeof QueryClient>,
      key: readonly unknown[],
      keepData: boolean,
      error: Error | string = new Error("timeline source failed"),
    ) => {
      const query = client.getQueryCache().find({ queryKey: key })!;
      await query.cancel({ silent: true });
      query.setState({
        ...query.state,
        data: keepData ? query.state.data : undefined,
        status: "error",
        error: error as Error,
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
    await screen.findByRole("region", { name: "Timeline" });
    await fail(stale.client, sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, true);
    expect(await screen.findByText(/1 of four timeline sources failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry failed sources" }));
    stale.unmount();

    const single = renderListPage("timeline");
    empty(single.client);
    await screen.findByText("Nothing to plot yet");
    await fail(single.client, sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, false);
    expect(await screen.findByText("Spark request failed")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("timeline source failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    single.unmount();

    const multiple = renderListPage("timeline");
    empty(multiple.client);
    await screen.findByText("Nothing to plot yet");
    await fail(multiple.client, sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, false);
    await fail(multiple.client, sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, false, "stage source unavailable");
    const multipleError = await screen.findByText("2 Spark timeline sources could not be loaded");
    expect(multipleError.parentElement?.parentElement?.textContent).toContain("stages: stage source unavailable");
  });

  it("renders empty partial data and fills missing executor lists after failed queries", async () => {
    const noBars = (client: InstanceType<typeof QueryClient>) => {
      client.setQueryData(sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, []);
      client.setQueryData(sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, []);
      client.setQueryData(sp.executors(APP_ID, "static", null).queryKey, []);
      client.setQueryData(sp.allExecutors(APP_ID, "static", null).queryKey, []);
    };
    const staleEmpty = renderListPage("timeline", "", noBars);
    await screen.findByRole("region", { name: "Timeline" });
    const jobFailure = staleEmpty.client.getQueryCache().find({
      queryKey: sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey,
    })!;
    await jobFailure.cancel({ silent: true });
    jobFailure.setState({
      ...jobFailure.state,
      status: "error",
      error: "job source unavailable" as Error,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: jobFailure.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("timeline sources failed"))).toBe(true),
    );
    const staleStatus = (await screen.findAllByRole("status")).find((node) => node.textContent?.includes("timeline sources failed"))!;
    expect(staleStatus.textContent).toContain("jobs: job source unavailable");
    expect(screen.getByText("0 rows")).toBeTruthy();
    expect(screen.getByText("Nothing to plot yet")).toBeTruthy();
    staleEmpty.unmount();

    const missingExecutors = renderListPage("timeline");
    await screen.findByRole("region", { name: "Timeline" });
    for (const [queryKey, reason] of [
      [sp.executors(APP_ID, "static", null).queryKey, "executor list failed"],
      [sp.allExecutors(APP_ID, "static", null).queryKey, "all executor list failed"],
    ] as const) {
      const query = missingExecutors.client.getQueryCache().find({ queryKey })!;
      await query.cancel({ silent: true });
      query.setState({
        ...query.state,
        data: undefined,
        status: "error",
        error: new Error(reason),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    }
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("2 of four timeline sources failed"))).toBe(true),
    );
    expect(screen.getByRole("region", { name: "Timeline" }).querySelector("svg")).toBeTruthy();
    missingExecutors.unmount();
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

  it("covers sparse stage/task values and resets the server task controls", async () => {
    const sparseStage: SparkStage = {
      ...stageDetail,
      description: null,
      name: null,
      numTasks: null,
      numCompleteTasks: null,
      numActiveTasks: null,
      numFailedTasks: null,
      numKilledTasks: null,
      isShufflePushEnabled: null,
    };
    const sparseTask: SparkTask = { ...stageTasks[0]!, status: "KILLED", duration: null, attempt: null };
    const pageOptions = {
      offset: 50,
      length: 25,
      status: "KILLED",
      kind: "static" as const,
      attempt: null,
    };
    const { router } = renderListPage("stage-detail", "?size=25&page=3&taskStatus=KILLED&sort=status&dir=desc", (client) => {
      client.setQueryData(
        sp.stageAttempt(APP_ID, 0, 0, {
          details: true,
          withSummaries: true,
          quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
          kind: "static",
          attempt: null,
        }).queryKey,
        sparseStage,
      );
      client.setQueryData(sp.taskList(APP_ID, 0, 0, pageOptions).queryKey, [sparseTask]);
    });

    expect(await screen.findByText("server sorts runtime only")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Show additional task metrics" }));
    await waitFor(() => expect(router.state.location.search.level).toBe("more"));
    fireEvent.click(screen.getByRole("switch", { name: "Show additional task metrics" }));
    await waitFor(() => expect(router.state.location.search.level).toBeUndefined());

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(router.state.location.search.page).toBe("2"));

    fireEvent.click(screen.getByRole("combobox", { name: "Task status filter" }));
    const allStatuses = await screen.findByRole("option", { name: "All statuses" });
    fireEvent.pointerDown(allStatuses, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(allStatuses, { button: 0, pointerType: "mouse" });
    fireEvent.click(allStatuses);
    await waitFor(() => expect(router.state.location.search.taskStatus).toBeUndefined());

    fireEvent.click(screen.getByRole("combobox", { name: "Tasks per page" }));
    const allTasks = await screen.findByRole("option", { name: "All tasks (client-sorted)" });
    fireEvent.pointerDown(allTasks, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(allTasks, { button: 0, pointerType: "mouse" });
    fireEvent.click(allTasks);
    await waitFor(() => expect(router.state.location.search.size).toBeUndefined());
  });

  it("uses the running task count for a server-filtered task page", async () => {
    const runningTask: SparkTask = { ...stageTasks[0]!, status: "RUNNING" };
    renderListPage("stage-detail", "?size=25&taskStatus=RUNNING", (client) => {
      client.setQueryData(sp.taskList(APP_ID, 0, 0, { offset: 0, length: 25, status: "RUNNING", kind: "static", attempt: null }).queryKey, [
        runningTask,
      ]);
      client.setQueryData(
        sp.stageAttempt(APP_ID, 0, 0, {
          details: true,
          withSummaries: true,
          quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
          kind: "static",
          attempt: null,
        }).queryKey,
        { ...stageDetail, isShufflePushEnabled: true },
      );
    });
    expect(await screen.findByRole("region", { name: "Tasks of stage 0 attempt 0" })).toBeTruthy();
  });

  it("uses the stage name as a fallback description and handles no description fields", async () => {
    const stageOptions = sp.stageAttempt(APP_ID, 0, 0, {
      details: true,
      withSummaries: true,
      quantiles: [0.05, 0.25, 0.5, 0.75, 0.95],
      kind: "static",
      attempt: null,
    });
    const named = renderListPage("stage-detail", "", (client) => {
      client.setQueryData(stageOptions.queryKey, { ...stageDetail, description: null, name: "Fallback stage name" });
    });
    expect(await screen.findByText("Fallback stage name")).toBeTruthy();
    named.unmount();

    renderListPage("stage-detail", "", (client) => {
      client.setQueryData(stageOptions.queryKey, { ...stageDetail, description: null, name: null });
    });
    expect(await screen.findByRole("heading", { name: /Stage 0 · attempt 0/ })).toBeTruthy();
  });

  it("keeps SQL detail visible and retries a stale jobs lookup", async () => {
    const view = renderListPage("sql-detail");
    expect(await screen.findByRole("heading", { name: /SQL execution 0/ })).toBeTruthy();
    const queryKey = sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey;
    markQueryError(view.client, queryKey, new Error("SQL jobs refresh failed"), true);
    expect(await screen.findByText(/Could not refresh the jobs for this SQL execution/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("keeps stale SQL execution data and renders missing or failed execution states", async () => {
    const execKey = sp.sqlExecution(APP_ID, 0, { kind: "static", attempt: null }).queryKey;
    const stale = renderListPage("sql-detail", "", (client) => {
      markQueryError(client, execKey, new Error("SQL execution refresh failed"), true);
    });
    expect(await screen.findByText(/Could not refresh SQL execution 0/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry now" })[0]!);
    stale.unmount();

    const originalSqlExecution = sp.sqlExecution;
    const sqlExecutionSpy = vi.spyOn(sp, "sqlExecution").mockImplementation((appId, executionId, opts) => ({
      ...originalSqlExecution(appId, executionId, opts),
      queryFn: async () => null as never,
    }));
    const missing = renderListPage("sql-detail", "", (client) => {
      client.removeQueries({ queryKey: execKey, exact: true });
    });
    expect(await screen.findByText(/is not in this application/)).toBeTruthy();
    missing.unmount();
    sqlExecutionSpy.mockRestore();

    const failed = renderListPage("sql-detail", "", (client) => {
      markQueryError(client, execKey, new Error("SQL execution unavailable"), false);
    });
    expect((await screen.findAllByText(/Cannot reach Burrow at/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    failed.unmount();
  });

  it("renders optional SQL details, searches the plan, and links stages with the active attempt", async () => {
    const attempt = "attempt-7";
    const detail = {
      id: 0,
      status: null,
      description: "Fixture SQL execution",
      errorMessage: "Query failed",
      successJobIds: [0],
      nodes: [],
      edges: null,
      planDescription: "WholeStageCodegen\n+- Scan\n   +- FileScan",
    } as SparkSqlExecution;
    const view = renderListPage(
      "sql-detail",
      "",
      (client) => {
        client.setQueryData(sp.sqlExecution(APP_ID, 0, { kind: "static", attempt }).queryKey, detail);
        client.setQueryData(sp.jobs(APP_ID, { kind: "static", attempt }).queryKey, [{ ...allJobs[0]!, jobId: 0, stageIds: [8] }]);
      },
      "static",
      attempt,
    );

    expect((await screen.findAllByText("UNKNOWN")).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Error of SQL execution 0" }).textContent).toContain("Query failed");
    expect(screen.getByText(/0 nodes · 0 edges/)).toBeTruthy();
    const stageLink = await screen.findByRole("link", { name: "stage 8" });
    expect(stageLink.getAttribute("href")).toContain("&attempt=attempt-7");

    const search = screen.getByRole("searchbox", { name: "Find in the SQL plan" });
    fireEvent.change(search, { target: { value: "Scan" } });
    await waitFor(() => expect(view.router.state.location.search.q).toBe("Scan"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Find in the SQL plan" }), { target: { value: "" } });
    await waitFor(() => expect(view.router.state.location.search.q).toBeUndefined());
    view.unmount();
  });

  it("shows no-job and missing-stage states and formats non-Error job failures", async () => {
    const noJobs = renderListPage("sql-detail", "", (client) => {
      client.setQueryData(sp.sqlExecution(APP_ID, 0, { kind: "static", attempt: null }).queryKey, {
        id: 0,
        status: "COMPLETED",
        description: "No jobs",
        nodes: [],
        edges: undefined,
      } satisfies SparkSqlExecution);
    });
    expect(await screen.findByText("This execution ran no jobs.")).toBeTruthy();
    noJobs.unmount();

    const jobWithoutStages = renderListPage("sql-detail", "", (client) => {
      client.setQueryData(sp.sqlExecution(APP_ID, 0, { kind: "static", attempt: null }).queryKey, {
        id: 0,
        status: "COMPLETED",
        successJobIds: [0],
        nodes: [],
      } satisfies SparkSqlExecution);
      client.setQueryData(sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, [{ ...allJobs[0]!, jobId: 0, stageIds: null }]);
    });
    expect(await screen.findByText("No stage ids reported for these jobs.")).toBeTruthy();
    jobWithoutStages.unmount();

    const originalJobs = sp.jobs;
    const jobsSpy = vi.spyOn(sp, "jobs").mockImplementation((appId, opts) => {
      const query = originalJobs(appId, opts);
      if (opts?.status) return query;
      return { ...query, queryFn: async () => Promise.reject("job list unavailable") };
    });
    const failedJobs = renderListPage("sql-detail", "", (client) => {
      client.setQueryData(sp.sqlExecution(APP_ID, 0, { kind: "static", attempt: null }).queryKey, {
        id: 0,
        status: "COMPLETED",
        successJobIds: [0],
        nodes: [],
      } satisfies SparkSqlExecution);
      client.removeQueries({ queryKey: sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, exact: true });
    });
    expect(await screen.findByText("job list unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    failedJobs.unmount();
    jobsSpy.mockRestore();
  });

  it("shows an Error object from the SQL jobs lookup", async () => {
    const jobsKey = sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey;
    const originalJobs = sp.jobs;
    const jobsSpy = vi.spyOn(sp, "jobs").mockImplementation((appId, opts) => ({
      ...originalJobs(appId, opts),
      queryFn: async () => Promise.reject(new Error("SQL job endpoint failed")),
    }));
    const view = renderListPage("sql-detail", "", (client) => {
      client.setQueryData(sp.sqlExecution(APP_ID, 0, { kind: "static", attempt: null }).queryKey, {
        id: 0,
        status: "COMPLETED",
        successJobIds: [0],
        nodes: [],
      } satisfies SparkSqlExecution);
      client.removeQueries({ queryKey: jobsKey, exact: true });
    });
    expect(await screen.findByText("SQL job endpoint failed")).toBeTruthy();
    view.unmount();
    jobsSpy.mockRestore();
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
      markQueryError(view.client, attemptsQuery.queryKey, "attempt list failed", false);
      markQueryError(view.client, tasksQuery.queryKey, new Error("task list failed"), false);
    });

    expect(await screen.findByText("attempt list failed")).toBeTruthy();
    expect((await screen.findAllByText("task list failed")).length).toBeGreaterThan(0);
    for (const button of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(button);
    view.unmount();

    const fatalAttempts = renderListPage("stage-detail");
    await screen.findByRole("heading", { name: /Stage 0 · attempt 0/ });
    act(() => markQueryError(fatalAttempts.client, attemptsQuery.queryKey, new Error("attempt endpoint failed"), false));
    expect(await screen.findByText("attempt endpoint failed")).toBeTruthy();
    fatalAttempts.unmount();
  });

  it("formats missing stage attempt metadata with safe labels", async () => {
    const attempts = [
      { ...stageAttempts[0]!, attemptId: null, status: null },
      { ...stageAttempts[0]!, attemptId: 1, status: "FAILED" },
    ] as SparkStage[];
    renderListPage("stage-detail", "", (client) => {
      client.setQueryData(sp.stageAttempts(APP_ID, 0, "static", null).queryKey, attempts);
    });
    const selector = await screen.findByRole("combobox", { name: "Stage attempt" });
    fireEvent.click(selector);
    expect(await screen.findByRole("option", { name: "Attempt 0 · ?" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Attempt 1 · FAILED" })).toBeTruthy();
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
