import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

window.__BURROW_PARITY__ = true;

vi.mock("./model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model")>()),
  buildTree: vi.fn(() => null),
}));

const { render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { schedulerQuery } = await import("~/api/queries/scheduler");
const { SchedulerPage } = await import("./SchedulerPage");

const readFixture = (path: string) => JSON.parse(readFileSync(path, "utf8")) as never;

describe("SchedulerPage defensive root state", () => {
  it("explains a recognized capacity payload when tree construction yields no root", async () => {
    const scheduler = readFixture("../fixtures/rm/scheduler/capacity/scheduler.json");
    const metrics = readFixture("../fixtures/rm/overview/metrics.json");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false, staleTime: Infinity } } });
    client.setQueryData(schedulerQuery().queryKey, scheduler);
    client.setQueryData(q.metrics().queryKey, metrics);
    const root = createRootRoute();
    const route = createRoute({
      getParentRoute: () => root,
      path: "/scheduler",
      component: () => <SchedulerPage search={{}} patch={vi.fn()} />,
    });
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/scheduler"] }) });

    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "The capacity payload has no queue tree" })).toBeTruthy();
    expect(screen.getByText(/without a root queue/)).toBeTruthy();
  });
});
