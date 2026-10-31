import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { q as queryFactories } from "~/api/queries";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App, AppAttempt } from "~/api/schemas";
import type { Meta } from "~/api/schemas/meta";

// vitest does not expose globals, so Testing Library's automatic cleanup is not registered — do it explicitly.
afterEach(cleanup);

/**
 * The parity contract (docs/contracts/parity-dom.md) is verified on the REAL table, not on a mock of it: parity mode is
 * switched on BEFORE the modules that read it are imported (the same trick the Playwright harness uses with
 * `window.__BURROW_PARITY__`), which makes the DataTable render every row without virtualization — so jsdom (no layout) can
 * see all 24 columns of every row.
 */
declare global {
  interface Window {
    __BURROW_PARITY__?: boolean;
  }
}
window.__BURROW_PARITY__ = true;

let DataTable: typeof import("~/ui/data-table/data-table").DataTable;
let APPS_COLUMNS: typeof import("~/features/apps/columns").APPS_COLUMNS;
let APPS_FIELD_IDS: typeof import("~/features/apps/columns").APPS_FIELD_IDS;
let APPS_COLUMN_IDS: typeof import("~/features/apps/columns").APPS_COLUMN_IDS;
let q: typeof queryFactories;

const TEST_META: Meta = {
  name: "test",
  version: "test",
  now: 0,
  readOnly: true,
  rm: { urls: [], active: null, reachable: false },
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
};

beforeAll(async () => {
  ({ DataTable } = await import("~/ui/data-table/data-table"));
  ({ APPS_COLUMNS, APPS_FIELD_IDS, APPS_COLUMN_IDS } = await import("~/features/apps/columns"));
  ({ q } = await import("~/api/queries"));
});

function makeApp(over: Partial<App> = {}): App {
  return {
    id: "application_1767000000000_0001",
    user: "alice",
    name: "spark-job-1",
    queue: "root.prod.etl",
    state: "RUNNING",
    finalStatus: "UNDEFINED",
    progress: 12.5,
    trackingUI: "ApplicationMaster",
    trackingUrl: "http://rm:8088/proxy/application_1767000000000_0001/",
    diagnostics: "",
    clusterId: 1767000000000,
    applicationType: "SPARK",
    applicationTags: "etl,nightly",
    priority: 3,
    startedTime: 1767225600000,
    launchTime: 1767225601000,
    finishedTime: 0,
    elapsedTime: 60_000,
    allocatedMB: 4096,
    allocatedVCores: 2,
    allocatedGpus: 0,
    reservedMB: -1,
    reservedVCores: -1,
    reservedGpus: 0,
    runningContainers: 3,
    memorySeconds: 100,
    vcoreSeconds: 10,
    queueUsagePercentage: 4.5,
    clusterUsagePercentage: 0.5,
    preemptedResourceMB: 0,
    preemptedResourceVCores: 0,
    numNonAMContainerPreempted: 0,
    numAMContainerPreempted: 0,
    unmanagedApplication: false,
    resourceRequests: [],
    ...over,
  };
}

function TestTable({ apps }: { apps: App[] }) {
  return (
    <DataTable
      data={apps}
      columns={APPS_COLUMNS}
      getRowId={(app) => app.id}
      entityKey={(app) => app.id}
      label="Applications"
      storageKey="apps-test"
      sorting={[{ id: "id", desc: true }]}
      onSortingChange={() => {}}
      columnVisibility={{}}
      onColumnVisibilityChange={() => {}}
      defaultVisibility={{}}
      exportName="test"
    />
  );
}

/**
 * The real table reads attempt data and configured daemon bases through React Query. Seed both cache entries so these
 * render tests never make real `/api` requests; `attempts` maps app ids to attempt lists, with missing ids meaning none.
 */
function renderTable(apps: App[], attempts: Record<string, AppAttempt[]> = {}, meta: Meta = TEST_META) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const app of apps) {
    client.setQueryData(q.appAttempts(app.id).queryKey, { appAttempts: { appAttempt: attempts[app.id] ?? [] } });
  }
  client.setQueryData(q.meta().queryKey, meta);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <TestTable apps={apps} /> });
  // the ID column links to the app page; the test router only needs the path to exist
  const appRoute = createRoute({ getParentRoute: () => rootRoute, path: "/apps/$appId", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, appRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** field id -> raw `data-yv` for the first row of the given entity. */
function datumMap(entity: string): Map<string, string> {
  const row = document.querySelector(`[data-ye="${entity}"]`);
  const map = new Map<string, string>();
  for (const el of row?.querySelectorAll("[data-yf]") ?? []) {
    map.set(el.getAttribute("data-yf") ?? "", el.getAttribute("data-yv") ?? "");
  }
  return map;
}

describe("apps table column contract", () => {
  it("keeps the 24 legacy columns, in RMAppsBlock order, with the legacy labels", () => {
    expect(APPS_COLUMN_IDS).toEqual([
      "id",
      "user",
      "name",
      "type",
      "apptag",
      "queue",
      "priority",
      "starttime",
      "IDlaunchtime",
      "finishtime",
      "state",
      "finalstatus",
      "runningcontainer",
      "allocatedCpu",
      "allocatedMemory",
      "allocatedGpu",
      "reservedCpu",
      "reservedMemory",
      "reservedGpu",
      "queuePercentage",
      "clusterPercentage",
      "progress",
      "ui",
      "blacklisted",
    ]);
    expect(APPS_COLUMNS.map((c) => c.meta?.label)).toEqual([
      "ID",
      "User",
      "Name",
      "Application Type",
      "Application Tags",
      "Queue",
      "Application Priority",
      "Start time",
      "Launch time",
      "Finish time",
      "State",
      "Final status",
      "Running Containers",
      "Allocated CPU vCores",
      "Allocated Memory MB",
      "Allocated GPUs",
      "Reserved CPU vCores",
      "Reserved Memory MB",
      "Reserved GPUs",
      "% of Queue",
      "% of Cluster",
      "Progress",
      "Tracking UI",
      "Blacklisted Nodes",
    ]);
  });

  it("declares a field id for every column", () => {
    expect(APPS_FIELD_IDS).toHaveLength(24);
    expect(new Set(APPS_FIELD_IDS).size).toBe(24);
    expect(APPS_FIELD_IDS[0]).toBe("app.id");
    expect(APPS_FIELD_IDS.at(-1)).toBe("app.derived.blacklistedNodesCount");
  });

  it("renders every column of every row with data-yf/data-yv (parity mode: no virtualization window)", async () => {
    const apps = [
      makeApp(),
      makeApp({ id: "application_1767000000000_0002", state: "FINISHED", finalStatus: "SUCCEEDED", progress: 100, trackingUI: "History" }),
    ];
    renderTable(apps);
    await screen.findByRole("table");

    for (const app of apps) {
      const row = document.querySelector(`[data-ye="${app.id}"]`);
      expect(row, `row ${app.id}`).not.toBeNull();
      expect(row?.querySelectorAll('[role="cell"]').length).toBe(APPS_COLUMN_IDS.length);
    }

    const first = datumMap(apps[0]!.id);
    // raw values, exactly as JSON would stringify them
    expect(first.get("app.id")).toBe(apps[0]!.id);
    expect(first.get("app.state")).toBe("RUNNING");
    expect(first.get("app.finalStatus")).toBe("UNDEFINED");
    expect(first.get("app.priority")).toBe("3");
    expect(first.get("app.startedTime")).toBe("1767225600000");
    expect(first.get("app.finishedTime")).toBe("0");
    expect(first.get("app.allocatedMB")).toBe("4096");
    expect(first.get("app.allocatedVCores")).toBe("2");
    expect(first.get("app.runningContainers")).toBe("3");
    expect(first.get("app.queueUsagePercentage")).toBe("4.5");
    expect(first.get("app.progress")).toBe("12.5");
    expect(first.get("app.trackingUI")).toBe("ApplicationMaster");
    expect(first.get("app.reservedMB")).toBe("-1");
  });

  it("marks a missing raw value with data-yn instead of inventing one (app without any attempt: legacy N/A)", async () => {
    renderTable([makeApp()]);
    await screen.findByRole("table");
    const el = document.querySelector('[data-yf="app.derived.blacklistedNodesCount"]');
    expect(el?.getAttribute("data-yv")).toBe("");
    expect(el?.getAttribute("data-yn")).toBe("1");
    expect(el?.textContent).toBe("N/A");
  });

  it("renders the current attempt's blacklisted-node count (legacy RMAppsBlock.java:121-133)", async () => {
    const attempt = (id: number, blacklistedNodes: string): AppAttempt => ({
      id,
      startTime: 1,
      finishedTime: 0,
      containerId: "",
      nodeHttpAddress: "",
      nodeId: "",
      logsLink: "",
      blacklistedNodes,
      appAttemptId: `appattempt_1767000000000_0001_00000${id}`,
      appAttemptState: "RUNNING",
    });
    const a1 = makeApp();
    const a2 = makeApp({ id: "application_1767000000000_0002" });
    renderTable([a1, a2], {
      [a1.id]: [attempt(1, "n1:8041, n2:8041, n3:8041"), attempt(2, "n4:8041")],
      [a2.id]: [attempt(1, "")],
    });
    await screen.findByRole("table");
    const first = document.querySelector(`[data-ye="${a1.id}"] [data-yf="app.derived.blacklistedNodesCount"]`);
    expect(first?.getAttribute("data-yv")).toBe("1");
    expect(first?.getAttribute("data-yn")).toBeNull();
    expect(first?.getAttribute("data-yfmt")).toBe("int");
    expect(first?.textContent).toBe("1");
    const second = document.querySelector(`[data-ye="${a2.id}"] [data-yf="app.derived.blacklistedNodesCount"]`);
    expect(second?.getAttribute("data-yv")).toBe("0");
    expect(second?.textContent).toBe("0");
  });

  it("tags the Tracking UI cell with the legacy text and the URL actually linked", async () => {
    const running = makeApp();
    const finished = makeApp({
      id: "application_1767000000000_0002",
      state: "FINISHED",
      finalStatus: "SUCCEEDED",
      trackingUI: "History",
      trackingUrl: "http://jhs:19888/jobhistory/job/job_1",
    });
    const pending = makeApp({ id: "application_1767000000000_0003", state: "NEW", trackingUI: "UNASSIGNED", trackingUrl: undefined });
    // Live: the REST list withholds `trackingUrl` for an ACCEPTED app and its `trackingUI` says UNASSIGNED, but the
    // legacy page labels it ApplicationMaster and links its own proxy URL.
    const accepted = makeApp({ id: "application_1767000000000_0004", state: "ACCEPTED", trackingUI: "UNASSIGNED", trackingUrl: undefined });
    renderTable(
      [running, finished, pending, accepted],
      {},
      {
        ...TEST_META,
        rm: { ...TEST_META.rm, active: "http://127.0.0.1:8088" },
      },
    );
    await screen.findByRole("table");
    const cell = (app: App, field: string) => document.querySelector(`[data-ye="${app.id}"] [data-yf="${field}"]`);
    expect(cell(running, "app.derived.trackingUiText")?.textContent).toBe("ApplicationMaster");
    expect(cell(running, "app.derived.trackingUiText")?.getAttribute("data-yv")).toBe("ApplicationMaster");
    expect(cell(running, "app.trackingUrl")?.getAttribute("data-yv")).toBe(running.trackingUrl);
    expect(cell(running, "app.trackingUrl")?.getAttribute("href")).toBe(running.trackingUrl);
    expect(cell(running, "app.trackingUrl")?.textContent).toBe("ApplicationMaster");
    expect(cell(finished, "app.derived.trackingUiText")?.textContent).toBe("History");
    expect(cell(finished, "app.trackingUrl")?.getAttribute("data-yv")).toBe(finished.trackingUrl);
    expect(cell(pending, "app.derived.trackingUiText")?.textContent).toBe("Unassigned");
    expect(cell(pending, "app.trackingUrl")?.getAttribute("data-yn")).toBe("1");
    expect(cell(pending, "app.trackingUrl")?.getAttribute("href")).toBeNull();
    // the REST trackingUI key must not drive the label
    expect(cell(accepted, "app.derived.trackingUiText")?.textContent).toBe("ApplicationMaster");
    expect(cell(accepted, "app.derived.trackingUiText")?.getAttribute("data-yv")).toBe("ApplicationMaster");
    expect(cell(accepted, "app.trackingUrl")?.getAttribute("data-yv")).toBe(`http://127.0.0.1:8088/proxy/${accepted.id}/`);
    expect(cell(accepted, "app.trackingUrl")?.getAttribute("href")).toBe(`http://127.0.0.1:8088/proxy/${accepted.id}/`);
    // the raw REST value stays on the wrapper
    expect(cell(running, "app.trackingUI")?.getAttribute("data-yv")).toBe("ApplicationMaster");
    expect(cell(accepted, "app.trackingUI")?.getAttribute("data-yv")).toBe("UNASSIGNED");
  });

  it("shows the legacy N/A for the -1 sentinels but keeps the sentinel in data-yv", async () => {
    renderTable([makeApp()]);
    await screen.findByRole("table");
    const reserved = document.querySelector('[data-yf="app.reservedMB"]');
    expect(reserved?.textContent).toBe("N/A");
    expect(reserved?.getAttribute("data-yv")).toBe("-1");
  });

  it("tags every value with a format hint for the harness normaliser", async () => {
    renderTable([makeApp()]);
    await screen.findByRole("table");
    expect(document.querySelector('[data-yf="app.startedTime"]')?.getAttribute("data-yfmt")).toBe("epoch");
    expect(document.querySelector('[data-yf="app.progress"]')?.getAttribute("data-yfmt")).toBe("pct");
    expect(document.querySelector('[data-yf="app.runningContainers"]')?.getAttribute("data-yfmt")).toBe("int");
    expect(document.querySelector('[data-yf="app.state"]')?.getAttribute("data-yfmt")).toBe("text");
  });

  it("stamps the progress bar element itself with the raw progress", async () => {
    renderTable([makeApp()]);
    await screen.findByRole("table");
    const bar = document.querySelector('[role="progressbar"][data-yf="app.progress"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("data-yv")).toBe("12.5");
    expect(bar?.getAttribute("aria-valuenow")).toBe("13");
  });

  it("nests every field inside its own entity (rule 4)", async () => {
    renderTable([makeApp()]);
    await screen.findByRole("table");
    for (const el of document.querySelectorAll("[data-yf]")) {
      expect(el.closest("[data-ye]")).not.toBeNull();
    }
  });
});
