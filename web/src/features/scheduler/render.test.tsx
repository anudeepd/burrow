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

const { act, render, cleanup, fireEvent, screen, waitFor, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { SchedulerPage } = await import("./SchedulerPage");
const { QueuePage } = await import("./QueuePage");
const { QueueTreemap, squarify } = await import("./Treemap");
const { NodeLabelsCard } = await import("./NodeLabelsCard");
const { HealthTables } = await import("./HealthTables");
const { TreemapSection } = await import("./TreemapSection");
const { SchedulerMetrics } = await import("./SchedulerMetrics");
const { ov } = await import("~/api/queries/overview");
const { schedulerQuery, schedulerActivitiesQuery, schedulerConfQuery } = await import("~/api/queries/scheduler");
const { tq } = await import("~/api/queries/tools");
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
    client,
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

function failCachedQuery(client: InstanceType<typeof QueryClient>, queryKey: readonly unknown[], message: string, clearData = false) {
  const query = client.getQueryCache().find({ queryKey });
  expect(query).toBeTruthy();
  act(() => {
    query!.setState({
      ...query!.state,
      ...(clearData ? { data: undefined } : {}),
      status: "error",
      error: new Error(message),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query!.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
  });
}

describe("SchedulerPage over captured payloads", () => {
  it("shows unavailable scheduler metrics and then formats reported values", async () => {
    const disableMetricQueries = (client: InstanceType<typeof QueryClient>, overview?: unknown) => {
      for (const query of [ov.nodes(), ov.schedulerOverview(), tq.conf()]) {
        client.setQueryDefaults(query.queryKey, { enabled: false });
      }
      if (overview !== undefined) client.setQueryData(ov.schedulerOverview().queryKey, overview as never);
    };
    const info = {
      type: "capacityScheduler",
      queueName: "root",
      capacity: 100,
      usedCapacity: 0,
      maxCapacity: 100,
    } as never;

    renderAt(
      <SchedulerMetrics info={info} queueCount={0} overShare={0} metrics={undefined} metricsError="metrics endpoint failed" />,
      ["/scheduler"],
      disableMetricQueries,
    );
    expect(await screen.findByText("Root queue")).toBeTruthy();
    expect(screen.getByText("root")).toBeTruthy();
    expect(screen.getAllByText("cluster metrics unavailable: metrics endpoint failed").length).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "More scheduler metrics" }));
    expect(screen.getByRole("button", { name: "Fewer metrics" })).toBeTruthy();
    cleanup();

    renderAt(
      <SchedulerMetrics
        info={{ ...info, queuePath: "root" } as never}
        queueCount={1}
        overShare={0}
        metrics={{ allocatedMB: 0, totalMB: 0 } as never}
      />,
      ["/scheduler"],
      disableMetricQueries,
    );
    expect(await screen.findByText("Scheduler load was not reported.")).toBeTruthy();
    expect(screen.getByText("Default-partition YARN memory allocation").parentElement?.textContent).toContain("—");
    cleanup();

    renderAt(
      <SchedulerMetrics
        info={{ ...info, queuePath: "root" } as never}
        queueCount={2}
        overShare={1}
        metrics={{ allocatedMB: 256, totalMB: 512, rmSchedulerBusyPercent: 35, rmEventQueueSize: 2, schedulerEventQueueSize: 4 } as never}
      />,
      ["/scheduler"],
      disableMetricQueries,
    );
    expect(await screen.findByText("50.0%")).toBeTruthy();
    expect(screen.getByText("35.0%")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    expect(screen.getByText("Over their share").parentElement?.textContent).toContain("1");
    cleanup();

    renderAt(<SchedulerMetrics info={info} queueCount={1} overShare={0} metrics={undefined} />, ["/scheduler"], (client) =>
      disableMetricQueries(client, {
        schedulerType: "Capacity Scheduler",
        schedulingResourceType: "memory-mb,vcores",
        minimumAllocation: { memory: 512, vCores: 1 },
        maximumAllocation: { memory: 4096, vCores: 4 },
        applicationPriority: 10,
        schedulerBusy: 25,
        rmDispatcherEventQueueSize: 2,
        schedulerDispatcherEventQueueSize: 3,
      }),
    );
    expect(await screen.findByText("4 GiB · 4 vCores")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy();
  });

  it("switches treemap size basis and ends the geometry transition", async () => {
    const root = {
      id: "root",
      name: "root",
      depth: 0,
      role: "root",
      children: [
        {
          id: "root.empty",
          name: "empty",
          depth: 1,
          role: "leaf",
          children: [],
          capacity: { minEffectiveCapacity: { memory: 512 } },
        },
      ],
    } as never;
    const onBasisChange = vi.fn();
    try {
      const view = renderAt(<TreemapSection root={root} basis="used" onBasisChange={onBasisChange} />, ["/scheduler"]);
      expect(await screen.findByText("No memory in use")).toBeTruthy();
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "Used memory" }));
      expect(onBasisChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "View guaranteed shares" }));
      expect(onBasisChange).toHaveBeenCalledWith("capacity");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(view.container.querySelector('svg[role="img"]')?.getAttribute("data-basis-transition")).toBe("false");

      view.rerender(<TreemapSection root={root} basis="capacity" onBasisChange={onBasisChange} />);
      expect(screen.queryByText("No memory in use")).toBeNull();
      expect(screen.getByRole("button", { name: "Guaranteed share" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("renders the treemap label bands at their height boundaries and supports Space navigation", async () => {
    const longKey = `root.${"long-queue-name-".repeat(12)}`;
    const item = { key: longKey, value: 100, field: "queue.used", raw: 100, usedPct: null };
    const textCounts = new Map<number, number>();

    for (const height of [15, 16, 21, 22, 53, 54, 81, 82, 127, 128]) {
      const view = renderAt(<QueueTreemap items={[item]} basis="used" height={height} label="Queue map" />, ["/scheduler"]);
      await screen.findByRole("img", { name: /Queue map/ });
      textCounts.set(height, view.container.querySelectorAll("svg text").length);
      view.unmount();
    }

    expect(textCounts.get(15)).toBe(0);
    expect(textCounts.get(16)).toBe(1);
    expect(textCounts.get(22)).toBe(1);
    expect(textCounts.get(53)).toBe(1);
    expect(textCounts.get(54)).toBe(2);
    expect(textCounts.get(81)).toBe(2);
    expect(textCounts.get(82)).toBe(3);
    expect(textCounts.get(127)).toBe(3);
    expect(textCounts.get(128)).toBe(3);

    const { container, router } = renderAt(
      <QueueTreemap items={[{ ...item, key: "root.keyboard", sub: undefined }]} basis="used" height={128} label="Queue map" />,
      ["/scheduler"],
    );
    await screen.findByRole("img", { name: /Queue map/ });
    const tile = container.querySelector('[role="link"]')!;
    expect(tile).toBeTruthy();
    fireEvent.keyDown(tile, { key: "x" });
    expect(router.state.location.pathname).toBe("/scheduler");
    fireEvent.keyDown(tile, { key: " " });
    await waitFor(() => expect(router.state.location.pathname).toBe("/scheduler/root.keyboard"));
  });

  it("uses measured narrow widths when deciding whether a tile can show compact text", async () => {
    let notify: ResizeObserverCallback | undefined;
    class WidthResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", WidthResizeObserver);

    const view = renderAt(
      <QueueTreemap
        items={[{ key: "root.queue", value: 100, field: "queue.used", raw: 100, usedPct: 50 }]}
        basis="capacity"
        height={40}
        label="Narrow queue map"
      />,
      ["/scheduler"],
    );
    await screen.findByRole("img", { name: /Narrow queue map/ });
    const figure = view.container.querySelector("figure")!;
    await act(async () => {
      notify?.([{ target: figure, contentRect: { width: 120 } } as ResizeObserverEntry], {} as ResizeObserver);
    });

    expect(view.container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 120 40");
    expect(view.container.querySelectorAll("svg text")).toHaveLength(1);
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

  it("marks node-label data as stale while keeping its cached rows visible", async () => {
    const nodes = ((other("nodes/nodes.json") as { nodes?: { node?: unknown[] } }).nodes?.node ?? []) as never[];
    renderAt(<NodeLabelsCard nodes={nodes} stale />, ["/scheduler"]);

    expect(await screen.findByText("showing cached nodes")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Nodes by label partition" }).textContent).toContain("127.0.0.2:8041");
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

  it("renders the complete Capacity and Fair queue column sets", async () => {
    const capacityFixture = structuredClone(CAPACITY["yarn/scheduler"]) as {
      scheduler: { schedulerInfo: { queues: { queue: Record<string, unknown>[] } } };
    };
    const autoQueue = capacityFixture.scheduler.schedulerInfo.queues.queue[0]!;
    const autoPartition = (autoQueue.capacities as { queueCapacitiesByPartition: Record<string, unknown>[] })
      .queueCapacitiesByPartition[0]!;
    autoQueue.isAutoCreatedLeafQueue = true;
    autoQueue.maxApplicationsPerUser = 3;
    autoQueue.maxParallelApps = 6;
    autoQueue.queueType = "leaf";
    autoQueue.creationMethod = "dynamicFlexible";
    autoQueue.autoCreationEligibility = "flexible";
    autoQueue.mode = "weight";
    autoQueue.preemptionDisabled = false;
    autoQueue.intraQueuePreemptionDisabled = true;
    autoQueue.nodeLabels = ["gpu", "ssd"];
    autoPartition.maxAMLimitPercentage = undefined;
    autoPartition.effectiveMinResource = undefined;
    autoPartition.effectiveMaxResource = undefined;
    autoPartition.weight = undefined;
    autoPartition.normalizedWeight = undefined;
    stubApi({ ...CAPACITY, "yarn/scheduler": capacityFixture });
    const capacity = renderAt(<SchedulerPage search={{}} patch={() => undefined} />, ["/scheduler"]);
    const capacityTable = await screen.findByRole("table", { name: "Capacity scheduler queue tree" });
    fireEvent.click(
      within(capacityTable.closest("[data-burrow-table-root]") as HTMLElement).getByRole("button", { name: /Choose columns/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    expect(within(capacityTable).getByRole("columnheader", { name: /Mode/ })).toBeTruthy();
    expect(capacityTable.textContent).toContain("Ordering Policy");
    capacity.unmount();

    const fairFixture = structuredClone(fixture("fair/scheduler.json")) as {
      scheduler: { schedulerInfo: { rootQueue: Record<string, unknown> } };
    };
    const rootQueue = fairFixture.scheduler.schedulerInfo.rootQueue;
    const fairQueues = (rootQueue.childQueues as { queue: Record<string, unknown>[] }).queue;
    const fairQueue = fairQueues[0]!;
    fairQueue.fairResources = { ...(fairQueue.fairResources as Record<string, unknown>), memory: 0 };
    fairQueue.minResources = { ...(fairQueue.minResources as Record<string, unknown>), memory: 0 };
    fairQueue.maxContainerAllocation = undefined;
    fairQueue.amUsedResources = undefined;
    stubApi({ ...CAPACITY, "yarn/scheduler": fairFixture });
    renderAt(<SchedulerPage search={{}} patch={() => undefined} />, ["/scheduler"]);
    const fairTable = await screen.findByRole("table", { name: "Fair scheduler queue tree" });
    fireEvent.click(within(fairTable.closest("[data-burrow-table-root]") as HTMLElement).getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    expect(within(fairTable).getByRole("columnheader", { name: /Max Container/ })).toBeTruthy();
    expect(fairTable.textContent).toContain("Used of Fair");
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
    const queueTableRoot = queueTree.closest("[data-burrow-table-root]")!;
    fireEvent.click(within(queueTableRoot as HTMLElement).getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Ordering Policy" }));
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
    fireEvent.click(screen.getByRole("combobox", { name: "NodeManager" }));
    const anyNode = await screen.findByRole("option", { name: "latest (any node)" });
    fireEvent.pointerDown(anyNode, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(anyNode, { button: 0, pointerType: "mouse" });
    fireEvent.click(anyNode);

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

  it("keeps cached scheduler data visible and reports metrics and node request failures", async () => {
    stubApi(CAPACITY);
    const successfulFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path =
        url
          .replace(/^https?:\/\/[^/]+/, "")
          .replace(/^\/api\//, "")
          .split("?")[0] ?? "";
      if (path === "yarn/metrics" || path === "yarn/nodes") {
        throw new TypeError(`${path} unavailable`);
      }
      return successfulFetch(input, init);
    });
    const view = renderAt(schedulerView(), ["/scheduler"]);
    expect(await screen.findByText("Queue headroom")).toBeTruthy();
    expect(await screen.findAllByText(/cluster metrics unavailable:/)).toHaveLength(3);
    expect(await screen.findByText("Cannot reach the ResourceManager")).toBeTruthy();

    failCachedQuery(view.client, schedulerQuery().queryKey, "scheduler refresh failed");
    expect(await screen.findByText("cached — the ResourceManager is not answering")).toBeTruthy();
  });

  it("uses relative capacity metrics when absolute queue percentages are missing", async () => {
    const payload = structuredClone(CAPACITY["yarn/scheduler"]) as {
      scheduler: { schedulerInfo: Record<string, unknown> };
    };
    const clearAbsolute = (node: Record<string, unknown>, schedulerRoot = false) => {
      const capacities = node.capacities as { queueCapacitiesByPartition?: Record<string, unknown>[] } | undefined;
      for (const capacity of capacities?.queueCapacitiesByPartition ?? []) {
        capacity.absoluteUsedCapacity = "NaN";
        capacity.absoluteCapacity = "NaN";
        capacity.absoluteMaxCapacity = "NaN";
        if (node.queuePath === "root.default") {
          capacity.usedCapacity = "NaN";
          capacity.capacity = "NaN";
          capacity.maxCapacity = "NaN";
        }
      }
      if (!schedulerRoot) {
        node.absoluteUsedCapacity = "NaN";
        node.absoluteCapacity = "NaN";
        node.absoluteMaxCapacity = "NaN";
        if (node.queuePath === "root.default") {
          node.usedCapacity = "NaN";
          node.capacity = "NaN";
          node.maxCapacity = "NaN";
        }
      }

      const queues = (node.queues as { queue?: Record<string, unknown>[] } | undefined)?.queue ?? [];
      queues.forEach(clearAbsolute);
    };
    clearAbsolute(payload.scheduler.schedulerInfo, true);
    stubApi({ ...CAPACITY, "yarn/scheduler": payload });

    renderAt(schedulerView(), ["/scheduler"]);
    expect(await screen.findByText("Queue headroom")).toBeTruthy();
  });

  it("shows stale and fatal activity request errors on the activities tab", async () => {
    stubApi(CAPACITY);
    const view = renderAt(<SchedulerPage search={{ tab: "activities" }} patch={() => undefined} />, ["/scheduler"]);
    expect(await screen.findByText("Queue does not need more resource")).toBeTruthy();
    const key = schedulerActivitiesQuery({ nodeId: undefined, groupBy: undefined }).queryKey;

    failCachedQuery(view.client, key, "activity refresh failed");
    expect(await screen.findByText("activity refresh failed")).toBeTruthy();

    failCachedQuery(view.client, key, "activity request failed", true);
    expect(await screen.findByText("activity request failed")).toBeTruthy();
  });

  it("shows stale and fatal scheduler configuration request errors", async () => {
    stubApi(CAPACITY);
    const view = renderAt(<SchedulerPage search={{ tab: "conf" }} patch={() => undefined} />, ["/scheduler"]);
    expect(await screen.findByRole("table", { name: "Scheduler configuration" })).toBeTruthy();
    const key = schedulerConfQuery("capacityScheduler").queryKey;

    failCachedQuery(view.client, key, "configuration refresh failed");
    expect(await screen.findByText("configuration refresh failed")).toBeTruthy();

    failCachedQuery(view.client, key, "configuration request failed", true);
    expect(await screen.findByText("configuration request failed")).toBeTruthy();
  });
});

describe("SchedulerPage health tab over captured payloads", () => {
  it("renders health-table empty, zero, populated, and optional-value states", () => {
    const { container } = render(<HealthTables health={undefined} aggregates={undefined} />);
    expect(screen.getByText("No scheduler operation recorded yet")).toBeTruthy();
    expect(container.textContent?.match(/N\/A/g)?.length).toBeGreaterThanOrEqual(3);
    cleanup();

    render(
      <HealthTables
        health={
          {
            lastrun: 0,
            operationsInfo: [
              { operation: "last-allocation", containerId: "container_1", nodeId: "worker-1:8041", queue: "root.default" },
              { operation: "last-release" },
              { operation: "last-preemption", containerId: "container_2" },
              { operation: "last-reservation", nodeId: "worker-2:8041" },
            ],
            lastRunDetails: [
              { operation: "allocations", count: 3, resources: { memory: 1024, vCores: 2 } },
              { operation: "reservations", count: undefined },
              { operation: "releases", count: 0, resources: { memory: 0, vCores: 0 } },
            ],
          } as never
        }
        aggregates={{ allocated: 3, released: null, preempted: 1, source: null }}
        aggregateError="JMX endpoint is unavailable"
      />,
    );

    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByText("JMX unavailable: JMX endpoint is unavailable")).toBeTruthy();
    expect(screen.getByText("container_1")).toBeTruthy();
    expect(screen.getByText("worker-1:8041")).toBeTruthy();
    expect(screen.getByText("root.default")).toBeTruthy();
    expect(screen.getAllByText("N/A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    expect(screen.getByText("1 GiB · 2 vCores")).toBeTruthy();
  });

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
