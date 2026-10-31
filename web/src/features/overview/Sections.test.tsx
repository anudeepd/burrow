import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClusterMetrics, NodesResponse } from "~/api/schemas";

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { ApiError } = await import("~/api/client");
const { tq } = await import("~/api/queries/tools");
const { ov } = await import("~/api/queries/overview");
const { SchedulerSection } = await import("./scheduler");
const { ClusterMetricsSection, ResourceManagerMetricsSection } = await import("./cluster-metrics");
const { NodeStatesSection } = await import("./node-states");
const { OverviewAttentionSummary } = await import("./attention-summary");

const FIXTURE = resolve(process.cwd(), "../fixtures/rm/overview");
const nodesFile = resolve(process.cwd(), "../fixtures/rm/nodes/nodes.json");
const metrics = (JSON.parse(readFileSync(`${FIXTURE}/metrics.json`, "utf8")) as { clusterMetrics: ClusterMetrics }).clusterMetrics;
const nodes = JSON.parse(readFileSync(nodesFile, "utf8")) as NodesResponse;

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
    client.setQueryData(
      ov.scheduler().queryKey,
      JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/scheduler/capacity/scheduler.json"), "utf8")),
    );
    client.setQueryData(
      ov.schedulerOverview().queryKey,
      JSON.parse(readFileSync(`${FIXTURE}/scheduler-overview.json`, "utf8")),
    );
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
  return { ...view, client };
}

afterEach(() => cleanup());

describe("overview sections", () => {
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

  it("summarizes unreachable services, node health, and high resource pressure", async () => {
    renderOverview(<OverviewAttentionSummary metrics={metrics} metricsPending={false} metricsError={false} />);
    expect(await screen.findByRole("heading", { name: "Needs attention" })).toBeTruthy();
    expect(screen.getByText("ResourceManager unreachable")).toBeTruthy();
    expect(screen.getByText("Spark History unreachable")).toBeTruthy();
    expect(screen.getByText("Timeline Service unreachable")).toBeTruthy();
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
    const { client } = renderOverview(<SchedulerSection />);
    client.setQueryData(ov.schedulerOverview().queryKey, null as never);
    client.setQueryData(ov.scheduler().queryKey, null as never);
    expect(await screen.findByRole("heading", { name: "The scheduler did not answer" })).toBeTruthy();
  });

  it("renders a compact loading skeleton while both scheduler sources are pending", async () => {
    renderOverview(<SchedulerSection />, false);
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(screen.queryByTestId("scheduler")).toBeNull();
  });

  it("reports a scheduler-overview read error and keeps the REST fallback", async () => {
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
  });

  it("uses overview allocation values and reports when configuration could not be loaded", async () => {
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
  });

  it("keeps cached scheduler values visible when the three refreshes fail", async () => {
    const { client } = renderOverview(<SchedulerSection />);
    const queries = [ov.schedulerOverview(), ov.scheduler(), tq.conf()].map(({ queryKey }) =>
      client.getQueryCache().find({ queryKey })!,
    );
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
