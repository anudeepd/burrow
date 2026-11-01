import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, AppAttempt, Container } from "~/api/schemas";

vi.mock("../table-state", () => ({
  useLocalTableState: () => ({
    sorting: [
      "containerId",
      "nodeHttpAddress",
      "containerState",
      "resources",
      "containerExitStatus",
      "logs",
      "priority",
      "allocationRequestId",
      "resourceName",
      "numContainers",
      "relaxLocality",
      "nodeLabelExpression",
      "allocationTags",
      "placementConstraint",
      "executionType",
      "capability",
    ].map((id) => ({ id, desc: false })),
    setSorting: vi.fn(),
    visibility: {
      containerId: true,
      nodeHttpAddress: true,
      containerState: true,
      resources: true,
      containerExitStatus: true,
      logs: true,
      priority: true,
      allocationRequestId: true,
      resourceName: true,
      numContainers: true,
      relaxLocality: true,
      nodeLabelExpression: true,
      allocationTags: true,
      placementConstraint: true,
      executionType: true,
      capability: true,
    },
    setVisibility: vi.fn(),
    defaults: {},
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: Array.from({ length: index }, (_, i) => estimateSize(i)).reduce((sum, height) => sum + height, 0),
      })),
    getTotalSize: () => Array.from({ length: count }, (_, index) => estimateSize(index)).reduce((sum, height) => sum + height, 0),
    measure: vi.fn(),
  }),
}));

const { cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { AttemptDetail } = await import("./AttemptDetail");

const FIXTURE = resolve(process.cwd(), "../fixtures/rm/app/running");
const readJson = (name: string) => JSON.parse(readFileSync(resolve(FIXTURE, name), "utf8")) as unknown;
const attemptId = "appattempt_1791010984040_0001_000001";
const appPayload = (readJson("app.json") as { app: App }).app;
const attempt = (readJson("appattempts.json") as { appAttempts: { appAttempt: AppAttempt[] } }).appAttempts.appAttempt[0]!;
const containers = (readJson("containers-appattempt_1791010984040_0001_000001.json") as { container: Container[] }).container;

function renderDetail() {
  const requests = [
    {
      priority: 1,
      allocationRequestId: 7,
      resourceName: "*",
      capability: { memory: 1024, vCores: 1 },
      numContainers: 2,
      relaxLocality: true,
      nodeLabelExpression: "",
      executionTypeRequest: { executionType: "GUARANTEED", enforceExecutionType: true },
      placementConstraint: "allocation-tag=analytics",
      allocationTags: ["analytics"],
    },
    {
      priority: 2,
      allocationRequestId: 8,
      resourceName: "/rack-1",
      capability: { memory: 2048, vCores: 2 },
      numContainers: 1,
      relaxLocality: false,
      nodeLabelExpression: "gpu",
      executionTypeRequest: { executionType: "OPPORTUNISTIC", enforceExecutionType: false },
      placementConstraint: "",
      allocationTags: [],
    },
  ];
  const app = { ...appPayload, resourceRequests: requests } as App;
  const root = createRootRoute();
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <AttemptDetail
        app={app}
        attempt={attempt}
        containers={containers}
        containersUnavailable={false}
        detail={{
          appAttemptId: attemptId,
          host: "127.0.0.4",
          rpcPort: 43981,
          trackingUrl: "http://rm:8088/proxy/application/",
          diagnosticsInfo: "Attempt diagnostics",
          appAttemptState: "RUNNING",
        }}
        now={attempt.startTime + 10_000}
      />
    ),
  });
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/apps/$appId", component: () => null }),
    createRoute({ getParentRoute: () => root, path: "/apps/$appId/containers/$containerId", component: () => null }),
  ];
  const router = createRouter({ routeTree: root.addChildren([home, ...routes]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, refetchOnMount: false } } });
  client.setQueryData(q.meta().queryKey, {
    name: "Burrow",
    version: "0.1.0",
    now: 1_791_011_000_000,
    readOnly: true,
    rm: { urls: ["http://rm:8088"], active: "http://rm:8088", reachable: true },
    services: {
      sparkHistory: { configured: false, url: null, reachable: null },
      jobHistory: { configured: false, url: null, reachable: null },
      timeline: { configured: false, url: null, reachable: null },
    },
    features: { sparkLive: false, sparkHistory: false, aggregatedLogs: true, nodeLogs: true, events: false, kerberos: false },
    yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

afterEach(() => cleanup());

describe("AttemptDetail", () => {
  it("sorts and renders every container and outstanding request field", async () => {
    renderDetail();

    expect(await screen.findByText("Attempt 1")).toBeTruthy();
    const containerTable = screen.getByRole("table", { name: "Attempt containers" });
    const requestTable = screen.getByRole("table", { name: "Outstanding resource requests" });
    expect(containerTable.textContent).toContain("Running");
    expect(containerTable.textContent).toContain("768 MiB");
    expect(containerTable.textContent).toContain("0");
    expect(requestTable.textContent).toContain("allocation-tag=analytics");
    expect(requestTable.textContent).toContain("OPPORTUNISTIC");
    expect(requestTable.textContent).toContain("2 GiB");
    expect(screen.getByText("Attempt diagnostics")).toBeTruthy();
  });
});
