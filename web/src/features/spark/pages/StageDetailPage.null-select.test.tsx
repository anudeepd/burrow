import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("~/ui/select", () => ({
  Select: ({ label, onValueChange }: { label: string; onValueChange: (value: string | null) => void }) => (
    <button type="button" aria-label={label} onClick={() => onValueChange(null)}>
      Clear {label}
    </button>
  ),
}));

window.__BURROW_PARITY__ = true;

const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { StageDetailPage } = await import("./StageDetailPage");
const { SparkProvider } = await import("../ui/context");
const { sp } = await import("../data/queries");
const { sparkSearch } = await import("../data/search");

const APP_ID = "application_1791010984040_0033";
const FIXTURE = resolve(process.cwd(), "../fixtures/spark/3.5.9/dstream/rest");
const readJson = (name: string) => JSON.parse(readFileSync(`${FIXTURE}/${name}`, "utf8")) as Record<string, unknown>;
const stage = readJson("final.stage-0-0.withSummaries.json");
const stages = readJson("final.stage-0.json");
const tasks = readJson("final.stage-0-0.taskList.json");

afterEach(cleanup);

it("ignores a cleared nullable stage-attempt selection", async () => {
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, path: "/apps/$appId" });
  const spark = createRoute({ getParentRoute: () => app, path: "spark" });
  const page = createRoute({
    getParentRoute: () => spark,
    path: "stages/$stageId/$attemptId",
    validateSearch: sparkSearch,
    component: () => <StageDetailPage />,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([spark.addChildren([page])])]),
    history: createMemoryHistory({ initialEntries: [`/apps/${APP_ID}/spark/stages/0/0`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  const options = { details: true, withSummaries: true, quantiles: [0.05, 0.25, 0.5, 0.75, 0.95], kind: "static" as const, attempt: null };
  client.setQueryData(sp.stageAttempt(APP_ID, 0, 0, options).queryKey, stage);
  client.setQueryData(sp.stageAttempts(APP_ID, 0, "static", null).queryKey, [stages[0], { ...stages[0], attemptId: 1 }]);
  client.setQueryData(sp.allTasks(APP_ID, 0, 0, "static", null).queryKey, tasks);
  client.setQueryData(sp.dagStage(APP_ID, 0, 0, null).queryKey, { kind: "stage", granularity: "rdd", stages: [], edges: [] });

  const view = render(
    <QueryClientProvider client={client}>
      <SparkProvider
        value={{ appId: APP_ID, kind: "static", sparkAppId: APP_ID, attempt: null, source: null, application: null, resolving: false }}
      >
        <RouterProvider router={router} />
      </SparkProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: /Stage 0 · attempt 0/ });
  const pathname = router.state.location.pathname;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stage attempt" })));
  expect(router.state.location.pathname).toBe(pathname);
  view.unmount();
});
