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

function renderQueue(
  searchText = "",
  seedScheduler = true,
  queueName = queue,
  schedulerKind: "capacity" | "fair" = "capacity",
  schedulerData?: unknown,
) {
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
  if (seedScheduler) {
    const schedulerPath = resolve(process.cwd(), `../fixtures/rm/scheduler/${schedulerKind}/scheduler.json`);
    client.setQueryData(schedulerQuery().queryKey, (schedulerData ?? JSON.parse(readFileSync(schedulerPath, "utf8"))) as never);
  }
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

  it("shows Fair-specific queue facts and the unsupported users, partitions, and configuration sections", async () => {
    renderQueue("tab=users", true, "root.default", "fair");
    expect(await screen.findByRole("heading", { name: "root.default" })).toBeTruthy();
    expect(screen.getByText("preemptable")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /root\.default: .*fair share/ })).toBeTruthy();
    expect(screen.getByText("The Fair scheduler has no per-user table")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Partitions" }));
    expect(await screen.findByText("No partitions in this scheduler shape")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    expect(await screen.findByText("This scheduler has no retrievable configuration")).toBeTruthy();
    expect(screen.getByText(/FairScheduler returns HTTP 400/)).toBeTruthy();
  });

  it("handles a fair queue with zero shares and optional resource reports omitted", async () => {
    const payload = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/scheduler/fair/scheduler.json"), "utf8")) as {
      scheduler: { schedulerInfo: { rootQueue: { childQueues: { queue: Record<string, unknown>[] } } } };
    };
    const queueData = payload.scheduler.schedulerInfo.rootQueue.childQueues.queue.find(
      (candidate) => candidate.queueName === "root.default",
    )!;
    for (const key of ["usedResources", "minResources", "maxResources", "fairResources"]) {
      const value = queueData[key] as Record<string, unknown>;
      queueData[key] = { ...value, memory: 0 };
    }
    queueData.amUsedResources = undefined;
    queueData.amMaxResources = undefined;
    queueData.reservedResources = undefined;
    queueData.maxContainerAllocation = undefined;

    renderQueue("", true, "root.default", "fair", payload);
    expect(await screen.findByRole("heading", { name: "root.default" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /root\.default: .*fair share/ })).toBeTruthy();
    expect(screen.getByText("Used of fair")).toBeTruthy();
    expect(screen.getByText("Used of minimum")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders parent queue status without leaf-only details in both scheduler families", async () => {
    const capacityPayload = read("scheduler.json") as {
      scheduler: { schedulerInfo: { queues: { queue: Record<string, unknown>[] } } };
    };
    capacityPayload.scheduler.schedulerInfo.queues.queue[2]!.orderingPolicyInfo = undefined;
    capacityPayload.scheduler.schedulerInfo.queues.queue[2]!.nodeLabels = undefined;
    const capacity = renderQueue("", true, "root.etl", "capacity", capacityPayload);
    expect(await screen.findByRole("heading", { name: "root.etl" })).toBeTruthy();
    expect(screen.getByText(/Parent queue: the legacy page renders no status block for parents/)).toBeTruthy();
    expect(screen.queryByText("Num Schedulable Applications")).toBeNull();
    expect(document.querySelector('[data-yf="queue.orderingPolicyInfo"]')?.textContent).toBe("—");
    capacity.unmount();

    renderQueue("", true, "root", "fair");
    expect(await screen.findByRole("heading", { name: "root" })).toBeTruthy();
    expect(screen.getByText("parent queues have no preemptable field")).toBeTruthy();
    expect(screen.queryByText("Demand Resources")).toBeNull();
  });

  it("shows stale and fatal queue-app errors and writes activity filters back to search", async () => {
    const stale = renderQueue("tab=apps");
    const staleApps = stale.client.getQueryCache().find({ queryKey: queueAppsQuery(queue, ["RUNNING", "ACCEPTED"]).queryKey })!;
    act(() => {
      staleApps.setState({
        ...staleApps.state,
        status: "error",
        error: new Error("refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: staleApps.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("refresh failed")).toBeTruthy();
    stale.unmount();

    const failed = renderQueue("tab=apps");
    const failedApps = failed.client.getQueryCache().find({ queryKey: queueAppsQuery(queue, ["RUNNING", "ACCEPTED"]).queryKey })!;
    act(() => {
      failedApps.setState({
        ...failedApps.state,
        data: undefined,
        status: "error",
        error: new Error("initial request failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: failedApps.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByRole("heading", { name: "Request failed" })).toBeTruthy();
    failed.unmount();

    const activities = renderQueue("tab=activities&nodeId=node-1&groupBy=DIAGNOSTIC");
    fireEvent.click(await screen.findByRole("button", { name: "Detailed" }));
    expect(patch).toHaveBeenCalledWith({ groupBy: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Group by diagnostic" }));
    expect(patch).toHaveBeenCalledWith({ groupBy: "DIAGNOSTIC" });

    fireEvent.click(screen.getByRole("combobox", { name: "NodeManager" }));
    fireEvent.click(await screen.findByRole("option", { name: "latest (any node)" }));
    expect(patch).toHaveBeenCalledWith({ nodeId: undefined });
    activities.unmount();
  });

  it("keeps stale activity and configuration data visible, then shows fatal errors without cached data", async () => {
    const activities = renderQueue("tab=activities");
    const activityQuery = activities.client
      .getQueryCache()
      .find({ queryKey: schedulerActivitiesQuery({ nodeId: undefined, groupBy: undefined }).queryKey })!;
    act(() => {
      activityQuery.setState({
        ...activityQuery.state,
        status: "error",
        error: new Error("activity refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: activityQuery.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByText("activity refresh failed")).toBeTruthy();
    act(() => {
      activityQuery.setState({
        ...activityQuery.state,
        data: undefined,
        status: "error",
        error: new Error("activity request failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: activityQuery.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByText("activity request failed")).toBeTruthy();
    activities.unmount();

    const configuration = renderQueue("tab=conf");
    const confQuery = configuration.client.getQueryCache().find({ queryKey: schedulerConfQuery("capacityScheduler").queryKey })!;
    act(() => {
      confQuery.setState({
        ...confQuery.state,
        status: "error",
        error: new Error("configuration refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: confQuery.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByText("configuration refresh failed")).toBeTruthy();
    act(() => {
      confQuery.setState({
        ...confQuery.state,
        data: undefined,
        status: "error",
        error: new Error("configuration request failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: confQuery.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByText("configuration request failed")).toBeTruthy();
  });

  it("selects a NodeManager filter from the activities tab", async () => {
    renderQueue("tab=activities");
    fireEvent.click(await screen.findByRole("combobox", { name: "NodeManager" }));
    const node = await screen.findByRole("option", { name: "127.0.0.3:8041" });
    fireEvent.pointerDown(node, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(node, { button: 0, pointerType: "mouse" });
    fireEvent.click(node);
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ nodeId: "127.0.0.3:8041" }));
  });
});
