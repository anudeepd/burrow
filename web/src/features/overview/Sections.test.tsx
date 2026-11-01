import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClusterInfoResponse, ClusterMetrics, NodesResponse } from "~/api/schemas";

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { ApiError } = await import("~/api/client");
const { tq } = await import("~/api/queries/tools");
const { ov } = await import("~/api/queries/overview");
const { historyStore } = await import("~/state/history");
const { SchedulerSection } = await import("./scheduler");
const { ClusterMetricsSection, ResourceManagerMetricsSection } = await import("./cluster-metrics");
const { ClusterIdentity } = await import("./cluster-identity");
const { NodeStatesSection } = await import("./node-states");
const { OverviewAttentionSummary } = await import("./attention-summary");
const { OverviewPage } = await import("./overview-page");

const FIXTURE = resolve(process.cwd(), "../fixtures/rm/overview");
const nodesFile = resolve(process.cwd(), "../fixtures/rm/nodes/nodes.json");
const metrics = (JSON.parse(readFileSync(`${FIXTURE}/metrics.json`, "utf8")) as { clusterMetrics: ClusterMetrics }).clusterMetrics;
const nodes = JSON.parse(readFileSync(nodesFile, "utf8")) as NodesResponse;
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
const originalAnchorClick = HTMLAnchorElement.prototype.click;

function renderOverview(children: React.ReactNode, withFixtures = true) {
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <>{children}</> });
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/nodes", component: () => null }),
    createRoute({ getParentRoute: () => root, path: "/nodes/$nodeId", component: () => null }),
    createRoute({ getParentRoute: () => root, path: "/scheduler", component: () => null }),
  ];
  const router = createRouter({ routeTree: root.addChildren([home, ...routes]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, refetchOnMount: false } } });
  if (withFixtures) {
    client.setQueryData(q.metrics().queryKey, { clusterMetrics: metrics });
    client.setQueryData(q.nodes().queryKey, nodes);
    client.setQueryData(ov.info().queryKey, JSON.parse(readFileSync(`${FIXTURE}/info.json`, "utf8")));
    client.setQueryData(ov.appsActive().queryKey, JSON.parse(readFileSync(`${FIXTURE}/apps-active.json`, "utf8")));
    client.setQueryData(
      ov.scheduler().queryKey,
      JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/scheduler/capacity/scheduler.json"), "utf8")),
    );
    client.setQueryData(ov.schedulerOverview().queryKey, JSON.parse(readFileSync(`${FIXTURE}/scheduler-overview.json`, "utf8")));
    client.setQueryData(tq.conf().queryKey, JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/tools/conf.json"), "utf8")));
    client.setQueryData(q.meta().queryKey, {
      name: "Burrow",
      version: "0.1.0",
      now: 1_791_011_000_000,
      readOnly: true,
      rm: { urls: ["http://rm:8088"], active: "http://rm:8088", reachable: false },
      services: {
        sparkHistory: { configured: true, url: "http://history:18080", reachable: false },
        jobHistory: { configured: false, url: null, reachable: null },
        timeline: { configured: true, url: "http://timeline:8188", reachable: false },
      },
      features: { sparkLive: true, sparkHistory: true, aggregatedLogs: true, nodeLogs: true, events: true, kerberos: false },
      yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
    });
  }
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, client, router };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  historyStore.setState(() => ({ samples: [] }));
  if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
  HTMLAnchorElement.prototype.click = originalAnchorClick;
});

describe("overview sections", () => {
  it("renders the overview composition and keeps the history-window control interactive", async () => {
    const onHistoryWindow = vi.fn();
    renderOverview(<OverviewPage window="all" onHistoryWindow={onHistoryWindow} />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByTestId("identity")).toBeTruthy();
    expect(screen.getByTestId("services")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Active applications" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "5m" }));
    expect(onHistoryWindow).toHaveBeenCalledWith("5m");
  });

  it("renders the pre-migration overview composition without post-migration sections", async () => {
    renderOverview(<OverviewPage window="all" onHistoryWindow={() => {}} renderVersion="pre" />);

    expect(await screen.findByRole("heading", { name: "Cluster overview" })).toBeTruthy();
    expect(screen.getByTestId("cluster-metrics")).toBeTruthy();
    expect(screen.queryByTestId("resource-manager-metrics")).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByText("active Spark apps →")).toBeNull();
  });

  it("shows cluster identity loading, error, stale and successful upstream states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    const pending = renderOverview(<ClusterIdentity />, false);
    expect(await screen.findByTestId("identity-skeleton")).toBeTruthy();
    pending.unmount();

    const { client } = renderOverview(<ClusterIdentity />, false);
    await screen.findByTestId("identity-skeleton");
    const infoQuery = client.getQueryCache().find({ queryKey: ov.info().queryKey })!;
    infoQuery.setState({
      ...infoQuery.state,
      status: "error",
      error: new Error("identity unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: infoQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("identity unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("keeps cached cluster identity visible after refresh failure and shows the last upstream answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    const { client } = renderOverview(<ClusterIdentity showUpstreamAnswer />, false);
    const response = JSON.parse(readFileSync(`${FIXTURE}/info.json`, "utf8")) as ClusterInfoResponse;
    client.setQueryData(ov.info().queryKey, response);
    const infoQuery = client.getQueryCache().find({ queryKey: ov.info().queryKey })!;
    infoQuery.setState({
      ...infoQuery.state,
      status: "error",
      error: new Error("identity refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: infoQuery.state.errorUpdateCount + 1,
    });

    expect(await screen.findByTestId("identity")).toBeTruthy();
    expect(screen.getByText("Cluster identity refresh failed; showing the last loaded values")).toBeTruthy();
    expect(screen.getByText(/last upstream answer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("renders cluster counters and the registered-node inventory from captured RM responses", async () => {
    renderOverview(
      <>
        <ClusterMetricsSection />
        <ResourceManagerMetricsSection />
        <NodeStatesSection metrics={metrics} />
      </>,
    );
    expect(await screen.findByTestId("cluster-metrics")).toBeTruthy();
    expect(screen.getByTestId("resource-manager-metrics")).toBeTruthy();
    expect(await screen.findByRole("table", { name: "Registered nodes" })).toBeTruthy();
    expect(screen.getByText("Apps Submitted")).toBeTruthy();
    expect(screen.getByText("Virtual cores")).toBeTruthy();
  });

  it("covers cluster metric loading, fatal and stale errors, and sampled chart inspection", async () => {
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
    const pending = renderOverview(<ClusterMetricsSection />, false);
    expect(await screen.findByText("Applications")).toBeTruthy();
    const pendingQuery = pending.client.getQueryCache().find({ queryKey: ov.metrics().queryKey })!;
    pendingQuery.setState({
      ...pendingQuery.state,
      status: "error",
      error: new Error("metrics unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: pendingQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Cluster metrics are not available" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    pending.unmount();

    const now = Date.now();
    historyStore.setState(() => ({
      samples: [
        { t: now - 60_000, memPct: 40, vcorePct: 20, appsRunning: 1, appsPending: 2, containers: 3 },
        { t: now - 30_000, memPct: 55, vcorePct: 25, appsRunning: 2, appsPending: 1, containers: 4 },
      ],
    }));
    const stale = renderOverview(<ClusterMetricsSection />);
    const metricsQuery = stale.client.getQueryCache().find({ queryKey: ov.metrics().queryKey })!;
    metricsQuery.setState({
      ...metricsQuery.state,
      status: "error",
      error: new Error("metrics refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: metricsQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("Cluster metrics refresh failed; showing the last loaded values")).toBeTruthy();
    const samples = screen.getByRole("slider", { name: "Memory utilisation history samples" });
    fireEvent.focus(samples);
    expect(samples.getAttribute("aria-valuetext")).toContain("Memory utilisation 55.0%");
    expect(document.querySelector('[data-testid="cluster-metrics"]')?.textContent).toContain(":");
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("shows ResourceManager metric failures with and without cached data", async () => {
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
    const failed = renderOverview(<ResourceManagerMetricsSection />, false);
    await screen.findByText("Applications");
    const { client } = failed;
    const query = client.getQueryCache().find({ queryKey: ov.metrics().queryKey })!;
    query.setState({
      ...query.state,
      status: "error",
      error: new Error("ResourceManager counters unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "ResourceManager metrics are not available" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    failed.unmount();

    const stale = renderOverview(<ResourceManagerMetricsSection />);
    const staleQuery = stale.client.getQueryCache().find({ queryKey: ov.metrics().queryKey })!;
    staleQuery.setState({
      ...staleQuery.state,
      status: "error",
      error: new Error("ResourceManager refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: staleQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("ResourceManager metrics refresh failed; showing the last loaded values")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("expands the compact node inventory, exports every column, and opens a node row", async () => {
    const createObjectURL = vi.fn(() => "blob:overview-nodes");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const { container, router } = renderOverview(<NodeStatesSection metrics={metrics} collapseInventory />);
    await screen.findByTestId("node-states");
    const disclosure = container.querySelector("details > summary");
    expect(disclosure).toBeTruthy();
    fireEvent.click(disclosure!);
    const table = await screen.findByRole("table", { name: "Registered nodes" });

    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    for (const column of ["labels", "memory", "vcores", "physicalMemory"]) {
      fireEvent.click(table.querySelector(`[data-col="${column}"] button`)!);
    }
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
    expect(createObjectURL).toHaveBeenCalledOnce();

    const firstRow = table.querySelector<HTMLElement>('[role="row"][data-ye]');
    expect(firstRow).toBeTruthy();
    fireEvent.click(firstRow!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nodes\//));
  });

  it("keeps cached nodes visible after a refresh error and shows a fatal node-list error", async () => {
    const stale = renderOverview(<NodeStatesSection metrics={metrics} />);
    const staleQuery = stale.client.getQueryCache().find({ queryKey: ov.nodes().queryKey })!;
    staleQuery.setState({
      ...staleQuery.state,
      status: "error",
      error: new Error("node refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: staleQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("Node list refresh failed; showing the last loaded rows")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Registered nodes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    stale.unmount();

    const fatal = renderOverview(<NodeStatesSection metrics={metrics} />, false);
    await screen.findByTestId("node-states");
    const query = fatal.client.getQueryCache().find({ queryKey: ov.nodes().queryKey })!;
    query.setState({
      ...query.state,
      status: "error",
      error: new Error("node list unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("node list unavailable")).toBeTruthy();
    expect(screen.getByText("Node state counts above remain available.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    fatal.unmount();
  });

  it("stops row activation when opening a node through its name link", async () => {
    const { router } = renderOverview(<NodeStatesSection metrics={metrics} />);
    await screen.findByRole("table", { name: "Registered nodes" });
    fireEvent.click(screen.getByRole("link", { name: "127.0.0.2" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nodes\//));
  });

  it("summarizes unreachable services, node health, and high resource pressure", async () => {
    renderOverview(
      <OverviewAttentionSummary
        metrics={{
          ...metrics,
          unhealthyNodes: 1,
          lostNodes: 2,
          totalMB: 100,
          allocatedMB: 90,
          totalVirtualCores: 10,
          allocatedVirtualCores: 9,
        }}
        metricsPending={false}
        metricsError={false}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Needs attention" })).toBeTruthy();
    expect(screen.getByText("ResourceManager unreachable")).toBeTruthy();
    expect(screen.getByText("Spark History unreachable")).toBeTruthy();
    expect(screen.getByText("Timeline Service unreachable")).toBeTruthy();
    expect(screen.getByRole("link", { name: "1 unhealthy node" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "2 lost nodes" })).toBeTruthy();
    expect(screen.getByText(/ResourceManager allocation high: 9 of 10 vCores allocated/)).toBeTruthy();
    expect(screen.getByText(/memory allocated/)).toBeTruthy();
  });

  it("shows the loading summary while metrics and cluster metadata are pending", async () => {
    renderOverview(<OverviewAttentionSummary metrics={undefined} metricsPending metricsError={false} />, false);
    expect(await screen.findByRole("status", { name: "Loading cluster attention summary" })).toBeTruthy();
  });

  it("summarizes a healthy cluster and flags unprobed configured services as incomplete", async () => {
    const { client } = renderOverview(
      <OverviewAttentionSummary metrics={{ ...metrics, unhealthyNodes: 0, lostNodes: 0 }} metricsPending={false} metricsError={false} />,
    );
    const meta = client.getQueryData(ov.meta().queryKey)!;
    client.setQueryData(ov.meta().queryKey, {
      ...meta,
      rm: { ...meta.rm, reachable: true },
      services: {
        sparkHistory: { ...meta.services.sparkHistory, reachable: true },
        jobHistory: { configured: false, url: null, reachable: null },
        timeline: { ...meta.services.timeline, reachable: null },
      },
    });
    expect(await screen.findByRole("heading", { name: "Status summary incomplete" })).toBeTruthy();
    expect(screen.getByText(/could not be confirmed/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Reported conditions" })).toBeNull();
  });

  it("reports no current exceptions when healthy metrics and service probes are complete", async () => {
    const { client } = renderOverview(
      <OverviewAttentionSummary metrics={{ ...metrics, unhealthyNodes: 0, lostNodes: 0 }} metricsPending={false} metricsError={false} />,
    );
    const meta = client.getQueryData(ov.meta().queryKey)!;
    client.setQueryData(ov.meta().queryKey, {
      ...meta,
      rm: { ...meta.rm, reachable: true },
      services: {
        sparkHistory: { ...meta.services.sparkHistory, reachable: true },
        jobHistory: { ...meta.services.jobHistory, reachable: true },
        timeline: { ...meta.services.timeline, reachable: true },
      },
    });
    expect(await screen.findByRole("heading", { name: "No current exceptions" })).toBeTruthy();
    expect(screen.getByText(/No unhealthy or lost nodes/)).toBeTruthy();
  });

  it("shows known conditions while metrics or metadata status is incomplete", async () => {
    const { client } = renderOverview(<OverviewAttentionSummary metrics={undefined} metricsPending={false} metricsError />);
    const meta = client.getQueryData(ov.meta().queryKey)!;
    client.setQueryData(ov.meta().queryKey, {
      ...meta,
      rm: { ...meta.rm, reachable: true },
      services: {
        sparkHistory: { ...meta.services.sparkHistory, reachable: true },
        jobHistory: { ...meta.services.jobHistory, reachable: true },
        timeline: { ...meta.services.timeline, reachable: true },
      },
    });
    expect(await screen.findByRole("heading", { name: "Status summary incomplete" })).toBeTruthy();
    expect(screen.getByText(/Some node, service, or ResourceManager counter status could not be confirmed/)).toBeTruthy();
  });

  it("renders scheduler facts, queue capacity, and dispatcher metrics from RM fixtures", async () => {
    renderOverview(<SchedulerSection />);
    expect(await screen.findByTestId("scheduler")).toBeTruthy();
    expect(screen.getByText("Capacity Scheduler")).toBeTruthy();
    expect(screen.getByText("Queue headroom")).toBeTruthy();
    expect(screen.getByRole("link", { name: "root.default" })).toBeTruthy();
    expect(screen.getByText("Scheduling Resource Type")).toBeTruthy();
    expect(screen.getByText("RM Dispatcher EventQueue Size")).toBeTruthy();
  });

  it("shows every queue teaser field from the column menu", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:queue-teaser");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderOverview(<SchedulerSection />);
    const table = await screen.findByRole("table", { name: "Queue headroom" });
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    expect(screen.getByRole("columnheader", { name: /Guarantee \/ max/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /State/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Used/ })).toBeTruthy();

    for (const header of table.querySelectorAll('[role="columnheader"] button')) fireEvent.click(header);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(clickAnchor).toHaveBeenCalledTimes(2);
  });

  it("uses scheduler REST facts when the overview endpoint is unavailable and supports the compact queue disclosure", async () => {
    const { client } = renderOverview(<SchedulerSection collapseQueueTable />);
    expect(await screen.findByTestId("scheduler")).toBeTruthy();
    const disclosure = screen.getByText("expand table").closest("summary")!;
    expect(disclosure.textContent).toContain("rows");
    fireEvent.click(disclosure);
    expect(screen.getByRole("table", { name: "Queue headroom" })).toBeTruthy();

    client.setQueryData(ov.schedulerOverview().queryKey, null as never);
    expect(await screen.findByText("Detailed scheduler information is unavailable on this cluster.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Full scheduler view →" })).toBeTruthy();
    expect(screen.getByText("Capacity Scheduler")).toBeTruthy();
  });

  it("shows the unavailable state when neither scheduler source has data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const { client } = renderOverview(<SchedulerSection />);
    client.setQueryData(ov.schedulerOverview().queryKey, null as never);
    client.setQueryData(ov.scheduler().queryKey, null as never);
    expect(await screen.findByRole("heading", { name: "The scheduler did not answer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("renders a compact loading skeleton while both scheduler sources are pending", async () => {
    renderOverview(<SchedulerSection />, false);
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(screen.queryByTestId("scheduler")).toBeNull();
  });

  it("reports a scheduler-overview read error and keeps the REST fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const { client } = renderOverview(<SchedulerSection />);
    const query = client.getQueryCache().find({ queryKey: ov.schedulerOverview().queryKey })!;
    query.setState({
      ...query.state,
      data: undefined,
      status: "error",
      error: new Error("overview request failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Scheduler overview could not be read" })).toBeTruthy();
    expect(screen.getByText("overview request failed")).toBeTruthy();
    expect(screen.getByText("Capacity Scheduler")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("uses overview allocation values and reports when configuration could not be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const { client } = renderOverview(<SchedulerSection />);
    const query = client.getQueryCache().find({ queryKey: tq.conf().queryKey })!;
    query.setState({
      ...query.state,
      data: undefined,
      status: "error",
      error: new Error("configuration request failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(
      await screen.findByRole("heading", {
        name: "Scheduler configuration could not be read; overview values are used where available",
      }),
    ).toBeTruthy();
    expect(screen.getByText("configuration request failed")).toBeTruthy();
    expect(screen.getByTestId("scheduler").textContent).toContain("<memory:256, vCores:1>");
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("keeps cached scheduler values visible when the three refreshes fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const { client } = renderOverview(<SchedulerSection />);
    const queries = [ov.schedulerOverview(), ov.scheduler(), tq.conf()].map(({ queryKey }) => client.getQueryCache().find({ queryKey })!);
    for (const query of queries) {
      query.setState({
        ...query.state,
        status: "error",
        error: new Error("refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
      });
    }
    expect(await screen.findByText(/Scheduler overview refresh failed/)).toBeTruthy();
    expect(await screen.findByText(/Scheduler refresh failed/)).toBeTruthy();
    expect(await screen.findByText(/Scheduler configuration refresh failed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "root.default" })).toBeTruthy();
    for (const retry of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(retry);
  });

  it("keeps queue teasers in an error state when the scheduler tree is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const { client } = renderOverview(<SchedulerSection />);
    const query = client.getQueryCache().find({ queryKey: ov.scheduler().queryKey })!;
    query.setState({
      ...query.state,
      data: undefined,
      status: "error",
      error: new Error("scheduler tree unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
    expect(await screen.findByRole("heading", { name: "Queue data is unavailable" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("explains an unsupported scheduler-overview endpoint while REST data remains available", async () => {
    const { client } = renderOverview(<SchedulerSection />);
    const query = client.getQueryCache().find({ queryKey: ov.schedulerOverview().queryKey })!;
    query.setState({
      ...query.state,
      data: undefined,
      status: "error",
      error: new ApiError("not found", "http", 404),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    const unavailable = await screen.findByRole("status");
    expect(unavailable.textContent).toContain("HTTP 404");
    expect(unavailable.textContent).toContain("Showing scheduler and configuration data where available.");
    expect(screen.getByText("Capacity Scheduler")).toBeTruthy();
  });
});
