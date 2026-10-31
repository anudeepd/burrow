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

const { render, cleanup, screen, waitFor } = await import("@testing-library/react");
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
function renderSqlTab(application: { id: string; attempts: { appSparkVersion: string; attemptId?: string }[] } | null = null) {
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
    history: createMemoryHistory({ initialEntries: [`/apps/${APP_ID}/spark/sql`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SparkProvider
        value={{ appId: APP_ID, kind: "static", sparkAppId: APP_ID, attempt: null, source: null, application, resolving: false }}
      >
        <RouterProvider router={router} />
      </SparkProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

function renderSqlDetail() {
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(sp.sqlExecution(APP_ID, 1, { kind: "static", attempt: null }).queryKey, SQL_DETAIL as never);
  client.setQueryData(sp.jobs(APP_ID, { kind: "static", attempt: null }).queryKey, SQL_JOBS as never);
  return render(
    <QueryClientProvider client={client}>
      <SparkProvider
        value={{ appId: APP_ID, kind: "static", sparkAppId: APP_ID, attempt: null, source: null, application: null, resolving: false }}
      >
        <RouterProvider router={router} />
      </SparkProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SqlPage over the captured sql-cache-union payload", () => {
  it("opens newest-first like the legacy UI and toggles through that default", async () => {
    stubApi({ [`spark/${APP_ID}/sql`]: SQL });
    const { container, router } = renderSqlTab();

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

  it("keeps a Spark 3.3.2 SQL 404 classified as an ordinary missing resource", async () => {
    stubApi({ [`spark/${APP_ID}/sql`]: new Response(`unknown app local-test, attempt sql`, { status: 404 }) });
    renderSqlTab({ id: APP_ID, attempts: [{ appSparkVersion: "3.3.2" }] });

    expect(await screen.findByRole("heading", { name: "Not found in the Spark source" })).toBeTruthy();
  });

  it("renders an SQL execution's physical plan, job links, and derived stage links", async () => {
    renderSqlDetail();
    expect(await screen.findByRole("heading", { name: /SQL execution 1/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "All SQL executions" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Plan DAG of SQL execution 1" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Raw plan of SQL execution 1" })).toBeTruthy();
    expect(screen.getByText("Raw plan tree")).toBeTruthy();
    expect(screen.getByText("Succeeded")).toBeTruthy();
  });
});
