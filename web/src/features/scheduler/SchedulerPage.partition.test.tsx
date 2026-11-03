import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

window.__BURROW_PARITY__ = true;

vi.mock("~/ui/select", () => ({
  Select: ({ label, onValueChange }: { label: string; onValueChange: (value: string | null) => void }) => (
    <button type="button" onClick={() => onValueChange(null)}>
      Clear {label}
    </button>
  ),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { schedulerQuery } = await import("~/api/queries/scheduler");
const { SchedulerPage } = await import("./SchedulerPage");

afterEach(cleanup);

describe("SchedulerPage partition selection", () => {
  it("resets the partition when the select reports a cleared value", async () => {
    const payload = JSON.parse(readFileSync("../fixtures/rm/scheduler/capacity/scheduler.json", "utf8")) as never;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false, staleTime: Infinity } } });
    client.setQueryData(schedulerQuery().queryKey, payload);
    client.setQueryDefaults(q.metrics().queryKey, { enabled: false });

    const patch = vi.fn();
    const root = createRootRoute();
    const route = createRoute({
      getParentRoute: () => root,
      path: "/scheduler",
      component: () => <SchedulerPage search={{}} patch={patch} />,
    });
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/scheduler"] }) });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Queue headroom")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear Partition" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear Partition" }));
    expect(patch).toHaveBeenCalledWith({ partition: "" });
  });
});
