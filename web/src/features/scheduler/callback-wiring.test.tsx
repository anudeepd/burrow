import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

window.__BURROW_PARITY__ = true;

vi.mock("./QueueTree", () => ({
  QueueTree: ({ onSortingChange }: { onSortingChange: (sorting: { id: string; desc: boolean }[]) => void }) => (
    <button type="button" onClick={() => onSortingChange([])}>
      Trigger queue sorting callback
    </button>
  ),
}));
vi.mock("./ConfTable", () => ({
  ConfTable: ({ onShowAllChange }: { onShowAllChange: (showAll: boolean) => void }) => (
    <button type="button" onClick={() => onShowAllChange(false)}>
      Trigger configuration scope callback
    </button>
  ),
}));

const { cleanup, render, screen, fireEvent } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { nodesQuery, schedulerConfQuery, schedulerQuery } = await import("~/api/queries/scheduler");
const { SchedulerPage } = await import("./SchedulerPage");

afterEach(cleanup);

const readFixture = (path: string) => JSON.parse(readFileSync(path, "utf8")) as never;

function renderScheduler(tab: "queues" | "conf") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false, staleTime: Infinity } } });
  client.setQueryData(schedulerQuery().queryKey, readFixture("../fixtures/rm/scheduler/capacity/scheduler.json"));
  client.setQueryData(q.metrics().queryKey, readFixture("../fixtures/rm/overview/metrics.json"));
  client.setQueryData(nodesQuery().queryKey, readFixture("../fixtures/rm/nodes/nodes.json"));
  client.setQueryData(
    schedulerConfQuery("capacityScheduler").queryKey,
    readFixture("../fixtures/rm/scheduler/capacity/scheduler-conf.json"),
  );
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/scheduler",
    component: () => <SchedulerPage search={{ tab }} patch={vi.fn()} />,
  });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/scheduler"] }) });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe("scheduler child callback wiring", () => {
  it("accepts the queue table's disabled column-sort callback", async () => {
    renderScheduler("queues");
    fireEvent.click(await screen.findByRole("button", { name: "Trigger queue sorting callback" }));
    expect(screen.getByRole("heading", { name: "Scheduler" })).toBeTruthy();
  });

  it("accepts the configuration scope callback", async () => {
    renderScheduler("conf");
    fireEvent.click(await screen.findByRole("button", { name: "Trigger configuration scope callback" }));
    expect(screen.getByRole("heading", { name: "Scheduler" })).toBeTruthy();
  });
});
