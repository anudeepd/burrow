/**
 * Integration render tests for the Scheduler routes, driven by the REAL captured fixtures.
 *
 * Parity mode is on (`window.__BURROW_PARITY__`), which the shared `DataTable` honours by rendering every row instead of a
 * virtual window — the only way to assert row content in jsdom, and the same mode the parity harness uses.
 *
 * The components are imported dynamically AFTER the flag is set, because `~/state/parity` reads it at module scope.
 */
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `~/state/parity` decides parity ONCE at module scope, so the flag has to be set before that module is evaluated —
// a genuine module-load-order boundary that static imports cannot express.
window.__BURROW_PARITY__ = true;

// jsdom gap: Base UI's ScrollArea asks a scroll viewport for its running animations.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

const { render, cleanup, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { SchedulerPage } = await import("./SchedulerPage");
const { QueuePage } = await import("./QueuePage");

const fixture = (rel: string): unknown => JSON.parse(readFileSync(`../fixtures/rm/scheduler/${rel}`, "utf8"));
const other = (rel: string): unknown => JSON.parse(readFileSync(`../fixtures/rm/${rel}`, "utf8"));

const CAPACITY = {
  "yarn/scheduler": fixture("capacity/scheduler.json"),
  "yarn/scheduler/activities": fixture("capacity/scheduler-activities.json"),
  "yarn/scheduler-conf": fixture("capacity/scheduler-conf.json"),
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

function renderAt(element: ReactElement, entries: string[]) {
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([schedulerRoute, queueRoute]),
    history: createMemoryHistory({ initialEntries: entries }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const schedulerView = () => <SchedulerPage search={{}} patch={() => undefined} />;
const healthView = () => <SchedulerPage search={{ tab: "health" }} patch={() => undefined} />;
const queueView = (queue: string) => <QueuePage queue={queue} search={{}} patch={() => undefined} />;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SchedulerPage over captured payloads", () => {
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

  it("fair: renders the fair tree with fair-share freeness", async () => {
    stubApi({ ...CAPACITY, "yarn/scheduler": fixture("fair/scheduler.json") });
    const { container } = renderAt(schedulerView(), ["/scheduler"]);

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
