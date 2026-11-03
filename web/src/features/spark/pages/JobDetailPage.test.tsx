/** URL integration coverage for the Spark job DAG's expansion state. */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { JobDetailPage } = await import("./JobDetailPage");
const { SparkProvider } = await import("../ui/context");
const { sp } = await import("../data/queries");
const { sparkSearch } = await import("../data/search");

const APP_ID = "application_1791010000001_0009";
const JOB_ID = 2;
const FIXTURE_ROOT = "../fixtures/spark/4.2.0/rdd-wordcount";
const JOB = {
  ...(JSON.parse(readFileSync(`${FIXTURE_ROOT}/rest/final.job-2.json`, "utf8")) as Record<string, unknown>),
  jobTags: ["word-count"],
} as never;
const STAGES = JSON.parse(readFileSync(`${FIXTURE_ROOT}/rest/final.stages.details.json`, "utf8")) as never;
const DAG = JSON.parse(readFileSync(`${FIXTURE_ROOT}/dag-job-2.json`, "utf8")) as never;

function renderJobPage(
  initialUrl: string,
  options: { kind?: "static" | "live"; job?: unknown; stages?: unknown; wrapScroll?: boolean } = {},
) {
  const kind = options.kind ?? "static";
  const rootRoute = createRootRoute();
  const appRoute = createRoute({ getParentRoute: () => rootRoute, path: "/apps/$appId" });
  const sparkRoute = createRoute({ getParentRoute: () => appRoute, path: "spark" });
  const jobRoute = createRoute({
    getParentRoute: () => sparkRoute,
    path: "jobs/$jobId",
    validateSearch: sparkSearch,
    component: () => (
      <div className={options.wrapScroll === false ? undefined : "burrow-page-scroll"}>
        <JobDetailPage />
      </div>
    ),
  });
  const jobsRoute = createRoute({ getParentRoute: () => sparkRoute, path: "jobs/", component: () => null });
  const stageRoute = createRoute({ getParentRoute: () => sparkRoute, path: "stages/$stageId/$attemptId", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute.addChildren([sparkRoute.addChildren([jobRoute, jobsRoute, stageRoute])])]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(sp.job(APP_ID, JOB_ID, kind, null).queryKey, (options.job ?? JOB) as never);
  client.setQueryData(sp.stages(APP_ID, { kind, attempt: null }).queryKey, (options.stages ?? STAGES) as never);
  client.setQueryData(sp.dagJob(APP_ID, JOB_ID, null).queryKey, DAG);

  const view = render(
    <QueryClientProvider client={client}>
      <SparkProvider value={{ appId: APP_ID, kind, sparkAppId: APP_ID, attempt: null, source: null, application: null, resolving: false }}>
        <RouterProvider router={router} />
      </SparkProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("JobDetailPage DAG expansion URL state", () => {
  it("reads the initial expansion mode and keeps toggles shareable in the URL", { timeout: 30_000 }, async () => {
    const { router } = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}?expand=0`);
    await screen.findByRole("tree", {}, { timeout: 10_000 });
    const canvas = screen.getByTestId("dag-canvas");
    const treeItems = () => screen.getAllByRole("treeitem");
    await waitFor(() => expect(canvas.getAttribute("data-dag-layout")).toBe("ready"), { timeout: 10_000 });
    await waitFor(() => expect(treeItems()).toHaveLength(2));
    expect(router.state.location.search.expand).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Expand RDD details" }));
    await waitFor(() => expect(router.state.location.search.expand).toBe("1"));
    await waitFor(() => expect(treeItems()).toHaveLength(8));

    fireEvent.click(screen.getByRole("button", { name: "Show stage summary" }));
    await waitFor(() => expect(router.state.location.search.expand).toBe("0"));
    await waitFor(() => expect(treeItems()).toHaveLength(2));
  });

  it("keeps the page scroll position while changing stage-table sorting", { timeout: 30_000 }, async () => {
    const { container, router } = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}`);
    const table = await screen.findByRole("table", { name: `Stages of job ${JOB_ID}` });
    const scroller = container.querySelector<HTMLElement>(".burrow-page-scroll")!;
    scroller.scrollTop = 120;
    fireEvent.click(table.querySelector('[data-col="stageId"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("stageId"));
    await waitFor(() => expect(scroller.scrollTop).toBe(120));
  });

  it("explains a job that is missing or cannot be read", { timeout: 30_000 }, async () => {
    const missing = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}`);
    missing.client.setQueryData(sp.job(APP_ID, JOB_ID, "static", null).queryKey, null as never);
    expect(await screen.findByText(/Job 2 is not in this application/)).toBeTruthy();
    missing.unmount();

    const failed = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}`);
    const query = failed.client.getQueryCache().find({ queryKey: sp.job(APP_ID, JOB_ID, "static", null).queryKey })!;
    query.setState({
      ...query.state,
      data: undefined,
      status: "error",
      error: new Error("job endpoint failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
    expect((await screen.findAllByText(/Cannot reach Burrow at \/api\/spark\//)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    failed.unmount();
  });

  it("keeps the last job and stage data visible when refreshes fail", { timeout: 30_000 }, async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const view = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}`);
    expect(await screen.findByText("word-count")).toBeTruthy();

    const jobQuery = view.client.getQueryCache().find({ queryKey: sp.job(APP_ID, JOB_ID, "static", null).queryKey })!;
    jobQuery.setState({
      ...jobQuery.state,
      status: "error",
      error: new Error("job refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: jobQuery.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
    expect(await screen.findByText("Could not refresh Spark job 2")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry now" })[0]!);

    const stagesQuery = view.client.getQueryCache().find({ queryKey: sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey })!;
    stagesQuery.setState({
      ...stagesQuery.state,
      status: "error",
      error: new Error("stages refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: stagesQuery.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
    expect(await screen.findByText("Could not refresh the stages of job 2")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry now" })[1]!);
  });

  it("shows the terminal stage error state if stages cannot be loaded", { timeout: 30_000 }, async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const view = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}`);
    await screen.findByRole("table", { name: `Stages of job ${JOB_ID}` });
    const query = view.client.getQueryCache().find({ queryKey: sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey })!;
    query.setState({
      ...query.state,
      data: undefined,
      status: "error",
      error: new Error("stages endpoint failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
    expect((await screen.findAllByText("stages endpoint failed")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("selects a stage on mobile, links to it, clears the filter, and syncs table controls to the URL", { timeout: 30_000 }, async () => {
    const media = {
      matches: true,
      media: "(max-width: 639px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(media);

    const { router } = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}`);
    const stageButton = await screen.findByRole("button", { name: "Stage 4, SKIPPED, 0 of 4 tasks" });
    fireEvent.click(stageButton);
    await waitFor(() => expect(router.state.location.search.stage).toBe("4"));

    const stageHref = `/apps/${APP_ID}/spark/stages/4/0`;
    expect(screen.getAllByRole("link", { name: "4" }).some((link) => link.getAttribute("href") === stageHref)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear selected stage filter" }));
    await waitFor(() => expect(router.state.location.search.stage).toBeUndefined());

    const table = await screen.findByRole("table", { name: `Stages of job ${JOB_ID}` });
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    await waitFor(() => expect(router.state.location.search.cols).toBeDefined());

    fireEvent.click(table.querySelectorAll('[role="row"]')[1]!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/apps/${APP_ID}/spark/stages/4/0`));
  });

  it("renders differing job names and failed stages with missing attempt metrics", { timeout: 30_000 }, async () => {
    const stages = STAGES as unknown as Record<string, unknown>[];
    const stage = {
      ...stages.find((item) => item.stageId === 4)!,
      attemptId: null,
      status: "FAILED",
      numActiveTasks: null,
      numCompleteTasks: null,
    };
    const job = { ...(JOB as Record<string, unknown>), description: "optimized query", name: "original query", stageIds: [4] };
    const { router } = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}?stage=4`, { kind: "live", job, stages: [stage] });

    expect(await screen.findByText("optimized query")).toBeTruthy();
    expect(screen.getByText("original query")).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "4" }).some((link) => link.getAttribute("href")?.includes("/spark/stages/4/0"))).toBe(true);

    const table = await screen.findByRole("table", { name: `Stages of job ${JOB_ID}` });
    fireEvent.click(table.querySelectorAll('[role="row"]')[1]!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/apps/${APP_ID}/spark/stages/4/0`));
  });

  it("handles jobs with no stages and stages that are still loading", { timeout: 30_000 }, async () => {
    const withoutStages = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}`, {
      job: { ...(JOB as Record<string, unknown>), stageIds: [] },
    });
    expect(await screen.findByRole("heading", { name: "Spark reports no stages for this job" })).toBeTruthy();
    withoutStages.unmount();

    const loading = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}`);
    const stagesQuery = loading.client.getQueryCache().find({
      queryKey: sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey,
      exact: true,
    })!;
    stagesQuery.setState({ ...stagesQuery.state, data: undefined, status: "pending", error: null, fetchStatus: "fetching" });
    expect((await screen.findAllByRole("status", { name: "Loading" })).length).toBeGreaterThan(0);
    loading.unmount();
  });

  it("sorts without a page scroller and tolerates a scroller removed during navigation", { timeout: 30_000 }, async () => {
    const noScroller = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}`, { wrapScroll: false });
    let table = await screen.findByRole("table", { name: `Stages of job ${JOB_ID}` });
    fireEvent.click(table.querySelector('[data-col="stageId"] button')!);
    await waitFor(() => expect(noScroller.router.state.location.search.sort).toBe("stageId"));
    noScroller.unmount();

    const withScroller = renderJobPage(`/apps/${APP_ID}/spark/jobs/${JOB_ID}`);
    table = await screen.findByRole("table", { name: `Stages of job ${JOB_ID}` });
    const scroller = withScroller.container.querySelector<HTMLElement>(".burrow-page-scroll")!;
    const querySelector = document.querySelector.bind(document);
    let scrollerQueries = 0;
    const querySelectorSpy = vi.spyOn(document, "querySelector").mockImplementation(((selector: string) => {
      if (selector === ".burrow-page-scroll") {
        scrollerQueries += 1;
        return (scrollerQueries === 1 ? scroller : null) as never;
      }
      return querySelector(selector);
    }) as typeof document.querySelector);
    fireEvent.click(table.querySelector('[data-col="stageId"] button')!);
    await waitFor(() => expect(withScroller.router.state.location.search.sort).toBe("stageId"));
    await waitFor(() => expect(scrollerQueries).toBeGreaterThan(1));
    querySelectorSpy.mockRestore();
    withScroller.unmount();
  });
});
