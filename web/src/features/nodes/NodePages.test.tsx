import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Node, NodesResponse, NodeLabelsResponse } from "~/api/schemas";
import type { NmContainer } from "~/api/queries/nodes";

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { nq } = await import("~/api/queries/nodes");
const { NodesPage } = await import("./NodesPage");
const { NodeLabelsPage } = await import("./NodeLabelsPage");
const { NodeDetail } = await import("./NodeDetail");
const { NodeContainers } = await import("./NodeContainers");
const { nodesSearchSchema, nodeLabelsSearchSchema } = await import("./search");

const FIXTURES = resolve(process.cwd(), "../fixtures/rm/nodes");
const readJson = (name: string) => JSON.parse(readFileSync(`${FIXTURES}/${name}`, "utf8")) as unknown;
const nodesResponse = readJson("nodes.json") as NodesResponse;
const nodeLabelsResponse = readJson("get-node-labels.json") as NodeLabelsResponse;
const nodeEntries = nodesResponse.nodes?.node as Node[] | undefined;
if (!nodeEntries?.[0]) throw new Error("nodes fixture has no node");
const node = nodeEntries[0];

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
    routeTree: root.addChildren([route]),
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
  };
}

function renderNodeDetail() {
  const root = createRootRoute();
  const detail = createRoute({ getParentRoute: () => root, path: "/nodes/$nodeId", component: NodeDetail });
  const nodesRoute = createRoute({ getParentRoute: () => root, path: "/nodes", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([detail, nodesRoute]),
    history: createMemoryHistory({ initialEntries: [`/nodes/${encodeURIComponent(node.id)}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(nq.node(node.id).queryKey, readJson("node-127.0.0.2_8041.json") as never);
  const nmInfo = readJson("nm-127.0.0.2_8042-info.json") as { nodeInfo: unknown };
  const nmContainers = readJson("nm-127.0.0.2_8042-containers.json") as { containers?: { container?: unknown[] } };
  client.setQueryData(nq.nmInfo(node.nodeHTTPAddress).queryKey, nmInfo.nodeInfo as never);
  client.setQueryData(nq.nmContainers(node.nodeHTTPAddress).queryKey, (nmContainers.containers?.container ?? []) as never);
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("node pages", () => {
  it("renders the node inventory and its summary cards", async () => {
    renderNodeRoute("nodes", "?q=127.0.0.2");
    expect(await screen.findByRole("table", { name: "Cluster nodes" })).toBeTruthy();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unhealthy").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/127\.0\.0\.2/).length).toBeGreaterThan(0);
  });

  it("derives the default label and renders its node mapping view", async () => {
    renderNodeRoute("labels", "?open=gpu");
    expect(await screen.findByRole("table", { name: "Node labels" })).toBeTruthy();
    expect(screen.getByText("<DEFAULT_PARTITION>")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Nodes in gpu" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Node to label mapping" }));
    expect(await screen.findByText("Node to label mapping")).toBeTruthy();
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
    expect(screen.getByRole("table", { name: "Containers on this node" })).toBeTruthy();
    expect(screen.getByText(container.id)).toBeTruthy();
    expect(screen.getByRole("link", { name: "app" }).getAttribute("href")).toContain("/apps/application_");
    view.rerender(<NodeContainers node={{ ...node, nodeHTTPAddress: "" }} loading={false} error={null} onRetry={() => {}} />);
    expect(screen.getByText("Containers are not readable")).toBeTruthy();
  });

  it("renders ResourceManager and NodeManager details with the captured node snapshot", async () => {
    renderNodeDetail();
    expect(await screen.findByLabelText("Node details")).toBeTruthy();
    expect(screen.getByText("Node (ResourceManager)")).toBeTruthy();
    expect(screen.getByText("NodeManager")).toBeTruthy();
    expect(screen.getByText("Node-local logs")).toBeTruthy();
    expect(screen.getByRole("link", { name: /NodeManager UI/ })).toBeTruthy();
  });
});
