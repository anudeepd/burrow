import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClusterInfoResponse, ClusterMetrics, NodesResponse } from "~/api/schemas";

window.__BURROW_PARITY__ = true;

const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { connectionStore } = await import("~/api/connection");
const { ApiError } = await import("~/api/client");
const { tq } = await import("~/api/queries/tools");
const { ov } = await import("~/api/queries/overview");
const { historyStore } = await import("~/state/history");
const { prefsStore } = await import("~/state/prefs");
const { parityStore } = await import("~/state/parity");
const { SchedulerSection, clusterMetricsUnavailableReason } = await import("./scheduler");
const { ClusterMetricsSection, ResourceManagerMetricsSection } = await import("./cluster-metrics");
const { ClusterIdentity } = await import("./cluster-identity");
const { NodeStatesSection } = await import("./node-states");
const { OverviewAttentionSummary } = await import("./attention-summary");
const { OverviewPage } = await import("./overview-page");
const { OverviewLoading } = await import("./overview-loading");
const { MetricCard } = await import("./metric-card");
const { CrossLink } = await import("./ui");

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
  connectionStore.setState((state) => ({ ...state, lastCache: null }));
  prefsStore.setState((state) => ({ ...state, tz: "local" }));
  parityStore.setState(() => ({ enabled: true }));
  if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
  HTMLAnchorElement.prototype.click = originalAnchorClick;
});

describe("overview sections", () => {
  it("renders the route loading placeholder and a default linked metric card", async () => {
    const loading = render(<OverviewLoading />);
    expect(screen.getByRole("status", { name: "Loading cluster overview" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    loading.unmount();

    const { router } = renderOverview(
      <MetricCard label="Total nodes" field="cluster.nodes.total" raw={12} fmt="int" href="/nodes" />,
      false,
    );
    const link = await screen.findByRole("link", { name: "Total nodes: open the filtered view" });
    expect(link.textContent).toContain("Open Total nodes");
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/nodes"));
  });

  it("shows an em dash in the header before cluster metrics have loaded", async () => {
    renderOverview(<OverviewPage window="5m" onHistoryWindow={() => {}} />, false);
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(await screen.findByText("— applications submitted")).toBeTruthy();
  });

  it("lets link handlers prevent client-side navigation", async () => {
    const onClick = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => event.preventDefault());
    const { router } = renderOverview(
      <CrossLink href="/nodes" onClick={onClick}>
        Prevent navigation
      </CrossLink>,
      false,
    );
    fireEvent.click(await screen.findByRole("link", { name: "Prevent navigation" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe("/");
  });

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

  it("formats sparse identity metadata and a raw identity read failure", async () => {
    const identity = JSON.parse(readFileSync(`${FIXTURE}/info.json`, "utf8")) as ClusterInfoResponse;
    const cached = renderOverview(<ClusterIdentity showUpstreamAnswer />, true);
    cached.client.setQueryData(ov.info().queryKey, {
      ...identity,
      clusterInfo: {
        ...identity.clusterInfo,
        rmStateStoreName: "NullRMStateStore",
        haZooKeeperConnectionState: null as unknown as string,
      },
    });
    connectionStore.setState((state) => ({ ...state, lastCache: "stale" }));
    const infoQuery = cached.client.getQueryCache().find({ queryKey: ov.info().queryKey })!;
    infoQuery.setState({
      ...infoQuery.state,
      status: "error",
      error: new Error("raw metadata refresh"),
      dataUpdatedAt: 0,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: infoQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("NullRMStateStore")).toBeTruthy();
    expect(screen.getAllByText("stale").length).toBeGreaterThan(0);
    expect(screen.queryByText(/last upstream answer/)).toBeNull();
    infoQuery.setState({ ...infoQuery.state, dataUpdatedAt: Date.now() });
    expect(await screen.findByText(/last upstream answer/)).toBeTruthy();
    cached.unmount();

    const missing = renderOverview(<ClusterIdentity />, false);
    await screen.findByTestId("identity-skeleton");
    const query = missing.client.getQueryCache().find({ queryKey: ov.info().queryKey })!;
    query.setState({
      ...query.state,
      status: "error",
      error: "raw identity failure" as unknown as Error,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("raw identity failure")).toBeTruthy();
    missing.unmount();

    const emptyError = renderOverview(<ClusterIdentity />, false);
    await screen.findByTestId("identity-skeleton");
    const emptyQuery = emptyError.client.getQueryCache().find({ queryKey: ov.info().queryKey })!;
    emptyQuery.setState({
      ...emptyQuery.state,
      status: "error",
      error: null,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: emptyQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("The ResourceManager did not respond.")).toBeTruthy();
  });

  it("renders no identity section when the successful response has no data", async () => {
    const { client } = renderOverview(<ClusterIdentity />, false);
    client.setQueryData(ov.info().queryKey, { clusterInfo: null } as never);
    await waitFor(() => expect(screen.queryByTestId("identity")).toBeNull());
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
      data: {
        clusterMetrics: {
          ...metrics,
          rmSchedulerBusyPercent: null,
          rmEventQueueSize: null,
          schedulerEventQueueSize: null,
        },
      },
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

  it("renders zero capacity and unavailable raw aggregate counters honestly", async () => {
    const { client } = renderOverview(<ClusterMetricsSection showRawAggregate />);
    const sparseMetrics = {
      ...metrics,
      totalMB: null,
      allocatedMB: null,
      availableMB: null,
      reservedMB: null,
      pendingMB: null,
      totalVirtualCores: 0,
      allocatedVirtualCores: 0,
      availableVirtualCores: 0,
      reservedVirtualCores: 0,
      pendingVirtualCores: 0,
      utilizedMBPercent: Number.NaN,
      utilizedVirtualCoresPercent: Number.NaN,
      rmSchedulerBusyPercent: -1,
      crossPartitionMetricsAvailable: false,
    };
    client.setQueryData(ov.metrics().queryKey, { clusterMetrics: sparseMetrics } as never);

    const section = await screen.findByTestId("cluster-metrics");
    for (const key of ["totalMB", "allocatedMB", "availableMB", "reservedMB", "pendingMB"]) {
      expect(section.textContent).toContain(`${key} —`);
    }
    expect(section.textContent).toContain("monitor is off");
    expect(section.textContent).toContain("used / capacity now 0.0%");
  });

  it("renders sparse cross-partition values, reserved usage, and UTC history samples", async () => {
    const now = Date.now();
    historyStore.setState(() => ({
      samples: [
        { t: now - 60_000, memPct: 35, vcorePct: 20, appsRunning: 1, appsPending: 2, containers: 3 },
        { t: now - 30_000, memPct: 45, vcorePct: 25, appsRunning: 2, appsPending: 1, containers: 4 },
      ],
    }));
    prefsStore.setState((state) => ({ ...state, tz: "utc" }));
    connectionStore.setState((state) => ({ ...state, lastCache: "stale" }));
    const { client } = renderOverview(<ClusterMetricsSection showRawAggregate />);
    const sparse = {
      ...metrics,
      totalAllocatedContainersAcrossPartition: undefined,
      containersAllocated: undefined,
      totalUsedResourcesAcrossPartition: undefined,
      totalClusterResourcesAcrossPartition: undefined,
      totalReservedResourcesAcrossPartition: { memory: 128, vCores: 2 },
      reservedMB: 128,
      reservedVirtualCores: 2,
      rmSchedulerBusyPercent: null,
    };
    client.setQueryData(ov.metrics().queryKey, { clusterMetrics: sparse } as never);

    const section = await screen.findByTestId("cluster-metrics");
    expect(section.textContent).toContain("reserved");
    expect(section.textContent).toContain("upstream served stale cache");
    const samples = screen.getByRole("slider", { name: "Memory utilisation history samples" });
    fireEvent.focus(samples);
    expect(samples.getAttribute("aria-valuetext")).toContain("UTC");

    client.setQueryData(ov.metrics().queryKey, {
      clusterMetrics: { ...sparse, crossPartitionMetricsAvailable: false, containersAllocated: undefined },
    } as never);
    await waitFor(() => expect(section.querySelector('[data-testid="metric-containers-running"]')?.textContent).toContain("0"));
  });

  it("formats raw failures when neither cluster or ResourceManager metrics have loaded", async () => {
    const cluster = renderOverview(<ClusterMetricsSection />, false);
    await screen.findByText("Applications");
    const clusterQuery = cluster.client.getQueryCache().find({ queryKey: ov.metrics().queryKey })!;
    clusterQuery.setState({ ...clusterQuery.state, status: "error", error: "raw cluster metrics failure" as unknown as Error });
    expect(await screen.findByText("raw cluster metrics failure")).toBeTruthy();
    cluster.unmount();

    const emptyCluster = renderOverview(<ClusterMetricsSection />, false);
    await screen.findByText("Applications");
    const emptyClusterQuery = emptyCluster.client.getQueryCache().find({ queryKey: ov.metrics().queryKey })!;
    emptyClusterQuery.setState({ ...emptyClusterQuery.state, status: "error", error: null });
    expect(await screen.findByText("The ResourceManager did not return cluster metrics.")).toBeTruthy();
    emptyCluster.unmount();

    const resource = renderOverview(<ResourceManagerMetricsSection />, false);
    await screen.findByText("Applications");
    const resourceQuery = resource.client.getQueryCache().find({ queryKey: ov.metrics().queryKey })!;
    resourceQuery.setState({ ...resourceQuery.state, status: "error", error: null });
    expect(await screen.findByText("The ResourceManager did not return its resource counters.")).toBeTruthy();
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

  it("renders empty node labels and missing measurements with stale UTC context", async () => {
    prefsStore.setState((state) => ({ ...state, tz: "utc" }));
    connectionStore.setState((state) => ({ ...state, lastCache: "stale" }));
    const { client } = renderOverview(<NodeStatesSection metrics={undefined} />);
    const sparseNodes = JSON.parse(JSON.stringify(nodes)) as NodesResponse;
    const sparseNode = sparseNodes.nodes?.node[0];
    if (!sparseNode) throw new Error("nodes fixture must include a node");
    Object.assign(sparseNode, { rack: "", nodeLabels: [], memUtilization: undefined });
    client.setQueryData(ov.nodes().queryKey, sparseNodes);

    const table = await screen.findByRole("table", { name: "Registered nodes" });
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    expect(screen.getByText("Node state counts are unavailable.")).toBeTruthy();
    expect(screen.getByText("stale cache")).toBeTruthy();
    expect(table.textContent).toContain("—");
    expect(within(table).getAllByRole("progressbar", { name: /Physical memory utilization/ }).length).toBeGreaterThan(0);

    client.setQueryData(ov.nodes().queryKey, { nodes: { node: [] } });
    expect(await screen.findByRole("heading", { name: "No nodes registered" })).toBeTruthy();
  });

  it("shows node disclosure loading and stale summary states", async () => {
    const pending = renderOverview(<NodeStatesSection metrics={metrics} collapseInventory />, false);
    await screen.findByTestId("node-states");
    expect(screen.getByText("loading")).toBeTruthy();
    pending.unmount();

    connectionStore.setState((state) => ({ ...state, lastCache: "stale" }));
    const stale = renderOverview(<NodeStatesSection metrics={metrics} collapseInventory />);
    const expand = await screen.findByText("expand list");
    expect(expand.parentElement?.textContent).toContain("stale cache");
    fireEvent.click(expand.closest("summary")!);
    expect(await screen.findByRole("table", { name: "Registered nodes" })).toBeTruthy();
    stale.unmount();
  });

  it("renders raw node-list errors without metric counts or cached rows", async () => {
    const failed = renderOverview(<NodeStatesSection metrics={undefined} />, false);
    await screen.findByTestId("node-states");
    const query = failed.client.getQueryCache().find({ queryKey: ov.nodes().queryKey })!;
    query.setState({
      ...query.state,
      status: "error",
      error: "raw node-list response" as unknown as Error,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("raw node-list response")).toBeTruthy();
    expect(screen.getByText("Node state counts are unavailable.")).toBeTruthy();
    failed.unmount();

    const empty = renderOverview(<NodeStatesSection metrics={undefined} />, false);
    await screen.findByTestId("node-states");
    empty.client.setQueryData(ov.nodes().queryKey, { nodes: { node: [] } });
    const emptyQuery = empty.client.getQueryCache().find({ queryKey: ov.nodes().queryKey })!;
    emptyQuery.setState({
      ...emptyQuery.state,
      status: "error",
      error: new Error("empty node list refresh"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: emptyQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("Node list refresh failed; showing the last loaded result")).toBeTruthy();
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
    expect(screen.getByRole("link", { name: "ResourceManager unreachable" }).getAttribute("href")).toBe("#overview-cluster-identity");
    expect(screen.getByText("Spark History unreachable")).toBeTruthy();
    expect(screen.getByText("Timeline Service unreachable")).toBeTruthy();
    expect(screen.getByRole("link", { name: "1 unhealthy node" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "2 lost nodes" })).toBeTruthy();
    expect(screen.getByText(/ResourceManager allocation high: 9 of 10 vCores allocated/)).toBeTruthy();
    expect(screen.getByText(/memory allocated/)).toBeTruthy();
  });

  it("covers singular findings, zero-capacity counters, and known incomplete conditions", async () => {
    renderOverview(
      <OverviewAttentionSummary
        metrics={{
          ...metrics,
          unhealthyNodes: 2,
          lostNodes: 1,
          totalMB: 0,
          allocatedMB: 0,
          totalVirtualCores: 0,
          allocatedVirtualCores: 0,
        }}
        metricsPending={false}
        metricsError
      />,
    );
    expect(await screen.findByRole("heading", { name: "Needs attention" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "2 unhealthy nodes" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "1 lost node" })).toBeTruthy();
    expect(screen.getByText(/Known conditions are shown below/)).toBeTruthy();
  });

  it("shows the loading summary while metrics and cluster metadata are pending", async () => {
    renderOverview(<OverviewAttentionSummary metrics={undefined} metricsPending metricsError={false} />, false);
    expect(await screen.findByRole("status", { name: "Loading cluster attention summary" })).toBeTruthy();
  });
  it("shows an incomplete summary when metrics and metadata are unavailable", async () => {
    const { client } = renderOverview(<OverviewAttentionSummary metrics={undefined} metricsPending={false} metricsError />, false);
    await waitFor(() => expect(client.getQueryCache().find({ queryKey: ov.meta().queryKey })).toBeDefined());
    const metaQuery = client.getQueryCache().find({ queryKey: ov.meta().queryKey })!;
    metaQuery.setState({
      ...metaQuery.state,
      data: undefined,
      status: "error",
      error: new Error("cluster metadata unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: metaQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Status summary incomplete" })).toBeTruthy();
    expect(screen.getByText(/could not be confirmed/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Reported conditions" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Needs attention" })).toBeNull();
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

  it("renders one stale scheduler queue with configuration and metrics fallbacks", async () => {
    connectionStore.setState((state) => ({ ...state, lastCache: "stale" }));
    parityStore.setState(() => ({ enabled: false }));
    const { client } = renderOverview(<SchedulerSection collapseQueueTable />);
    const capacity = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/scheduler/capacity/scheduler.json"), "utf8")) as {
      scheduler: { schedulerInfo: { queues: { queue: Record<string, unknown>[] } } };
    };
    capacity.scheduler.schedulerInfo.queues.queue = capacity.scheduler.schedulerInfo.queues.queue.slice(0, 1);
    client.setQueryData(ov.scheduler().queryKey, capacity as never);
    client.setQueryData(ov.schedulerOverview().queryKey, null as never);
    client.setQueryData(tq.conf().queryKey, {
      properties: [
        { key: "yarn.scheduler.minimum-allocation-mb", value: "256" },
        { key: "yarn.scheduler.minimum-allocation-vcores", value: "1" },
      ],
    } as never);
    const scheduler = await screen.findByTestId("scheduler");
    expect(scheduler.textContent).toContain("upstream served stale cache");
    expect(scheduler.textContent).toContain("3 GiB · 4 vCores");
    expect(scheduler.querySelector('[data-yf="scheduler.derived.maxAllocationText"]')?.className).toContain("tnum");
    expect(scheduler.querySelector('[data-yf="scheduler.derived.minAllocationText"]')?.textContent).toContain("256");
    expect(await screen.findAllByText("1 row")).toHaveLength(2);
  });

  it("keeps a multi-line scheduler source failure to one line with technical details", async () => {
    const { client } = renderOverview(<SchedulerSection />);
    const query = client.getQueryCache().find({ queryKey: ov.schedulerOverview().queryKey })!;
    act(() =>
      query.setState({
        ...query.state,
        data: undefined,
        status: "error",
        error: new ApiError("java.lang.IllegalStateException: warming up\n\tat org.apache.hadoop.RM.start(RM.java:1)", "http", 503),
      }),
    );

    const section = await screen.findByTestId("scheduler");
    expect(section.textContent).toContain("HTTP 503: The upstream service returned HTTP 503.");
    expect(section.textContent).not.toContain("at org.apache.hadoop");
    fireEvent.click(within(section).getByText("Technical details"));
    expect(within(section).getByText(/at org\.apache\.hadoop/)).toBeTruthy();
  });

  it("shows a cluster-metrics failure once with technical details", async () => {
    const { client } = renderOverview(<SchedulerSection />);
    const query = client.getQueryCache().find({ queryKey: ov.metrics().queryKey })!;
    act(() =>
      query.setState({
        ...query.state,
        data: undefined,
        status: "error",
        error: new ApiError(
          "java.lang.IllegalStateException: metrics unavailable\n\tat org.apache.hadoop.RM.metrics(RM.java:1)",
          "http",
          503,
        ),
      }),
    );

    const section = await screen.findByTestId("scheduler");
    expect(within(section).getByText("Cluster metrics could not be read.")).toBeTruthy();
    expect(section.textContent).not.toContain("java.lang.IllegalStateException");
    fireEvent.click(within(section).getByText("Technical details"));
    expect(within(section).getByText(/java\.lang\.IllegalStateException/)).toBeTruthy();
  });

  it("formats missing scheduler metric-source errors", () => {
    expect(clusterMetricsUnavailableReason(new Error("dispatcher counters unavailable"))).toBe(
      "Cluster metrics unavailable: dispatcher counters unavailable",
    );
    expect(clusterMetricsUnavailableReason(null)).toBeNull();
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

  it("shows missing teaser values when the scheduler reports NaN counters", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:missing-queue-values");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { client } = renderOverview(<SchedulerSection />);
    const schedulerData = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/scheduler/capacity/scheduler.json"), "utf8")) as {
      scheduler: { schedulerInfo: { queues: { queue: Record<string, unknown>[] } } };
    };
    const defaultQueue = schedulerData.scheduler.schedulerInfo.queues.queue[0]!;
    defaultQueue.usedCapacity = "NaN";
    defaultQueue.absoluteUsedCapacity = "NaN";
    defaultQueue.absoluteCapacity = "NaN";
    defaultQueue.absoluteMaxCapacity = "NaN";
    defaultQueue.state = undefined;
    defaultQueue.allocatedContainers = undefined;
    defaultQueue.pendingContainers = undefined;
    defaultQueue.numActiveApplications = undefined;
    defaultQueue.numPendingApplications = undefined;
    client.setQueryData(ov.scheduler().queryKey, schedulerData as never);

    const table = await screen.findByRole("table", { name: "Queue headroom" });
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    const row = within(table).getByRole("row", { name: /root\.default/ });
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(4);

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
  });

  it("shows FIFO's empty queue state when optional scheduler facts are absent", async () => {
    const { client } = renderOverview(<SchedulerSection />);
    const fifo = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/scheduler/fifo/scheduler.json"), "utf8"));
    client.setQueryData(ov.scheduler().queryKey, fifo as never);
    client.setQueryData(ov.schedulerOverview().queryKey, null as never);
    client.setQueryData(tq.conf().queryKey, [] as never);
    client.setQueryData(ov.metrics().queryKey, {
      clusterMetrics: {
        ...metrics,
        rmSchedulerBusyPercent: null,
        rmEventQueueSize: null,
        schedulerEventQueueSize: null,
      },
    } as never);

    expect(await screen.findByText("The Fifo Scheduler has a single unnamed queue: there is no queue tree to show.")).toBeTruthy();
    const scheduler = screen.getByTestId("scheduler");
    expect(scheduler.textContent).toContain("Application priority was not reported.");
    expect(scheduler.textContent).toContain("Scheduler load was not reported.");
    expect(scheduler.textContent).toContain("Queue activity was not reported.");
    expect(scheduler.textContent).toContain("Minimum allocation was not reported.");
    expect(scheduler.textContent).toContain("Maximum allocation was not reported.");
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

  it("shows Error messages from either scheduler source when both sources are unavailable", async () => {
    const overviewFailure = renderOverview(<SchedulerSection />);
    const overviewQuery = overviewFailure.client.getQueryCache().find({ queryKey: ov.schedulerOverview().queryKey })!;
    const schedulerQuery = overviewFailure.client.getQueryCache().find({ queryKey: ov.scheduler().queryKey })!;
    overviewQuery.setState({
      ...overviewQuery.state,
      data: undefined,
      status: "error",
      error: new Error("overview source offline"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: overviewQuery.state.errorUpdateCount + 1,
    });
    schedulerQuery.setState({
      ...schedulerQuery.state,
      data: undefined,
      status: "error",
      error: new Error("scheduler source offline"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: schedulerQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("overview source offline")).toBeTruthy();
    overviewFailure.unmount();

    const schedulerFailure = renderOverview(<SchedulerSection />);
    const rawOverviewQuery = schedulerFailure.client.getQueryCache().find({ queryKey: ov.schedulerOverview().queryKey })!;
    const errorSchedulerQuery = schedulerFailure.client.getQueryCache().find({ queryKey: ov.scheduler().queryKey })!;
    rawOverviewQuery.setState({
      ...rawOverviewQuery.state,
      data: undefined,
      status: "error",
      error: "raw overview failure" as unknown as Error,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: rawOverviewQuery.state.errorUpdateCount + 1,
    });
    errorSchedulerQuery.setState({
      ...errorSchedulerQuery.state,
      data: undefined,
      status: "error",
      error: new Error("scheduler source error"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: errorSchedulerQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("scheduler source error")).toBeTruthy();
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

  it("shows raw scheduler overview and configuration errors while retaining REST data", async () => {
    const overviewFailure = renderOverview(<SchedulerSection />);
    const overviewQuery = overviewFailure.client.getQueryCache().find({ queryKey: ov.schedulerOverview().queryKey })!;
    overviewQuery.setState({
      ...overviewQuery.state,
      data: undefined,
      status: "error",
      error: "raw scheduler overview failure" as unknown as Error,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: overviewQuery.state.errorUpdateCount + 1,
    });
    const confQuery = overviewFailure.client.getQueryCache().find({ queryKey: tq.conf().queryKey })!;
    confQuery.setState({
      ...confQuery.state,
      data: undefined,
      status: "error",
      error: "raw scheduler configuration failure" as unknown as Error,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: confQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("raw scheduler overview failure")).toBeTruthy();
    expect(await screen.findByText("raw scheduler configuration failure")).toBeTruthy();
    overviewFailure.unmount();

    const queueFailure = renderOverview(<SchedulerSection />);
    const schedulerQuery = queueFailure.client.getQueryCache().find({ queryKey: ov.scheduler().queryKey })!;
    schedulerQuery.setState({
      ...schedulerQuery.state,
      data: undefined,
      status: "error",
      error: "raw queue tree failure" as unknown as Error,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: schedulerQuery.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Queue data is unavailable" })).toBeTruthy();
    expect(screen.getByText("raw queue tree failure")).toBeTruthy();
  });

  it("reports when the scheduler source has no type discriminator", async () => {
    const { client } = renderOverview(<SchedulerSection />);
    const schedulerData = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/scheduler/capacity/scheduler.json"), "utf8")) as {
      scheduler: { schedulerInfo: Record<string, unknown> };
    };
    delete schedulerData.scheduler.schedulerInfo.type;
    client.setQueryData(ov.scheduler().queryKey, schedulerData as never);
    client.setQueryData(ov.schedulerOverview().queryKey, null as never);
    client.setQueryData(tq.conf().queryKey, [] as never);
    expect(await screen.findByText("scheduler type not reported")).toBeTruthy();
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
