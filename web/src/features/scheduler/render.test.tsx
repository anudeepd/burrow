/**
 * Integration render tests for the Scheduler routes, driven by the REAL captured fixtures.
 *
 * Parity mode is on (`window.__BURROW_PARITY__`), which the shared `DataTable` honours by rendering every row instead of a
 * virtual window — the only way to assert row content in jsdom, and the same mode the parity harness uses.
 *
 * The components are imported dynamically AFTER the flag is set, because `~/state/parity` reads it at module scope.
 */
import { readFileSync } from "node:fs";
import { useState } from "react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `~/state/parity` decides parity ONCE at module scope, so the flag has to be set before that module is evaluated —
// a genuine module-load-order boundary that static imports cannot express.
window.__BURROW_PARITY__ = true;

// jsdom gap: Base UI's ScrollArea asks a scroll viewport for its running animations.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

const { render, cleanup, fireEvent, screen, waitFor, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { SchedulerPage } = await import("./SchedulerPage");
const { QueuePage } = await import("./QueuePage");
const { QueueTreemap, squarify } = await import("./Treemap");
type SchedulerSearch = import("./search").SchedulerSearch;

const fixture = (rel: string): unknown => JSON.parse(readFileSync(`../fixtures/rm/scheduler/${rel}`, "utf8"));
const other = (rel: string): unknown => JSON.parse(readFileSync(`../fixtures/rm/${rel}`, "utf8"));

const CAPACITY = {
  "yarn/scheduler": fixture("capacity/scheduler.json"),
  "yarn/scheduler/activities": fixture("capacity/scheduler-activities.json"),
  "yarn/scheduler-conf": fixture("capacity/scheduler-conf.json"),
  "yarn/scheduler-overview": other("overview/scheduler-overview.json"),
  "rm/conf": other("tools/conf.json"),
  "rm/jmx": fixture("capacity/jmx-queuemetrics-root.json"),
  "yarn/nodes": other("nodes/nodes.json"),
  "yarn/metrics": other("overview/metrics.json"),
  "yarn/apps": { apps: { app: [] } },
};

function stubApi(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path =
      url
        .replace(/^https?:\/\/[^/]+/, "")
        .replace(/^\/api\//, "")
        .split("?")[0] ?? "";
    if (!(path in routes)) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: `no stub for ${path}` } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { "content-type": "application/json", "x-burrow-api": "1", "x-burrow-cache": "miss" },
    });
  });
}

function renderAt(element: ReactElement, entries: string[], configure?: (client: InstanceType<typeof QueryClient>) => void) {
  const rootRoute = createRootRoute();
  const schedulerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/scheduler",
    component: () => element,
  });
  const queueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/scheduler/$queue",
    component: () => element,
  });
  const nodeDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/nodes/$nodeId", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([schedulerRoute, queueRoute, nodeDetailRoute]),
    history: createMemoryHistory({ initialEntries: entries }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  configure?.(client);
  return {
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}

const schedulerView = () => <SchedulerPage search={{}} patch={() => undefined} />;
function InteractiveScheduler() {
  const [search, setSearch] = useState<SchedulerSearch>({});
  return <SchedulerPage search={search} patch={(next) => setSearch((current) => ({ ...current, ...next }))} />;
}
function InteractiveQueue({ queue }: { queue: string }) {
  const [search, setSearch] = useState<import("./search").QueueSearch>({});
  return <QueuePage queue={queue} search={search} patch={(next) => setSearch((current) => ({ ...current, ...next }))} />;
}
const healthView = () => <SchedulerPage search={{ tab: "health" }} patch={() => undefined} />;
const queueView = (queue: string, search: import("./search").QueueSearch = {}) => (
  <QueuePage queue={queue} search={search} patch={() => undefined} />
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SchedulerPage over captured payloads", () => {
  it("lays out tall treemaps and follows a tile from the keyboard", async () => {
    const items = [
      { key: "root.large", value: 100, field: "queue.used", raw: 100, usedPct: 50, sub: "used" },
      { key: "root.medium", value: 60, field: "queue.used", raw: 60, usedPct: 30, sub: "used" },
      { key: "root.small", value: 20, field: "queue.used", raw: 20, usedPct: 10, sub: "used" },
    ];
    expect(squarify(items, 0, 0, 900, 1200)).toHaveLength(3);
    expect(squarify(items, 0, 0, 0, 1200)).toEqual([]);

    const { router } = renderAt(<QueueTreemap items={items} basis="capacity" height={1200} label="Keyboard queue map" />, ["/scheduler"]);
    const tile = await screen.findByRole("link", { name: /root\.large/ });
    fireEvent.keyDown(tile, { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/scheduler/root.large"));
  });

  it("capacity: renders the freeness tree, KPI strip and treemap without a single parity warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubApi(CAPACITY);
    const { container } = renderAt(schedulerView(), ["/scheduler"]);

    expect(await screen.findByRole("heading", { name: "Scheduler", level: 1 })).toBeTruthy();
    // wait for the tree (only rendered once the scheduler payload resolved)
    expect(await screen.findByText("Queue headroom")).toBeTruthy();
    expect(container.querySelector('[data-yf="scheduler.type"][data-yv="capacityScheduler"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="scheduler.queuePath"][data-yv="root"]')).toBeTruthy();

    // the KPI strip's three cluster-metric rows carry real values from the captured metrics payload
    expect(container.querySelector('[data-yf="cluster.metrics.rmSchedulerBusyPercent"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="scheduler.maximumAllocation.memory"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="scheduler.derived.schedulerName"][data-yv="Capacity Scheduler"]')).toBeTruthy();
    expect(
      container.querySelector('[data-yf="scheduler.derived.schedulingResourceTypes"][data-yv="[memory-mb (unit=Mi), vcores]"]'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More scheduler metrics" }));
    expect(screen.getByRole("button", { name: "Fewer metrics" })).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector('[data-yf="scheduler.derived.minAllocationText"]')?.textContent?.replace(/\s+/g, " ").trim()).toBe(
        "256 MiB · 1 vCore",
      );
      expect(container.querySelector('[data-yf="scheduler.derived.maxAllocationText"]')?.textContent?.replace(/\s+/g, " ").trim()).toBe(
        "3 GiB · 4 vCores",
      );
      expect(container.querySelector('[data-yf="scheduler.derived.maximumClusterPriority"][data-yv="10"]')).toBeTruthy();
    });

    // the tree renders every queue of the real payload, each keyed by its path
    const rowIds = [...container.querySelectorAll('[data-burrow-table="scheduler-capacity-tree"] [role="row"][data-ye]')].map(
      (el) => (el as HTMLElement).dataset.ye,
    );
    expect(rowIds).toContain("root");
    expect(rowIds).toContain("root.etl.ingest");
    expect(rowIds).toContain("root.etl.transform");

    // freeness is encoded on the bar with the raw partition percentage
    expect(container.querySelector('[data-yf="queue.capacities.queueCapacitiesByPartition.absoluteUsedCapacity"]')).toBeTruthy();
    // derived freeness ids are stamped
    expect(container.querySelector('[data-yf="queue.derived.freeGuaranteedPct"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="queue.derived.burstRoomPct"]')).toBeTruthy();

    // the treemap's accessible twin lists every leaf with its used-memory datum
    expect(container.querySelector('[data-yf="queue.resourcesUsed.memory"]')).toBeTruthy();
    // and the node-label card shows the cluster's real nodes
    expect(container.querySelector('[data-yf="node.id"][data-yv="127.0.0.2:8041"]')).toBeTruthy();

    const parityWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("[parity]"));
    expect(parityWarnings).toEqual([]);
    warn.mockRestore();
  });

  it("sorts the node partition card and opens node details from both its row and link", async () => {
    stubApi(CAPACITY);
    const { router } = renderAt(schedulerView(), ["/scheduler"]);
    const table = await screen.findByRole("table", { name: "Nodes by label partition" });

    for (const column of ["containers", "memory", "vcores", "state"]) {
      fireEvent.click(table.querySelector(`[data-col="${column}"] button`)!);
    }

    const nodeLink = table.querySelector<HTMLAnchorElement>("a");
    expect(nodeLink).not.toBeNull();
    fireEvent.click(nodeLink!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nodes\//));
    await router.navigate({ to: "/scheduler" });

    const refreshed = await screen.findByRole("table", { name: "Nodes by label partition" });
    const row = refreshed.querySelectorAll<HTMLElement>('[role="row"]')[1];
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nodes\//));
  });

  it("capacity: formats queue resources and default partitions for operators while preserving raw data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubApi(CAPACITY);
    const { container } = renderAt(schedulerView(), ["/scheduler"]);
    expect(await screen.findByText("Queue users")).toBeTruthy();

    const text = (scope: string, field: string) => {
      const el = container.querySelector(`${scope} [data-yf="${field}"]`);
      return el ? { text: el.textContent?.replace(/\s+/g, " ").trim(), raw: el.getAttribute("data-yv") } : null;
    };

    // leaf queue rows of the tree
    const leaf = '[data-burrow-table="scheduler-capacity-tree"] [role="row"][data-ye="root.etl.ingest"]';
    const rootQueue = '[data-burrow-table="scheduler-capacity-tree"] [role="row"][data-ye="root"]';
    expect(text(rootQueue, "queue.defaultNodeLabelExpression")).toEqual({ text: "Default partition", raw: "" });
    expect(text(leaf, "queue.derived.orderingPolicyDisplayName")).toEqual({ text: "FairOrderingPolicy", raw: "FairOrderingPolicy" });
    expect(text(leaf, "queue.orderingPolicyInfo")?.raw).toBe("fair");
    expect(text(leaf, "queue.numContainers")?.raw).toBe("0");
    expect(text(leaf, "queue.maxApplicationsPerUser")?.raw).toBe("2400");
    expect(text(leaf, "queue.defaultPriority")?.raw).toBe("5");
    expect(text(leaf, "queue.isAutoCreatedLeafQueue")?.raw).toBe("false");
    // a parent queue has no application ordering policy display name
    expect(
      text('[data-burrow-table="scheduler-capacity-tree"] [role="row"][data-ye="root.etl"]', "queue.derived.orderingPolicyDisplayName"),
    ).toBeNull();
    // …and is never an auto-created leaf (the stock UI's `isLeafQueue() ? … : false`)
    expect(
      text('[data-burrow-table="scheduler-capacity-tree"] [role="row"][data-ye="root.etl"]', "queue.isAutoCreatedLeafQueue")?.raw,
    ).toBe("false");

    // queue-user rows keep raw REST values in Datum metadata while presenting readable resource values
    const alice = '[data-ye="root.default#alice"]';
    expect(text(alice, "queueuser.username")?.text).toBe("alice");
    expect(text(alice, "queueuser.userWeight")?.text).toBe("1.0");
    expect(text(alice, "queueuser.userResourceLimit")?.text).toBe("1 GiB · 1 vCore");
    expect(text(alice, "queueuser.resourcesUsed")?.text).toBe("2.3 GiB · 3 vCores");
    expect(text(alice, "queueuser.derived.maxAmResource")?.text).toBe("1.5 GiB · 1 vCore");
    expect(text(alice, "queueuser.AMResourceUsed")?.text).toBe("768 MiB · 1 vCore");
    expect(text(alice, "queueuser.numActiveApplications")?.raw).toBeTruthy();
    expect(text(alice, "queueuser.numPendingApplications")?.raw).toBeTruthy();

    // the default partition's tag leads the node-label card; the legacy value remains available in Datum metadata
    const tagData = [...container.querySelectorAll('[data-yf="queue.derived.partitionUiTag"]')];
    const tags = tagData.map((e) => e.textContent?.replace(/\s+/g, " ").trim());
    expect(tags[0]).toBe("Partition: Default partition · 3 GiB · 4 vCores");
    expect(tags).toContain("Partition: gpu · 3 GiB · 4 vCores");
    expect(tags).toContain("Partition: ssd · 3 GiB · 4 vCores");
    expect(tagData[0]?.getAttribute("data-yv")).toBe("Partition: <DEFAULT_PARTITION> <memory:3072, vCores:4>");

    expect(warn.mock.calls.filter((c) => String(c[0]).includes("[parity]"))).toEqual([]);
    warn.mockRestore();
  });

  it("updates queue ordering, visible columns, partition, and treemap basis", async () => {
    const patch = vi.fn();
    stubApi(CAPACITY);
    renderAt(<SchedulerPage search={{}} patch={patch} />, ["/scheduler"]);
    expect(await screen.findByText("Queue headroom")).toBeTruthy();

    fireEvent.click(within(screen.getByRole("group", { name: "Sibling order" })).getByRole("button", { name: "Free" }));
    expect(patch).toHaveBeenCalledWith({ sort: "free" });

    fireEvent.click(screen.getAllByRole("button", { name: /Choose columns/ })[0]!);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Ordering Policy" }));
    expect(patch).toHaveBeenCalledWith({ queueHide: expect.stringContaining("policy") });

    fireEvent.click(within(screen.getByRole("group", { name: "Size queues by" })).getByRole("button", { name: "Guaranteed share" }));
    expect(patch).toHaveBeenCalledWith({ basis: "capacity" });
    fireEvent.click(within(screen.getByRole("group", { name: "Size queues by" })).getByRole("button", { name: "Used memory" }));

    fireEvent.click(screen.getByRole("combobox", { name: "Partition" }));
    const gpu = await screen.findByRole("option", { name: "gpu" });
    fireEvent.pointerDown(gpu, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(gpu, { button: 0, pointerType: "mouse" });
    fireEvent.click(gpu);
    expect(patch).toHaveBeenCalledWith({ partition: "gpu" });
  });

  it("offers guaranteed shares when every leaf queue is idle", async () => {
    const raw = structuredClone(CAPACITY["yarn/scheduler"]) as { scheduler: { schedulerInfo: unknown } };
    const zeroQueueUsage = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      const queue = value as Record<string, unknown>;
      const used = queue.resourcesUsed;
      if (typeof used === "object" && used !== null && "memory" in used) (used as Record<string, unknown>).memory = 0;
      const children = (queue.queues as { queue?: unknown[] } | undefined)?.queue ?? [];
      children.forEach(zeroQueueUsage);
    };
    zeroQueueUsage(raw.scheduler.schedulerInfo);
    stubApi({ ...CAPACITY, "yarn/scheduler": raw });
    const patch = vi.fn();
    renderAt(<SchedulerPage search={{}} patch={patch} />, ["/scheduler"]);
    expect(await screen.findByRole("button", { name: "View guaranteed shares" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View guaranteed shares" }));
    expect(patch).toHaveBeenCalledWith({ basis: "capacity" });
  });

  it("drives the queue, activity, health, and configuration controls through URL state", async () => {
    stubApi(CAPACITY);
    const view = renderAt(<InteractiveScheduler />, ["/scheduler"]);
    expect(await screen.findByText("Queue headroom")).toBeTruthy();

    const queueTree = view.container.querySelector('[data-burrow-table="scheduler-capacity-tree"]')!;
    fireEvent.click(queueTree.querySelector('[role="columnheader"] button')!);
    const siblingOrder = within(screen.getByRole("group", { name: "Sibling order" }));
    for (const direction of ["Used", "Free", "Apps"]) fireEvent.click(siblingOrder.getByRole("button", { name: direction }));
    const users = await screen.findByRole("table", { name: "Queue users" });
    fireEvent.click(users.querySelector('[data-col="username"] button')!);
    const usersTableRoot = users.closest("[data-burrow-table-root]")!;
    fireEvent.click(within(usersTableRoot as HTMLElement).getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User Limit Resource" }));

    fireEvent.click(screen.getByRole("button", { name: "Collapse root.etl" }));
    const queueTable = view.container.querySelector('[data-burrow-table="scheduler-capacity-tree"]')!;
    await waitFor(() => expect(queueTable.querySelector('[data-ye="root.etl.ingest"]')).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Expand root.etl" }));
    await waitFor(() => expect(queueTable.querySelector('[data-ye="root.etl.ingest"]')).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: "Activities" }));
    const activities = await screen.findByRole("table", { name: "Scheduler allocation activities" });
    await waitFor(() => expect(activities.textContent).toContain("Queue does not need more resource"));
    fireEvent.click(activities.querySelector('[data-col="container"] button')!);
    const activitiesTableRoot = activities.closest("[data-burrow-table-root]")!;
    fireEvent.click(within(activitiesTableRoot as HTMLElement).getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Node Id" }));
    fireEvent.click(screen.getByRole("button", { name: "Group by diagnostic" }));
    fireEvent.click(screen.getByRole("button", { name: "Detailed" }));
    const node = screen.getByRole("combobox", { name: "NodeManager" });
    fireEvent.click(node);
    const nodeOption = await screen.findByRole("option", { name: "127.0.0.2:8041" });
    fireEvent.pointerDown(nodeOption, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(nodeOption, { button: 0, pointerType: "mouse" });
    fireEvent.click(nodeOption);

    fireEvent.click(screen.getByRole("tab", { name: "Health" }));
    expect(await screen.findByText("Aggregate scheduler counts")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    const config = await screen.findByRole("table", { name: "Scheduler configuration" });
    await waitFor(() => expect(config.textContent).toContain("yarn.scheduler.capacity.root"));
    fireEvent.click(within(config).getByRole("button", { name: "Property" }));
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Value" }));
    expect(screen.queryByRole("columnheader", { name: "Value" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Queues" }));
    const activeQueueTable = await screen.findByRole("table", { name: "Capacity scheduler queue tree" });
    fireEvent.click(activeQueueTable.querySelector('[role="row"][data-ye="root.etl"]')!);
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/scheduler/root.etl"));
  });

  it("explains when the RM returns no scheduler info", async () => {
    const noScheduler = renderAt(<SchedulerPage search={{}} patch={() => undefined} />, ["/scheduler"], (client) => {
      client.setQueryDefaults(["yarn", "scheduler"], { staleTime: Infinity, refetchOnMount: false });
      client.setQueryData(["yarn", "scheduler"], { scheduler: { schedulerInfo: null } });
    });
    expect(await screen.findByText("This cluster reports no scheduler")).toBeTruthy();
    noScheduler.unmount();
  });

  it("fair: renders the fair tree with fair-share freeness", async () => {
    stubApi({ ...CAPACITY, "yarn/scheduler": fixture("fair/scheduler.json") });
    const { container } = renderAt(<InteractiveScheduler />, ["/scheduler"]);

    expect(await screen.findByRole("heading", { name: "Scheduler", level: 1 })).toBeTruthy();
    expect(await screen.findByText("Queue headroom")).toBeTruthy();
    expect(container.querySelector('[data-yf="scheduler.type"][data-yv="fairScheduler"]')).toBeTruthy();
    const rowIds = [...container.querySelectorAll('[data-burrow-table="scheduler-fair-tree"] [role="row"][data-ye]')].map(
      (el) => (el as HTMLElement).dataset.ye,
    );
    expect(rowIds).toContain("root");
    expect(rowIds).toContain("root.etl.transform");
    expect(container.querySelector('[data-yf="queue.usedResources.memory"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="queue.derived.fairShareFreeMb"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="queue.schedulingPolicy"]')).toBeTruthy();
    const fairTree = container.querySelector('[data-burrow-table="scheduler-fair-tree"]')!;
    fireEvent.click(screen.getByRole("button", { name: "Collapse root.etl" }));
    await waitFor(() => expect(fairTree.querySelector('[data-ye="root.etl.transform"]')).toBeNull());
  });

  it("fifo: renders the single-queue block with its fractions converted for display", async () => {
    stubApi({ ...CAPACITY, "yarn/scheduler": fixture("fifo/scheduler.json") });
    const { container } = renderAt(schedulerView(), ["/scheduler"]);

    expect(await screen.findByText("FifoScheduler Queue")).toBeTruthy();
    expect(container.querySelector('[data-yf="scheduler.type"][data-yv="fifoScheduler"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="scheduler.qstate"][data-yv="RUNNING"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="scheduler.numNodes"][data-yv="0"]')).toBeTruthy();
    expect(await screen.findByText("Minimum Queue Memory Capacity")).toBeTruthy();
    expect(await screen.findByText("Number of Node Containers")).toBeTruthy();
  });

  it("unknown scheduler type: says so instead of breaking", async () => {
    stubApi({ ...CAPACITY, "yarn/scheduler": { scheduler: { schedulerInfo: { type: "quantumScheduler", capacity: 42 } } } });
    renderAt(schedulerView(), ["/scheduler"]);
    expect(await screen.findByText(/not recognised by this build/)).toBeTruthy();
  });

  it("upstream failure: shows the error state, not a blank page", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    renderAt(schedulerView(), ["/scheduler"]);
    expect(await screen.findByText("Cannot reach the ResourceManager")).toBeTruthy();
  });
});

describe("SchedulerPage health tab over captured payloads", () => {
  it("capacity: renders the three QueueMetrics counters under the legacy labels, from the JMX bean", async () => {
    stubApi(CAPACITY);
    const { container } = renderAt(healthView(), ["/scheduler"]);

    expect(await screen.findByText("Aggregate scheduler counts")).toBeTruthy();
    // the three counters the RM's QueueMetrics bean actually carries, with the legacy header texts
    expect(screen.getByText("Total Container Allocations(count)")).toBeTruthy();
    expect(screen.getByText("Total Container Releases(count)")).toBeTruthy();
    expect(screen.getByText("Total Container Preemptions(count)")).toBeTruthy();
    // the fourth legacy counter has no upstream source and must not be fabricated
    expect(screen.queryByText("Total Fulfilled Reservations(count)")).toBeNull();

    const datum = (field: string) => container.querySelector(`[data-yf="${field}"]`);
    // the counters arrive from the /api/rm/jmx query, after the section itself has rendered
    await waitFor(() => expect(datum("scheduler.derived.aggregateAllocatedContainers")?.getAttribute("data-yv")).toBe("25"));
    expect(datum("scheduler.derived.aggregateAllocatedContainers")?.textContent).toBe("25");
    expect(datum("scheduler.derived.aggregateReleasedContainers")?.getAttribute("data-yv")).toBe("25");
    expect(datum("scheduler.derived.aggregatePreemptions")?.getAttribute("data-yv")).toBe("0");

    // cluster-level entity (`_`), as the legacy health block is not per-queue
    expect(container.querySelector('[data-ye="_"]')).toBeTruthy();

    // the operations tables keep Container/Node/Queue (real REST data) but drop the unobtainable legacy Time column
    expect(container.querySelector('[data-yf="scheduler.health.operationsInfo.nodeId"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="scheduler.derived.lastOperationTimestamp"]')).toBeNull();
    expect(container.querySelector('[data-yf="scheduler.health.lastrun"]')).toBeTruthy();
  });

  it("capacity: an unavailable JMX query reads an honest N/A (data-yn=1), never a zero", async () => {
    const routes: Record<string, unknown> = { ...CAPACITY };
    delete routes["rm/jmx"]; // the stub then answers 404, so the query fails
    stubApi(routes);
    const { container } = renderAt(healthView(), ["/scheduler"]);

    expect(await screen.findByText("Aggregate scheduler counts")).toBeTruthy();
    const cell = container.querySelector('[data-yf="scheduler.derived.aggregateAllocatedContainers"]');
    expect(cell).toBeTruthy();
    expect(cell?.getAttribute("data-yn")).toBe("1");
    expect(cell?.getAttribute("data-yv")).toBe("");
    expect(cell?.textContent).toBe("N/A");
  });
});

describe("QueuePage over captured payloads", () => {
  it("capacity leaf: legacy Queue Status labels, freeness hero and the per-user table", async () => {
    stubApi(CAPACITY);
    const { container } = renderAt(queueView("root.etl.ingest"), ["/scheduler/root.etl.ingest"]);

    expect(await screen.findByText("Queue Status")).toBeTruthy();
    for (const label of [
      "Queue State",
      "Used Capacity",
      "Configured Max Capacity",
      "Effective Capacity",
      "Effective Max Capacity",
      "Absolute Used Capacity",
      "Absolute Configured Capacity",
      "Absolute Configured Max Capacity",
      "Used Resources",
      "Configured Max Application Master Limit",
      "Max Application Master Resources",
      "Used Application Master Resources",
      "Max Application Master Resources Per User",
      "Num Schedulable Applications",
      "Num Non-Schedulable Applications",
      "Num Containers",
      "Max Applications",
      "Max Applications Per User",
      "Configured Minimum User Limit Percent",
      "Configured User Limit Factor",
      "Accessible Node Labels",
      "Ordering Policy",
      "Preemption",
      "Intra-queue Preemption",
      "Default Node Label Expression",
      "Default Application Priority",
    ]) {
      expect(await screen.findByText(label), `missing legacy label ${label}`).toBeTruthy();
    }
    expect(container.querySelector('[data-yf="queue.defaultNodeLabelExpression"]')?.textContent).toBe("Default partition");

    // the queue entity wraps the whole status block
    expect(container.querySelector('[data-ye="root.etl.ingest"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="queue.absoluteCapacity"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="queue.derived.freeGuaranteedPct"]')).toBeTruthy();
    // breadcrumb links back to the ancestors
    expect(container.querySelector('a[href="/scheduler/root"]')).toBeTruthy();
  });

  it("capacity leaf with users: the user rows are their own entities", async () => {
    stubApi(CAPACITY);
    const { container } = renderAt(queueView("root.default"), ["/scheduler/root.default"]);
    await waitFor(() => expect(container.querySelector('[data-yf="queueuser.username"]')).toBeTruthy());
    expect(screen.queryByText("Active Users Info")).toBeNull();
    const userRows = [...container.querySelectorAll('[data-ye^="root.default#"]')];
    expect(userRows.length).toBeGreaterThan(0);
    expect(container.querySelector('[data-yf="queueuser.username"]')).toBeTruthy();
  });

  it("renders the queue applications table and node-label partition table from capacity fixtures", async () => {
    stubApi({ ...CAPACITY, "yarn/apps": other("app/running/apps.json") });
    const apps = renderAt(queueView("root.default", { tab: "apps" }), ["/scheduler/root.default"]);
    const appTable = await screen.findByRole("table", { name: "Applications in this queue" });
    expect(appTable.textContent).toContain("appdetail-long");
    expect(appTable.querySelector('[data-yf="app.id"]')).toBeTruthy();
    apps.unmount();

    stubApi(CAPACITY);
    const partitions = renderAt(queueView("root.default", { tab: "partitions" }), ["/scheduler/root.default"]);
    const partitionTable = await screen.findByRole("table", { name: "Node-label partitions of root.default" });
    expect(partitionTable.querySelector('[data-yf="queue.capacities.queueCapacitiesByPartition.partitionName"]')).toBeTruthy();
    expect(partitionTable.querySelector('[data-yf="queue.resources.resourceUsagesByPartition.used.memory"]')).toBeTruthy();
    partitions.unmount();
  });

  it("scopes scheduler configuration to a queue or displays the whole scheduler", async () => {
    stubApi(CAPACITY);
    const scoped = renderAt(queueView("root.default", { tab: "conf" }), ["/scheduler/root.default"]);
    const confTable = await screen.findByRole("table", { name: "Scheduler configuration" });
    await waitFor(() => expect(confTable.textContent).toContain("yarn.scheduler.capacity.root.default"));
    expect(confTable.textContent).not.toContain("yarn.scheduler.capacity.root.etl");
    fireEvent.click(screen.getByRole("button", { name: "This queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Whole scheduler" }));
    scoped.unmount();

    stubApi(CAPACITY);
    renderAt(queueView("root.default", { tab: "conf", confAll: true }), ["/scheduler/root.default"]);
    const wholeTable = await screen.findByRole("table", { name: "Scheduler configuration" });
    await waitFor(() => expect(wholeTable.textContent).toContain("yarn.scheduler.capacity.root.etl"));
  });

  it("updates every queue-table tab and its filters through URL state", async () => {
    stubApi(CAPACITY);
    renderAt(<InteractiveQueue queue="root.default" />, ["/scheduler/root.default"]);

    const users = await screen.findByRole("table", { name: "Queue users" });
    fireEvent.click(users.querySelector('[data-col="username"] button')!);
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User Limit Resource" }));

    fireEvent.click(screen.getByRole("tab", { name: "Applications" }));
    const apps = await screen.findByRole("table", { name: "Applications in this queue" });
    fireEvent.click(apps.querySelector('[data-col="id"] button')!);
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Application Type" }));

    fireEvent.click(screen.getByRole("tab", { name: "Partitions" }));
    const partitions = await screen.findByRole("table", { name: "Node-label partitions of root.default" });
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Configured Min" }));

    fireEvent.click(screen.getByRole("tab", { name: "Activities" }));
    const activities = await screen.findByRole("table", { name: "Scheduler allocation activities" });
    fireEvent.click(screen.getByRole("button", { name: "Group by diagnostic" }));
    const node = screen.getByRole("combobox", { name: "NodeManager" });
    fireEvent.click(node);
    const option = await screen.findByRole("option", { name: "127.0.0.2:8041" });
    fireEvent.pointerDown(option, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
    fireEvent.click(option);
    expect(activities).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    const config = await screen.findByRole("table", { name: "Scheduler configuration" });
    fireEvent.click(screen.getByRole("button", { name: "Whole scheduler" }));
    await waitFor(() => expect(config.textContent).toContain("yarn.scheduler.capacity.root.etl"));
    fireEvent.click(within(config).getByRole("button", { name: "Property" }));
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Value" }));
    expect(partitions).toBeTruthy();
  });

  it("fair queue: renders the fair status labels and explains the missing per-user table", async () => {
    stubApi({ ...CAPACITY, "yarn/scheduler": fixture("fair/scheduler.json") });
    renderAt(queueView("root.etl.transform"), ["/scheduler/root.etl.transform"]);
    expect(await screen.findByText("Demand Resources")).toBeTruthy();
    expect(await screen.findByText("Steady Fair Share")).toBeTruthy();
    expect(await screen.findByText("Instantaneous Fair Share")).toBeTruthy();
    expect(await screen.findByText(/no per-user table/)).toBeTruthy();
  });

  it("unknown queue: explains the path instead of rendering an empty shell", async () => {
    stubApi(CAPACITY);
    renderAt(queueView("root.nope"), ["/scheduler/root.nope"]);
    expect(await screen.findByText(/No queue named root.nope/)).toBeTruthy();
  });
});
