/**
 * The attempt page's outstanding-resource-requests heading.
 *
 * The legacy `RMAppAttemptBlock.createResourceRequestsTable` prints
 * `"Total Outstanding Resource Requests: " + getTotalResource(resourceRequests)`, where `getTotalResource` sums
 * `capability x numContainers` over the requests whose `resourceName` is ANY (`*`) — node/rack-specific requests are
 * the same containers again and must NOT be added (an earlier implementation over-counted them).
 *
 * The datum is a derived *text* field, so `data-yv` equals the legacy heading text exactly (the inventory format is
 * `resource-string`), on the attempt entity key.
 *
 * `AttemptDetail` (and `q`) are imported dynamically AFTER `window.__BURROW_PARITY__` is set because `~/state/parity` decides
 * parity once at module scope — a genuine module-load-order boundary that static imports cannot express.
 */
import type { App, AppAttempt, Container, ResourceRequestInfo } from "~/api/schemas";
import type { QueryClient as QueryClientType, QueryClientProvider as QueryClientProviderType } from "@tanstack/react-query";
import type { cleanup as cleanupFn, render as renderFn, waitFor as waitForFn } from "@testing-library/react";
import type { createMemoryHistory as createMemoryHistoryFn } from "@tanstack/react-router";
import type { AttemptDetail as AttemptDetailComponent } from "./AttemptDetail";
import type { q as queryFactories } from "~/api/queries";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

declare global {
  interface Window {
    __BURROW_PARITY__?: boolean;
  }
}
window.__BURROW_PARITY__ = true;

let render: typeof renderFn;
let cleanup: typeof cleanupFn;
let waitFor: typeof waitForFn;
let createMemoryHistory: typeof createMemoryHistoryFn;
let QueryClient: typeof QueryClientType;
let QueryClientProvider: typeof QueryClientProviderType;
let AttemptDetail: typeof AttemptDetailComponent;
let q: typeof queryFactories;

beforeAll(async () => {
  ({ render, cleanup, waitFor } = await import("@testing-library/react"));
  ({ createMemoryHistory } = await import("@tanstack/react-router"));
  ({ QueryClient, QueryClientProvider } = await import("@tanstack/react-query"));
  ({ AttemptDetail } = await import("./AttemptDetail"));
  ({ q } = await import("~/api/queries"));
});

// vitest does not expose globals, so Testing Library's automatic cleanup is not registered — do it explicitly.
afterEach(() => cleanup());

const ATTEMPT_ID = "appattempt_1791015583684_0049_000001";

/** capability `{memory:4096, vCores:2}` x 2 = `<memory:8192, vCores:4>` — the live legacy text. */
const CAP = { memory: 4096, vCores: 2 };

const request = (over: Partial<ResourceRequestInfo>): ResourceRequestInfo =>
  ({
    priority: 0,
    allocationRequestId: 0,
    resourceName: "*",
    numContainers: 0,
    relaxLocality: true,
    nodeLabelExpression: null,
    allocationTags: null,
    placementConstraint: null,
    executionTypeRequest: { executionType: "GUARANTEED" },
    capability: CAP,
    ...over,
  }) as ResourceRequestInfo;

function makeApp(resourceRequests: ResourceRequestInfo[]): App {
  return {
    id: "application_1791015583684_0049",
    user: "dr.who",
    name: "spark-job",
    queue: "default",
    state: "RUNNING",
    finalStatus: "UNDEFINED",
    progress: 50,
    trackingUI: "ApplicationMaster",
    trackingUrl: "http://rm:8088/proxy/application_1791015583684_0049/",
    diagnostics: "",
    clusterId: 1791015583684,
    applicationType: "SPARK",
    applicationTags: "",
    priority: 0,
    startedTime: 1791015583684,
    launchTime: 1791015583684,
    finishedTime: 0,
    elapsedTime: 60_000,
    allocatedMB: 8192,
    allocatedVCores: 4,
    allocatedGpus: 0,
    reservedMB: 0,
    reservedVCores: 0,
    reservedGpus: 0,
    runningContainers: 2,
    memorySeconds: 100,
    vcoreSeconds: 10,
    queueUsagePercentage: 1,
    clusterUsagePercentage: 1,
    preemptedResourceMB: 0,
    preemptedResourceVCores: 0,
    numNonAMContainerPreempted: 0,
    numAMContainerPreempted: 0,
    unmanagedApplication: false,
    resourceRequests,
  } as unknown as App;
}

const attempt: AppAttempt = {
  id: 1,
  startTime: 1791015583684,
  finishedTime: 0,
  containerId: "container_1791015583684_0049_01_000001",
  nodeHttpAddress: "127.0.0.2:8041",
  nodeId: "127.0.0.2:8041",
  logsLink: "",
  appAttemptId: ATTEMPT_ID,
  exportPorts: "{}",
  appAttemptState: "RUNNING",
};

/** Router stubs for the attempt page's links (attempt → container, app); the attempt page is the index route. */
async function renderAttempt(app: App, containers: readonly Container[] = [], containersUnavailable = true) {
  const { createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <AttemptDetail
        app={app}
        attempt={attempt}
        containers={containers}
        containersUnavailable={containersUnavailable}
        now={1791015583684 + 60_000}
      />
    ),
  });
  const appRoute = createRoute({ getParentRoute: () => rootRoute, path: "/apps/$appId", component: () => null });
  const containerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/apps/$appId/containers/$containerId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, appRoute, containerRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(q.meta().queryKey, {
    name: "test",
    version: "test",
    now: 1791015583684,
    readOnly: false,
    rm: { urls: [], active: null, reachable: true },
    services: {
      sparkHistory: { configured: false },
      jobHistory: { configured: false },
      timeline: { configured: false },
    },
    features: {
      sparkLive: false,
      sparkHistory: false,
      aggregatedLogs: false,
      nodeLogs: false,
      events: false,
      kerberos: false,
    },
    yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: null },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(document.querySelector('[data-yf="attempt.appAttemptId"]')).not.toBeNull());
  return view;
}

describe("attempt heading parity datum", () => {
  it("stamps attempt.derived.totalOutstandingResourceRequestsText with the legacy text over the ANY requests only", async () => {
    const app = makeApp([
      request({ resourceName: "*", numContainers: 2, capability: CAP }),
      // node/rack requests repeat the same containers — the legacy total does not add them
      request({ resourceName: "/default-rack", numContainers: 2, capability: CAP }),
      request({ resourceName: "127.0.0.2:8041", numContainers: 2, capability: CAP }),
    ]);
    await renderAttempt(app);

    const el = document.querySelector('[data-yf="attempt.derived.totalOutstandingResourceRequestsText"]');
    const text = "Total Outstanding Resource Requests: <memory:8192, vCores:4>";
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe(text);
    expect(el?.getAttribute("data-yv")).toBe(text);
    expect(el?.closest("[data-ye]")?.getAttribute("data-ye")).toBe(ATTEMPT_ID);
  });

  it("does not carry the datum when nothing is outstanding (legacy hides the heading)", async () => {
    await renderAttempt(makeApp([request({ resourceName: "*", numContainers: 0 })]));
    expect(document.querySelector('[data-yf="attempt.derived.totalOutstandingResourceRequestsText"]')).toBeNull();
  });
});

describe("attempt information", () => {
  it("keeps discarded container records and all locality counts unavailable", async () => {
    await renderAttempt(makeApp([]));
    expect(document.querySelector('[data-burrow="retained-container-count"]')?.textContent).toBe("Unavailable");
    const cells = document.querySelectorAll('[data-burrow="locality-matrix"] [data-yf]');
    expect(cells).toHaveLength(9);
    for (const cell of cells) {
      expect(cell.getAttribute("data-yn")).toBe("1");
      expect(cell.textContent).toBe("—");
    }
  });

  it("shows the execution type from the nested request payload", async () => {
    await renderAttempt(makeApp([request({ numContainers: 2 })]));
    const cell = document.querySelector('[data-yf="app.resourceRequests.executionTypeRequest.executionType"]');
    expect(cell?.textContent).toBe("GUARANTEED");
    expect(cell?.getAttribute("data-yv")).toBe("GUARANTEED");
  });

  it("shows retained container state and resources alongside its ID and logs", async () => {
    const container: Container = {
      containerId: attempt.containerId,
      allocatedMB: 4096,
      allocatedVCores: 2,
      priority: 0,
      startedTime: attempt.startTime,
      finishedTime: 0,
      elapsedTime: 60_000,
      containerState: "RUNNING",
      containerExitStatus: -1000,
      nodeId: attempt.nodeId,
      nodeHttpAddress: attempt.nodeHttpAddress,
    };
    await renderAttempt(makeApp([]), [container], false);
    expect(document.querySelector('[data-burrow="retained-container-count"]')?.textContent).toBe("1");
    const table = document.querySelector('[data-burrow-table-root="attempt-containers"]');
    expect(table?.querySelector('[data-yf="container.containerState"]')?.getAttribute("data-yv")).toBe("RUNNING");
    expect(table?.querySelector('[data-yf="container.allocatedMB"]')?.getAttribute("data-yv")).toBe("4096");
    expect(table?.querySelector('[data-yf="container.allocatedVCores"]')?.getAttribute("data-yv")).toBe("2");
    expect(table?.querySelector('[data-yf="container.containerExitStatus"]')?.textContent).toBe("—");
  });
});
