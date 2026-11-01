import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

window.__BURROW_PARITY__ = true;

const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { schedulerQuery, queueAppsQuery, schedulerActivitiesQuery, schedulerConfQuery, nodesQuery } = await import(
  "~/api/queries/scheduler"
);
const { QueuePage } = await import("./QueuePage");
const { queueSearchSchema } = await import("./search");

const FIXTURES = resolve(process.cwd(), "../fixtures/rm/scheduler/capacity");
const read = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as never;
const queue = "root.default";

function renderQueue(searchText = "", seedScheduler = true, queueName = queue) {
  const root = createRootRoute();
  const scheduler = createRoute({ getParentRoute: () => root, path: "/scheduler", component: () => null });
  patch = vi.fn();
  const initialSearch = queueSearchSchema.parse(Object.fromEntries(new URLSearchParams(searchText)));
  function Harness() {
    const [search, setSearch] = useState(initialSearch);
    const update = (value: Partial<typeof search>) => {
      patch(value);
      setSearch((current) => ({ ...current, ...value }));
    };
    return <QueuePage queue={queueName} search={search} patch={update} />;
  }
  const queueRoute = createRoute({
    getParentRoute: () => root,
    path: "/scheduler/detail",
    component: Harness,
  });
  const router = createRouter({
    routeTree: root.addChildren([scheduler, queueRoute]),
    history: createMemoryHistory({ initialEntries: ["/scheduler/detail"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, refetchOnMount: false } } });
  if (seedScheduler) client.setQueryData(schedulerQuery().queryKey, read("scheduler.json"));
  client.setQueryData(
    queueAppsQuery(queueName, ["RUNNING", "ACCEPTED"]).queryKey,
    JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/overview/apps-active.json"), "utf8")) as never,
  );
  client.setQueryData(schedulerActivitiesQuery({ nodeId: undefined, groupBy: undefined }).queryKey, read("scheduler-activities.json"));
  client.setQueryData(nodesQuery().queryKey, read("nodes.json"));
  client.setQueryData(schedulerConfQuery("capacityScheduler").queryKey, read("scheduler-conf.json"));
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

let patch = vi.fn();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  patch = vi.fn();
});

async function sortColumn(label: string, column: string) {
  const table = await screen.findByRole("table", { name: label });
  const sortButton = table.querySelector<HTMLElement>(`[data-col="${column}"] button`);
  expect(sortButton).toBeTruthy();
  fireEvent.click(sortButton!);
  return table;
}

describe("QueuePage controls", () => {
  it("sorts the users, applications, partitions, activities, and configuration tables", async () => {
    renderQueue();
    await sortColumn("Queue users", "username");
    await waitFor(() => expect(patch).toHaveBeenCalledWith(expect.objectContaining({ usersSort: expect.any(String) })));

    fireEvent.click(screen.getByRole("tab", { name: "Applications" }));
    await sortColumn("Applications in this queue", "id");
    await waitFor(() => expect(patch).toHaveBeenCalledWith(expect.objectContaining({ appsSort: expect.any(String) })));

    fireEvent.click(screen.getByRole("tab", { name: "Partitions" }));
    await sortColumn(`Node-label partitions of ${queue}`, "partition");
    await waitFor(() => expect(patch).toHaveBeenCalledWith(expect.objectContaining({ partSort: expect.any(String) })));

    fireEvent.click(screen.getByRole("tab", { name: "Activities" }));
    const activities = await sortColumn("Scheduler allocation activities", "container");
    await waitFor(() => expect(patch).toHaveBeenCalledWith(expect.objectContaining({ actSort: expect.any(String) })));
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Partition" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(expect.objectContaining({ actHide: expect.any(String) })));
    expect(activities).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    await sortColumn("Scheduler configuration", "name");
    await waitFor(() => expect(patch).toHaveBeenCalledWith(expect.objectContaining({ confSort: expect.any(String) })));
  });

  it("shows scheduler loading, failure, and removed-queue states", async () => {
    const pending = renderQueue("", false);
    expect(await screen.findByText("Loading this queue from the scheduler tree…")).toBeTruthy();
    pending.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "retry unavailable" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const failed = renderQueue("", false);
    expect(await screen.findByText("Loading this queue from the scheduler tree…")).toBeTruthy();
    const scheduler = failed.client.getQueryCache().find({ queryKey: schedulerQuery().queryKey })!;
    act(() => {
      scheduler.setState({
        ...scheduler.state,
        data: undefined,
        status: "error",
        error: new Error("scheduler unavailable"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: scheduler.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByRole("heading", { name: "Request failed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    failed.unmount();

    const missing = renderQueue("", true, "root.removed");
    expect(await screen.findByText("No queue named root.removed in this scheduler")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the scheduler tree" }));
    await waitFor(() => expect(missing.router.state.location.pathname).toBe("/scheduler"));
  });
});
