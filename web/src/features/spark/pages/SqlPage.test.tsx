/**
 * Integration render test for the Spark SQL tab over the REAL captured fixture.
 *
 * Parity mode is on (`window.__BURROW_PARITY__`), which the shared `DataTable` honours by rendering every row instead of a
 * virtual window — the only way to assert row order in jsdom, and the same mode the parity harness uses.
 *
 * The components are imported dynamically AFTER the flag is set, because `~/state/parity` reads it at module scope.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

window.__BURROW_PARITY__ = true;

const { act, render, cleanup, fireEvent, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { SqlPage } = await import("./SqlPage");
const { SqlDetailPage } = await import("./SqlDetailPage");
const { SparkProvider } = await import("../ui/context");
const { sp } = await import("../data/queries");
const { sparkSearch } = await import("../data/search");

const APP_ID = "application_1791010000001_0009";

/** `sql-cache-union`'s final capture: eight executions, ids 0..7 in REST (ascending) order. Paths resolve from the web root. */
const SQL = JSON.parse(readFileSync("../fixtures/spark/4.2.0/sql-cache-union/rest/final.sql.json", "utf8")) as unknown;
const SQL_DETAIL = JSON.parse(readFileSync("../fixtures/spark/4.2.0/window-sql/rest/final.sql-1.json", "utf8")) as unknown;
const SQL_JOBS = JSON.parse(readFileSync("../fixtures/spark/4.2.0/window-sql/rest/final.jobs.json", "utf8")) as unknown;

function stubApi(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path =
      url
        .replace(/^https?:\/\/[^/]+/, "")
        .replace(/^\/api\//, "")
        .split("?")[0] ?? "";
    const body = routes[path];
    if (body instanceof Response) return body;
    if (body === undefined) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: `no stub for ${path}` } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "x-burrow-api": "1", "x-burrow-cache": "miss" },
    });
  });
}

/** Mirrors the real route hierarchy so `getRouteApi("/apps/$appId/spark/sql/")` resolves, plus the two link targets. */
function renderSqlTab(
  application: { id: string; attempts: { appSparkVersion: string; attemptId?: string }[] } | null = null,
  initialSearch = "",
  attempt: string | null = null,
) {
  const rootRoute = createRootRoute();
  const appRoute = createRoute({ getParentRoute: () => rootRoute, path: "/apps/$appId" });
  const sparkRoute = createRoute({ getParentRoute: () => appRoute, path: "spark" });
  const sqlRoute = createRoute({ getParentRoute: () => sparkRoute, path: "sql/", component: () => <SqlPage /> });
  const executionRoute = createRoute({
    getParentRoute: () => sparkRoute,
    path: "sql/$executionId",
    component: () => null,
  });
  const jobRoute = createRoute({ getParentRoute: () => sparkRoute, path: "jobs/$jobId", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute.addChildren([sparkRoute.addChildren([sqlRoute, executionRoute, jobRoute])])]),
    history: createMemoryHistory({ initialEntries: [`/apps/${APP_ID}/spark/sql${initialSearch}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SparkProvider value={{ appId: APP_ID, kind: "static", sparkAppId: APP_ID, attempt, source: null, application, resolving: false }}>
        <RouterProvider router={router} />
      </SparkProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

function renderSqlDetail(
  options: { execution?: "loaded" | "stale" | "error" | "missing"; jobs?: "loaded" | "stale" | "error"; disableFetch?: boolean } = {},
) {
  const root = createRootRoute();
  const appRoute = createRoute({ getParentRoute: () => root, path: "/apps/$appId" });
  const sparkRoute = createRoute({ getParentRoute: () => appRoute, path: "spark" });
  const sqlRoute = createRoute({ getParentRoute: () => sparkRoute, path: "sql/", component: () => null });
  const detailRoute = createRoute({
    getParentRoute: () => sparkRoute,
    path: "sql/$executionId",
    validateSearch: sparkSearch,
    component: () => <SqlDetailPage />,
  });
  const jobRoute = createRoute({ getParentRoute: () => sparkRoute, path: "jobs/$jobId", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([appRoute.addChildren([sparkRoute.addChildren([sqlRoute, detailRoute, jobRoute])])]),
    history: createMemoryHistory({ initialEntries: [`/apps/${APP_ID}/spark/sql/1`] }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, enabled: !options.disableFetch } },
  });
  const executionOptions = sp.sqlExecution(APP_ID, 1, { kind: "static", attempt: null });
  const executionQuery = client.getQueryCache().build(client, executionOptions as never);
  const executionState = options.execution ?? "loaded";
  if (executionState === "loaded" || executionState === "stale") {
    client.setQueryData(executionOptions.queryKey, SQL_DETAIL as never);
    if (executionState === "stale")
      executionQuery.setState({
        ...executionQuery.state,
        status: "error",
        error: new Error("SQL detail refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: executionQuery.state.errorUpdateCount + 1,
      });
  } else {
    executionQuery.setState({
      ...executionQuery.state,
      data: undefined,
      status: executionState === "error" ? "error" : "success",
      error: executionState === "error" ? new Error("SQL execution unavailable") : null,
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });
  }
  const jobsOptions = sp.jobs(APP_ID, { kind: "static", attempt: null });
  const jobsQuery = client.getQueryCache().build(client, jobsOptions as never);
  const jobsState = options.jobs ?? "loaded";
  if (jobsState === "loaded" || jobsState === "stale") {
    client.setQueryData(jobsOptions.queryKey, SQL_JOBS as never);
    if (jobsState === "stale")
      jobsQuery.setState({
        ...jobsQuery.state,
        status: "error",
        error: new Error("job refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: jobsQuery.state.errorUpdateCount + 1,
      });
  } else {
    jobsQuery.setState({
      ...jobsQuery.state,
      data: undefined,
      status: "error",
      error: new Error("job list unavailable"),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });
  }
  const view = render(
    <QueryClientProvider client={client}>
      <SparkProvider
        value={{ appId: APP_ID, kind: "static", sparkAppId: APP_ID, attempt: null, source: null, application: null, resolving: false }}
      >
        <RouterProvider router={router} />
      </SparkProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SqlPage over the captured sql-cache-union payload", () => {
  it("opens newest-first like the legacy UI and toggles through that default", async () => {
    stubApi({ [`spark/${APP_ID}/sql`]: SQL });
    const { container, router } = renderSqlTab(null, "", "attempt-2");

    const header = await screen.findByRole("columnheader", { name: /ID/ });
    const idColumn = () =>
      [...container.querySelectorAll('[data-burrow-table="spark-sql"] [data-yf="spark.sql.id"]')].map((el) => el.getAttribute("data-yv"));

    // Spark's REST list is ascending; the legacy tab (DataTables `ID ▾`) renders it newest-first, and that order is the
    // table's default, so the URL carries no sort.
    await waitFor(() => expect(idColumn()).toEqual(["7", "6", "5", "4", "3", "2", "1", "0"]));
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(router.state.location.search).toEqual({});

    // one click asks for ascending, explicitly
    (header.querySelector("button") as HTMLButtonElement).click();
    await waitFor(() => expect(router.state.location.search).toEqual({ sort: "id", dir: "asc" }));
    await waitFor(() => expect(idColumn()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]));

    // the legacy cycle has no "unsorted" step (DataTables `asSorting: ['asc','desc']`): the second click flips back,
    // and the URL now names the default order explicitly
    (header.querySelector("button") as HTMLButtonElement).click();
    await waitFor(() => expect(router.state.location.search).toEqual({ sort: "id", dir: "desc" }));
    await waitFor(() => expect(idColumn()).toEqual(["7", "6", "5", "4", "3", "2", "1", "0"]));
    fireEvent.click(container.querySelector('[data-burrow-table="spark-sql"] [data-yv="7"]')!);
    await waitFor(() => expect(router.state.location.pathname).toContain("/spark/sql/7"));
  });
  it("carries the selected attempt when activating an SQL execution row", async () => {
    stubApi({ [`spark/${APP_ID}/sql`]: SQL });
    const { container, router } = renderSqlTab(null, "", "attempt-2");
    await screen.findByRole("table", { name: "Spark SQL executions" });
    await waitFor(() =>
      expect(container.querySelector('[data-burrow-table="spark-sql"] [data-yf="spark.sql.description"]')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('[data-burrow-table="spark-sql"] [data-yf="spark.sql.description"]')!);
    await waitFor(() => expect(router.state.location.pathname).toContain("/spark/sql/7"));
    expect(router.state.location.search).toEqual({ attempt: "attempt-2" });
  });

  it("omits the selected attempt when activating an SQL execution row without one", async () => {
    stubApi({ [`spark/${APP_ID}/sql`]: SQL });
    const { container, router } = renderSqlTab();
    await screen.findByRole("table", { name: "Spark SQL executions" });
    const description = await waitFor(() => {
      const cell = container.querySelector('[data-burrow-table="spark-sql"] [data-yf="spark.sql.description"]');
      expect(cell).not.toBeNull();
      return cell!;
    });
    fireEvent.click(description);
    await waitFor(() => expect(router.state.location.pathname).toContain("/spark/sql/7"));
    expect(router.state.location.search).toEqual({});
  });

  it("renders SQL executions supplied by the Spark 2.4 compatibility adapter", async () => {
    stubApi({
      [`spark/${APP_ID}/sql`]: [
        {
          id: 7,
          status: "COMPLETED",
          description: "select k, sum(v) from t group by k",
          submissionTime: "1791822000000",
          completionTime: "1791822000600",
          duration: 600,
          successJobIds: [4],
          runningJobIds: [],
          failedJobIds: [],
        },
      ],
    });
    renderSqlTab({ id: APP_ID, attempts: [{ appSparkVersion: "2.4.0" }] });

    expect(await screen.findByText("select k, sum(v) from t group by k")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("filters SQL executions, selects a page size, and exports the visible fields", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:spark-sql-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    stubApi({ [`spark/${APP_ID}/sql`]: SQL });
    const { container, router } = renderSqlTab();
    await screen.findByRole("table", { name: "Spark SQL executions" });

    const search = screen.getByRole("searchbox", { name: "Filter SQL executions" });
    fireEvent.change(search, { target: { value: "union" } });
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBe("union"));
    expect(container.querySelector('[data-burrow-table="spark-sql"]')?.getAttribute("data-burrow-rows")).toBe("3");

    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    const durationButton = screen
      .getByRole("table", { name: "Spark SQL executions" })
      .querySelector<HTMLElement>('[data-col="duration"] button');
    expect(durationButton).toBeTruthy();
    fireEvent.click(durationButton!);
    await waitFor(() => expect((router.state.location.search as Record<string, unknown>).sort).toBe("duration"));
    await waitFor(() => expect((router.state.location.search as { sort?: string }).sort).toBe("duration"));

    fireEvent.click(screen.getByRole("combobox", { name: "SQL status filter" }));
    const completed = await screen.findByRole("option", { name: "Completed" });
    fireEvent.pointerDown(completed, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(completed, { button: 0, pointerType: "mouse" });
    fireEvent.click(completed);
    await waitFor(() => expect((router.state.location.search as { status?: string }).status).toBe("COMPLETED"));

    fireEvent.click(await screen.findByRole("combobox", { name: "Rows per page" }));
    const pageSize = await screen.findByRole("option", { name: "25 / page" });
    fireEvent.pointerDown(pageSize, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(pageSize, { button: 0, pointerType: "mouse" });
    fireEvent.click(pageSize);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ size: "25", page: "0" }));
    expect((await screen.findByRole("button", { name: /Next/ })).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clickAnchor).toHaveBeenCalledOnce();
  });

  it("keeps a Spark 3.3.2 SQL 404 classified as an ordinary missing resource", async () => {
    stubApi({ [`spark/${APP_ID}/sql`]: new Response(`unknown app local-test, attempt sql`, { status: 404 }) });
    renderSqlTab({ id: APP_ID, attempts: [{ appSparkVersion: "3.3.2" }] });

    expect(await screen.findByRole("heading", { name: "Not found in the Spark source" })).toBeTruthy();
  });

  it("paginates SQL executions", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => {
      const seed = (SQL as { id: number; errorMessage?: string }[])[index % 8]!;
      return { ...seed, id: index, errorMessage: index === 0 ? "Execution failed after the stage was aborted." : "" };
    });
    stubApi({ [`spark/${APP_ID}/sql`]: rows });
    const { router } = renderSqlTab(null, "?size=25");
    await waitFor(() => expect(screen.getByRole("button", { name: /Next/ }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ size: 25, page: "1" }));
    await screen.findByRole("table", { name: "Spark SQL executions" });
    fireEvent.click(screen.getByRole("button", { name: /Prev/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ size: 25, page: "0" }));
  });

  it("links SQL error messages and shows the empty-list state", async () => {
    const failure = "Execution failed after the stage was aborted.";
    const rows = [...(SQL as { id: number; errorMessage?: string }[])];
    rows[0] = { ...rows[0]!, errorMessage: failure };
    stubApi({ [`spark/${APP_ID}/sql`]: rows });
    renderSqlTab();
    expect(await screen.findByRole("link", { name: failure })).toBeTruthy();

    cleanup();
    stubApi({ [`spark/${APP_ID}/sql`]: [] });
    renderSqlTab();
    expect(await screen.findByRole("heading", { name: "No SQL executions" })).toBeTruthy();
  });

  it("keeps stale SQL rows visible and supports fatal-load retry", async () => {
    stubApi({ [`spark/${APP_ID}/sql`]: SQL });
    const stale = renderSqlTab();
    await screen.findByRole("table", { name: "Spark SQL executions" });
    const key = sp.sql(APP_ID, { kind: "static", attempt: null }).queryKey;
    const staleQuery = stale.client.getQueryCache().find({ queryKey: key })!;
    act(() => {
      staleQuery.setState({
        ...staleQuery.state,
        status: "error",
        error: new Error("SQL refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: staleQuery.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByText("Could not refresh the SQL execution list")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    stale.unmount();

    const fatal = renderSqlTab();
    await screen.findByRole("table", { name: "Spark SQL executions" });
    const failedQuery = fatal.client.getQueryCache().find({ queryKey: key })!;
    act(() => {
      failedQuery.setState({
        ...failedQuery.state,
        data: undefined,
        status: "error",
        error: new Error("SQL list unavailable"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: failedQuery.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByRole("heading", { name: "Spark request failed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("renders an SQL execution's physical plan, job links, raw-plan disclosure, and derived stage links", async () => {
    const { router } = renderSqlDetail();
    expect(await screen.findByRole("heading", { name: /^SQL execution 1/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "All SQL executions" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Plan DAG of SQL execution 1" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Raw plan of SQL execution 1" })).toBeTruthy();
    const disclosure = screen.getByText("Raw plan tree").closest("details")!;
    fireEvent.click(screen.getByText("Raw plan tree"));
    await waitFor(() => expect(disclosure.open).toBe(false));
    fireEvent.click(screen.getByText("Raw plan tree"));
    await waitFor(() => expect(disclosure.open).toBe(true));
    expect(screen.getByText("Succeeded")).toBeTruthy();
    const search = screen.getByRole("searchbox", { name: "Find in the SQL plan" });
    fireEvent.change(search, { target: { value: "SortMergeJoin" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("SortMergeJoin"));
  });

  it("keeps SQL detail and jobs visible during refresh failures and retries both", async () => {
    stubApi({ [`spark/${APP_ID}/sql/1`]: SQL_DETAIL, [`spark/${APP_ID}/jobs`]: SQL_JOBS });
    renderSqlDetail({ execution: "stale", jobs: "stale" });
    expect(await screen.findByRole("heading", { name: /^SQL execution 1/ })).toBeTruthy();
    expect(await screen.findByText(/Could not refresh SQL execution 1/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry now" })[0]!);

    expect(await screen.findByText(/Could not refresh the jobs for this SQL execution/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry now" })[0]!);
  });

  it("shows fatal and missing SQL execution states and retries stage resolution", async () => {
    stubApi({
      [`spark/${APP_ID}/sql/1`]: new Response("unavailable", { status: 503 }),
      [`spark/${APP_ID}/jobs`]: new Response("unavailable", { status: 503 }),
    });
    const failed = renderSqlDetail({ execution: "error" });
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    failed.unmount();
    cleanup();

    const missing = renderSqlDetail({ execution: "missing", disableFetch: true });
    expect(await screen.findByRole("heading", { name: "SQL execution 1 is not in this application" })).toBeTruthy();
    missing.unmount();
    cleanup();

    renderSqlDetail({ jobs: "error" });
    expect(await screen.findByText("Could not resolve stage ids")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("handles sparse SQL rows and clears every active list filter", async () => {
    const longError = `Execution failed: ${"x".repeat(70)}`;
    stubApi({
      [`spark/${APP_ID}/sql`]: [
        {
          id: 9,
          status: null,
          description: null,
          submissionTime: null,
          completionTime: null,
          duration: null,
          runningJobIds: null,
          successJobIds: null,
          failedJobIds: null,
          errorMessage: longError,
        },
        {
          id: 10,
          status: "RUNNING",
          description: "Second SQL execution",
          submissionTime: "1791822000000",
          runningJobIds: [],
          successJobIds: [3],
          failedJobIds: [],
          errorMessage: "",
        },
      ],
    });
    const { router } = renderSqlTab(null, "?status=FAILED&q=missing");
    await screen.findByRole("table", { name: "Spark SQL executions" });

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter SQL executions" }), { target: { value: "" } });
    await waitFor(() => expect((router.state.location.search as Record<string, unknown>).q).toBeUndefined());
    fireEvent.click(screen.getByRole("combobox", { name: "SQL status filter" }));
    const allStatuses = await screen.findByRole("option", { name: "All statuses" });
    fireEvent.pointerDown(allStatuses, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(allStatuses, { button: 0, pointerType: "mouse" });
    fireEvent.click(allStatuses);
    await waitFor(() => expect((router.state.location.search as Record<string, unknown>).status).toBeUndefined());

    expect(await screen.findByText("UNKNOWN")).toBeTruthy();
    expect(screen.getByRole("link", { name: longError })).toBeTruthy();
    const durationButton = screen
      .getByRole("table", { name: "Spark SQL executions" })
      .querySelector<HTMLElement>('[data-col="duration"] button');
    expect(durationButton).toBeTruthy();
    fireEvent.click(durationButton!);

    fireEvent.click(screen.getByRole("combobox", { name: "Rows per page" }));
    const pageSize = await screen.findByRole("option", { name: "25 / page" });
    fireEvent.pointerDown(pageSize, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(pageSize, { button: 0, pointerType: "mouse" });
    fireEvent.click(pageSize);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ size: "25", page: "0" }));

    fireEvent.click(await screen.findByRole("combobox", { name: "Rows per page" }));
    const allRows = await screen.findByRole("option", { name: "All rows" });
    fireEvent.pointerDown(allRows, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(allRows, { button: 0, pointerType: "mouse" });
    fireEvent.click(allRows);
    await waitFor(() => expect((router.state.location.search as Record<string, unknown>).size).toBeUndefined());
  });
});
