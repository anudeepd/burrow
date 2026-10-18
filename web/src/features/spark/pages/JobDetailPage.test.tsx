/** URL integration coverage for the Spark job DAG's expansion state. */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

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
const JOB = JSON.parse(readFileSync(`${FIXTURE_ROOT}/rest/final.job-2.json`, "utf8")) as never;
const STAGES = JSON.parse(readFileSync(`${FIXTURE_ROOT}/rest/final.stages.details.json`, "utf8")) as never;
const DAG = JSON.parse(readFileSync(`${FIXTURE_ROOT}/dag-job-2.json`, "utf8")) as never;

function renderJobPage(initialUrl: string) {
  const rootRoute = createRootRoute();
  const appRoute = createRoute({ getParentRoute: () => rootRoute, path: "/apps/$appId" });
  const sparkRoute = createRoute({ getParentRoute: () => appRoute, path: "spark" });
  const jobRoute = createRoute({
    getParentRoute: () => sparkRoute,
    path: "jobs/$jobId",
    validateSearch: sparkSearch,
    component: () => <JobDetailPage />,
  });
  const jobsRoute = createRoute({ getParentRoute: () => sparkRoute, path: "jobs/", component: () => null });
  const stageRoute = createRoute({ getParentRoute: () => sparkRoute, path: "stages/$stageId/$attemptId", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute.addChildren([sparkRoute.addChildren([jobRoute, jobsRoute, stageRoute])])]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(sp.job(APP_ID, JOB_ID, "static", null).queryKey, JOB);
  client.setQueryData(sp.stages(APP_ID, { kind: "static", attempt: null }).queryKey, STAGES);
  client.setQueryData(sp.dagJob(APP_ID, JOB_ID, null).queryKey, DAG);

  const view = render(
    <QueryClientProvider client={client}>
      <SparkProvider
        value={{ appId: APP_ID, kind: "static", sparkAppId: APP_ID, attempt: null, source: null, application: null, resolving: false }}
      >
        <RouterProvider router={router} />
      </SparkProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

afterEach(() => cleanup());

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
});
