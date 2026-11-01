import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node, NodesResponse, NodeLabelsResponse } from "~/api/schemas";
import type { NmContainer } from "~/api/queries/nodes";

window.__BURROW_PARITY__ = true;

const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { nq } = await import("~/api/queries/nodes");
const { NodesPage } = await import("./NodesPage");
const { CopyButton } = await import("./page");
const { NodeLabelsPage } = await import("./NodeLabelsPage");
const { NodeDetail } = await import("./NodeDetail");
const { NodeContainers } = await import("./NodeContainers");
const { RackHeatmap } = await import("./RackHeatmap");
const { nodesSearchSchema, nodeLabelsSearchSchema } = await import("./search");

const FIXTURES = resolve(process.cwd(), "../fixtures/rm/nodes");
const readJson = (name: string) => JSON.parse(readFileSync(`${FIXTURES}/${name}`, "utf8")) as unknown;
const nodesResponse = readJson("nodes.json") as NodesResponse;
const nodeLabelsResponse = readJson("get-node-labels.json") as NodeLabelsResponse;
const nodeEntries = nodesResponse.nodes?.node as Node[] | undefined;
if (!nodeEntries?.[0]) throw new Error("nodes fixture has no node");
const node = nodeEntries[0];
const nodeDetailResponse = readJson("node-127.0.0.2_8041.json") as { node: Node };
const detailNode = nodeDetailResponse.node;
const detailNodeAddress = detailNode.nodeHTTPAddress ?? "";

function renderNodeRoute(page: "nodes" | "labels", search = "") {
  const root = createRootRoute();
  const route =
    page === "nodes"
      ? createRoute({ getParentRoute: () => root, path: "/nodes/", validateSearch: nodesSearchSchema, component: NodesPage })
      : createRoute({
          getParentRoute: () => root,
          path: "/node-labels",
          validateSearch: nodeLabelsSearchSchema,
          component: NodeLabelsPage,
        });
  const router = createRouter({
    routeTree:
      page === "nodes"
        ? root.addChildren([route, createRoute({ getParentRoute: () => root, path: "/nodes/$nodeId", component: () => null })])
        : root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`${page === "nodes" ? "/nodes/" : "/node-labels"}${search}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(nq.nodes().queryKey, nodesResponse);
  client.setQueryData(nq.nodeLabels().queryKey, nodeLabelsResponse);
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

function renderNodeDetail(seedNode = true) {
  const root = createRootRoute();
  const detail = createRoute({ getParentRoute: () => root, path: "/nodes/$nodeId", component: NodeDetail });
  const nodesRoute = createRoute({ getParentRoute: () => root, path: "/nodes", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([detail, nodesRoute]),
    history: createMemoryHistory({ initialEntries: [`/nodes/${encodeURIComponent(detailNode.id)}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  if (seedNode) client.setQueryData(nq.node(detailNode.id).queryKey, nodeDetailResponse as never);
  const nmInfo = readJson("nm-127.0.0.2_8042-info.json") as { nodeInfo: unknown };
  const nmContainers = readJson("nm-127.0.0.2_8042-containers.json") as { containers?: { container?: unknown[] } };
  client.setQueryData(nq.nmInfo(detailNodeAddress).queryKey, nmInfo.nodeInfo as never);
  client.setQueryData(nq.nmContainers(detailNodeAddress).queryKey, (nmContainers.containers?.container ?? []) as never);
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("node pages", () => {
  it("renders the node inventory and its summary cards", async () => {
    renderNodeRoute("nodes", "?q=127.0.0.2");
    expect(await screen.findByRole("table", { name: "Cluster nodes" })).toBeTruthy();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unhealthy").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/127\.0\.0\.2/).length).toBeGreaterThan(0);
  });

  it("switches node views, filters state, selects a rack cell, and opens a node row", async () => {
    const { router } = renderNodeRoute("nodes");
    await screen.findByRole("table", { name: "Cluster nodes" });

    fireEvent.click(screen.getByRole("button", { name: "Rack heatmap view" }));
    await waitFor(() => expect(router.state.location.search.view).toBe("heatmap"));
    const cell = screen.getAllByRole("button").find((button) => button.getAttribute("aria-label")?.includes("vcores"));
    expect(cell).toBeTruthy();
    fireEvent.click(cell!);
    await waitFor(() => expect(router.state.location.search.sel).toBeTruthy());
    const unhealthy = screen.getByRole("tab", { name: /Unhealthy/ });
    fireEvent.click(unhealthy);
    await waitFor(() => expect(router.state.location.search.state).toBe("UNHEALTHY"));
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    await waitFor(() => expect(router.state.location.search.state).toBe("ALL"));

    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    await screen.findByRole("table", { name: "Cluster nodes" });
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    const table = screen.getByRole("table", { name: "Cluster nodes" });
    fireEvent.click(table.querySelector('[data-col="id"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBeTruthy());
    const firstNode = screen.getAllByRole("row").find((row) => row.textContent?.includes(":"));
    expect(firstNode).toBeTruthy();
    const nmUiLink = firstNode!.querySelector<HTMLAnchorElement>('a[aria-label^="Open the NodeManager UI"]');
    expect(nmUiLink).not.toBeNull();
    nmUiLink!.addEventListener("click", (event) => event.preventDefault(), { once: true });
    nmUiLink!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(router.state.location.pathname).toBe("/nodes");
    const nodeLink = firstNode!.querySelector<HTMLAnchorElement>('a[href^="/nodes/"]');
    expect(nodeLink).not.toBeNull();
    fireEvent.click(nodeLink!);
    await waitFor(() => expect(router.state.location.pathname).not.toBe("/nodes/"));
    await router.navigate({ to: "/nodes" });
    await screen.findByRole("table", { name: "Cluster nodes" });
    const reopenedNodeTable = screen.getByRole("table", { name: "Cluster nodes" });
    const reopenedFirstNode = reopenedNodeTable.querySelector<HTMLElement>('[role="row"][aria-rowindex="2"]');
    expect(reopenedFirstNode).toBeTruthy();
    fireEvent.click(reopenedFirstNode!);
    await waitFor(() => expect(router.state.location.pathname).not.toBe("/nodes/"));
  });

  it("opens a node from the rack heatmap by double-clicking its cell", async () => {
    const { router } = renderNodeRoute("nodes");
    await screen.findByRole("table", { name: "Cluster nodes" });
    fireEvent.click(screen.getByRole("button", { name: "Rack heatmap view" }));
    await waitFor(() => expect(router.state.location.search.view).toBe("heatmap"));
    const cell = screen.getAllByRole("button").find((button) => button.getAttribute("aria-label")?.includes("vcores"));
    expect(cell).toBeTruthy();
    fireEvent.doubleClick(cell!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nodes\//));
  });

  it("filters nodes by search, label, and rack, clears them, and opens a top consumer", async () => {
    const { router, client } = renderNodeRoute("nodes");
    await screen.findByRole("table", { name: "Cluster nodes" });
    const raw = client.getQueryData(nq.nodes().queryKey) as NodesResponse;
    const loaded = raw.nodes?.node as Node[];
    client.setQueryData(nq.nodes().queryKey, {
      nodes: { node: loaded.map((entry, index) => ({ ...entry, numContainers: index === 0 ? 8 : index })) },
    });

    const choose = async (label: string, optionName: string) => {
      fireEvent.click(screen.getByRole("combobox", { name: label }));
      const option = await screen.findByRole("option", { name: optionName });
      fireEvent.pointerDown(option, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
      fireEvent.click(option);
    };
    await choose("Label filter", "gpu");
    await waitFor(() => expect(router.state.location.search.label).toBe("gpu"));
    await choose("Rack filter", "/rack1");
    await waitFor(() => expect(router.state.location.search.rack).toBe("/rack1"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search nodes" }), { target: { value: "missing-node" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("missing-node"));
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(router.state.location.search.q).toBeUndefined());
    fireEvent.change(screen.getByRole("searchbox", { name: "Search nodes" }), { target: { value: "missing-node" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("missing-node"));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("label"));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("rack"));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("q"));

    fireEvent.click(screen.getAllByTestId("top-consumer-row")[0]!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nodes\//));
  });

  it("copies a value and clears the confirmation timer when the control unmounts", async () => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const view = render(<CopyButton value="worker:8041" label="Copy node id" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy node id" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("worker:8041");
    view.unmount();
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
    vi.useRealTimers();
  });

  it("derives the default label and renders its node mapping view", async () => {
    const { router } = renderNodeRoute("labels", "?open=gpu");
    expect(await screen.findByRole("table", { name: "Node labels" })).toBeTruthy();
    expect(screen.getByText("<DEFAULT_PARTITION>")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Nodes in gpu" })).toBeTruthy();
    fireEvent.click(screen.getByRole("row", { name: /gpu/ }));
    await waitFor(() => expect(router.state.location.search.open).toBeUndefined());
    fireEvent.click(screen.getByRole("button", { name: "Node to label mapping" }));
    const mapping = await screen.findByRole("table", { name: "Node to label mapping" });
    for (const column of ["rack", "state"]) {
      fireEvent.click(mapping.querySelector(`[data-col="${column}"] button`)!);
      await waitFor(() => expect(router.state.location.search.mappingSort).toContain(`${column}:`));
    }
  });

  it("sorts, hides optional columns, and filters the node label catalogue", async () => {
    const { router } = renderNodeRoute("labels");
    const table = await screen.findByRole("table", { name: "Node labels" });
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    fireEvent.click(table.querySelector('[data-col="name"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBe("name:asc"));
    for (const column of ["type", "activeNMs", "resource", "nodes"]) {
      fireEvent.click(table.querySelector(`[data-col="${column}"] button`)!);
      await waitFor(() => expect(router.state.location.search.sort).toContain(`${column}:`));
    }

    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Mapped nodes" }));
    await waitFor(() => expect(router.state.location.search.hide).toContain("nodes"));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search labels" }), { target: { value: "gpu" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("gpu"));
    expect(table.textContent).toContain("gpu");
    expect(table.textContent).not.toContain("<DEFAULT_PARTITION>");
  });

  it("shows stale label-source warnings and fatal label or node read errors", async () => {
    const cached = renderNodeRoute("labels");
    const labels = cached.client.getQueryCache().find({ queryKey: nq.nodeLabels().queryKey })!;
    labels.setState({
      ...labels.state,
      status: "error",
      error: new Error("label refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: labels.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText(/Node labels refresh failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    cached.unmount();
    cleanup();

    const labelFailure = renderNodeRoute("labels");
    const missingLabels = labelFailure.client.getQueryCache().find({ queryKey: nq.nodeLabels().queryKey })!;
    missingLabels.setState({
      ...missingLabels.state,
      data: undefined,
      status: "error",
      error: new Error("labels unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: missingLabels.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Cannot read the node labels" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    labelFailure.unmount();
    cleanup();

    const nodeFailure = renderNodeRoute("labels");
    const missingNodes = nodeFailure.client.getQueryCache().find({ queryKey: nq.nodes().queryKey })!;
    missingNodes.setState({
      ...missingNodes.state,
      data: undefined,
      status: "error",
      error: new Error("nodes unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: missingNodes.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Cannot read nodes for label membership" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("shows and retries stale node membership while keeping the label catalogue", async () => {
    const cached = renderNodeRoute("labels");
    const nodes = cached.client.getQueryCache().find({ queryKey: nq.nodes().queryKey })!;
    nodes.setState({
      ...nodes.state,
      status: "error",
      error: new Error("node membership refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: nodes.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText(/Node list refresh failed/)).toBeTruthy();
    expect(screen.getByRole("table", { name: "Node labels" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("keeps stale node rows visible and retries fatal node-list errors", async () => {
    const stale = renderNodeRoute("nodes");
    const loadedNodes = stale.client.getQueryCache().find({ queryKey: nq.nodes().queryKey })!;
    loadedNodes.setState({
      ...loadedNodes.state,
      status: "error",
      error: new Error("node refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: loadedNodes.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText(/Node list refresh failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(screen.getByRole("table", { name: "Cluster nodes" })).toBeTruthy();
    stale.unmount();
    cleanup();

    const failed = renderNodeRoute("nodes");
    const missingNodes = failed.client.getQueryCache().find({ queryKey: nq.nodes().queryKey })!;
    missingNodes.setState({
      ...missingNodes.state,
      data: undefined,
      status: "error",
      error: new Error("node list unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: missingNodes.state.errorUpdateCount + 1,
    });
    expect(await screen.findByRole("heading", { name: "Cannot read the node list" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("filters the read-only node-to-label matrix and persists its table controls", async () => {
    const { router } = renderNodeRoute("labels", "?view=mapping");
    const table = await screen.findByRole("table", { name: "Node to label mapping" });
    const checkboxes = [...table.querySelectorAll('input[type="checkbox"]')];
    expect(checkboxes.length).toBeGreaterThan(0);
    expect(checkboxes.every((input) => (input as HTMLInputElement).disabled)).toBe(true);

    fireEvent.click(table.querySelector('[data-col="id"] button')!);
    await waitFor(() => expect(router.state.location.search.mappingSort).toBe("id:asc"));
    for (const header of table.querySelectorAll('[role="columnheader"] button')) fireEvent.click(header);

    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Rack" }));
    await waitFor(() => expect(router.state.location.search.mappingHide).toContain("rack"));

    fireEvent.change(screen.getByPlaceholderText("host, rack, label…"), { target: { value: "no-such-node" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("no-such-node"));
    expect(await screen.findByText("Clear the search box.")).toBeTruthy();
  });

  it("shows NodeManager container details and handles missing addresses", () => {
    const container: NmContainer = {
      id: "container_1791010984040_0002_01_000001",
      nodeId: node.id,
      state: "RUNNING",
      exitCode: 0,
      user: "alice",
      totalMemoryNeededMB: 1024,
      totalVCoresNeeded: 1,
      containerLogsShortLink: "/tools/logs?container=container_1791010984040_0002_01_000001",
    };
    const view = render(<NodeContainers node={node} containers={[container]} loading={false} error={null} onRetry={() => {}} />);
    const table = screen.getByRole("table", { name: "Containers on this node" });
    expect(table).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    expect(screen.getByText(container.id)).toBeTruthy();
    const appLink = screen.getByRole("link", { name: "app" });
    expect(appLink.getAttribute("href")).toContain("/apps/application_");
    fireEvent.click(appLink);
    view.rerender(<NodeContainers node={{ ...node, nodeHTTPAddress: "" }} loading={false} error={null} onRetry={() => {}} />);
    expect(screen.getByText("Containers are not readable")).toBeTruthy();
  });

  it("handles NodeManager container errors, empty results, and direct log links", async () => {
    const onRetry = vi.fn();
    const unavailable = render(<NodeContainers node={node} loading={false} error={new Error("NM timed out")} onRetry={onRetry} />);
    expect(screen.getByRole("heading", { name: "Cannot read the NodeManager's container list" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(onRetry).toHaveBeenCalledOnce();
    unavailable.unmount();

    const empty = render(<NodeContainers node={node} containers={[]} loading={false} error={null} onRetry={onRetry} />);
    expect(await screen.findByText("No containers on this node")).toBeTruthy();
    empty.unmount();

    const noAppId: NmContainer = {
      id: "container-without-an-application-id",
      nodeId: node.id,
      state: "COMPLETE",
      exitCode: 1,
      exitStatus: "DISKS_FAILED",
      diagnostics: "Local disk failure",
      user: "bob",
      totalMemoryNeededMB: 512,
      totalVCoresNeeded: 2,
      containerLogFiles: ["stderr", "stdout"],
    };
    const withCachedRows = render(
      <NodeContainers node={node} containers={[noAppId]} loading={false} error={new Error("refresh failed")} onRetry={onRetry} />,
    );
    expect(await screen.findByText(/Container refresh failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    const table = screen.getByRole("table", { name: "Containers on this node" });
    for (const header of table.querySelectorAll('[role="columnheader"] button')) fireEvent.click(header);
    const logsLink = screen.getByRole("link", { name: "2 files" });
    expect(logsLink.getAttribute("href")).toContain("/api/logs/containers/container-without-an-application-id");
    fireEvent.click(logsLink);
    expect(screen.getByText("Local disk failure")).toBeTruthy();
    withCachedRows.unmount();
  });

  it("renders ResourceManager and NodeManager details with the captured node snapshot", async () => {
    renderNodeDetail();
    expect(await screen.findByLabelText("Node details")).toBeTruthy();
    expect(screen.getByText("Node (ResourceManager)")).toBeTruthy();
    expect(screen.getByText("NodeManager")).toBeTruthy();
    expect(screen.getByText("Node-local logs")).toBeTruthy();
    expect(screen.getByRole("link", { name: /NodeManager UI/ })).toBeTruthy();
  });

  it("keeps stale NodeManager details and retries the refresh", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "retry failed" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const stale = renderNodeDetail();
    const infoQuery = stale.client.getQueryCache().find({ queryKey: nq.nmInfo(detailNodeAddress).queryKey })!;
    act(() => {
      infoQuery.setState({
        ...infoQuery.state,
        status: "error",
        error: new Error("NodeManager refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: infoQuery.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByText("NodeManager refresh failed; showing the last loaded details")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    stale.unmount();
  });

  it("shows loading, RM failure, stale NodeManager data, attributes, and retry actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const loading = renderNodeDetail(false);
    expect(await screen.findByLabelText("Loading node")).toBeTruthy();
    loading.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const failed = renderNodeDetail();
    await screen.findByLabelText("Node details");
    const nodeQuery = failed.client.getQueryCache().find({ queryKey: nq.node(detailNode.id).queryKey })!;
    nodeQuery.setState({
      ...nodeQuery.state,
      data: undefined,
      status: "error",
      error: new Error("node endpoint failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: nodeQuery.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
    expect(await screen.findByRole("heading", { name: "Cannot read this node" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    failed.unmount();
    cleanup();

    const detail = renderNodeDetail();
    await screen.findByLabelText("Node details");
    const nodeResponse = detail.client.getQueryData(nq.node(detailNode.id).queryKey) as { node: Node };
    act(() => {
      detail.client.setQueryData(nq.node(detailNode.id).queryKey, {
        node: {
          ...nodeResponse.node,
          nodeAttributesInfo: { nodeAttributeInfo: [{ prefix: "rack", name: "gpu", type: "STRING", value: "a100" }] },
        },
      });
    });
    expect(await screen.findByRole("heading", { name: "Node attributes" })).toBeTruthy();
    expect(screen.getByText("a100")).toBeTruthy();

    const infoQuery = detail.client.getQueryCache().find({ queryKey: nq.nmInfo(detailNodeAddress).queryKey })!;
    act(() => {
      infoQuery.setState({
        ...infoQuery.state,
        data: undefined,
        status: "error",
        error: new Error("NodeManager unavailable"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: infoQuery.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    const nmErrorHeading = await screen.findByRole("heading", { name: "Cannot read the NodeManager" });
    expect(nmErrorHeading).toBeTruthy();
    fireEvent.click(within(nmErrorHeading.closest("section")!).getByRole("button", { name: "Retry now" }));

    const containersQuery = detail.client.getQueryCache().find({ queryKey: nq.nmContainers(detailNodeAddress).queryKey })!;
    containersQuery.setState({
      ...containersQuery.state,
      data: undefined,
      status: "error",
      error: new Error("NodeManager containers failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: containersQuery.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
    expect((await screen.findAllByRole("button", { name: "Retry now" })).length).toBeGreaterThan(0);
    for (const retry of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(retry);
  });

  it("renders rack heatmap bands and sends single- and double-click selections", () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const idle: Node = {
      ...node,
      id: "idle:8041",
      nodeHostName: "idle-host",
      rack: "",
      state: "RUNNING",
      numContainers: 1,
      memUtilization: 0,
      cpuUtilization: 0,
    };
    const full: Node = {
      ...node,
      id: "full:8041",
      nodeHostName: "full-host",
      rack: "/rack-a",
      state: "UNHEALTHY",
      numContainers: 2,
      memUtilization: 95,
      cpuUtilization: 80,
    };
    const view = render(<RackHeatmap nodes={[idle, full]} selected={idle.id} onSelect={onSelect} onOpen={onOpen} />);
    expect(screen.getByRole("heading", { name: "/default-rack" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "/rack-a" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /idle:8041/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /full:8041/ }).getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector('[data-yf="node.memUtilization"][data-yv="0"]')).toBeTruthy();
    expect(document.querySelector('[data-yf="node.cpuUtilization"][data-yv="80"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /idle:8041/ }));
    fireEvent.doubleClick(screen.getByRole("button", { name: /full:8041/ }));
    expect(onSelect).toHaveBeenCalledWith(idle);
    expect(onOpen).toHaveBeenCalledWith(full);
    view.unmount();

    render(<RackHeatmap nodes={[]} onSelect={onSelect} onOpen={onOpen} />);
    expect(screen.getByText("Widen the state tab or clear the filters to see the racks.")).toBeTruthy();
  });
});
