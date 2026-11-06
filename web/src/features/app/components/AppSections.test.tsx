import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, AppAttempt } from "~/api/schemas";
import type { SparkSource } from "../queries";

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useState } = await import("react");
const { parityStore } = await import("~/state/parity");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { appSparkSource } = await import("../queries");
const { AppHeader } = await import("./AppHeader");
const { OverviewTab } = await import("./OverviewTab");
const { AttemptsTab, ATTEMPT_DEFAULT_VISIBILITY } = await import("./AttemptsTab");
const { Entity } = await import("~/ui/datum");

const FIXTURE = resolve(process.cwd(), "../fixtures/rm/app/finished");
const readJson = (name: string) => JSON.parse(readFileSync(`${FIXTURE}/${name}`, "utf8")) as unknown;
const app = (readJson("app.json") as { app: App }).app;
const attempts = (readJson("appattempts.json") as { appAttempts: { appAttempt: AppAttempt[] } }).appAttempts.appAttempt;
const now = Math.max(app.finishedTime, ...attempts.map((a) => a.finishedTime)) + 1_000;

function Sections({
  attemptRows,
  application = app,
  insideSpark,
  attemptTrackingUrl,
}: {
  attemptRows: AppAttempt[];
  application?: App;
  insideSpark?: boolean;
  attemptTrackingUrl?: string | null;
}) {
  const [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  return (
    <Entity id={application.id}>
      <AppHeader app={application} attempts={attemptRows} now={now} {...(insideSpark === undefined ? {} : { insideSpark })} />
      <OverviewTab app={application} attempts={attemptRows} attemptTrackingUrl={attemptTrackingUrl} />
      <AttemptsTab
        appId={application.id}
        attempts={attemptRows}
        now={now}
        sorting={sorting}
        onSortingChange={setSorting}
        columnVisibility={ATTEMPT_DEFAULT_VISIBILITY}
        onColumnVisibilityChange={vi.fn()}
      />
    </Entity>
  );
}

function renderSections(
  attemptRows: AppAttempt[] = attempts,
  application: App = app,
  options: {
    insideSpark?: boolean;
    path?: string;
    rmActive?: string | null;
    rmUrls?: string[];
    sparkSourceData?: SparkSource;
    attemptTrackingUrl?: string | null;
  } = {},
) {
  const renderPage = () => (
    <Sections
      attemptRows={attemptRows}
      application={application}
      insideSpark={options.insideSpark}
      attemptTrackingUrl={options.attemptTrackingUrl}
    />
  );
  const root = createRootRoute();
  const routeStubs = [
    "/",
    "/scheduler/$queue",
    "/apps/$appId",
    "/apps/$appId/spark",
    "/apps/$appId/attempts",
    "/apps/$appId/attempts/$attemptId",
    "/apps/$appId/containers/$containerId",
    "/apps/$appId/logs",
  ].map((path) => createRoute({ getParentRoute: () => root, path, component: renderPage }));
  const router = createRouter({
    routeTree: root.addChildren(routeStubs),
    history: createMemoryHistory({ initialEntries: [options.path ?? "/"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(q.meta().queryKey, {
    name: "Burrow",
    version: "0.1.0",
    now,
    readOnly: true,
    rm: {
      urls: options.rmUrls ?? ["http://rm:8088"],
      active: options.rmActive === undefined ? "http://rm:8088" : options.rmActive,
      reachable: true,
    },
    services: {
      sparkHistory: { configured: true, url: "http://history:18080", reachable: true },
      jobHistory: { configured: false },
      timeline: { configured: false },
    },
    features: { sparkLive: true, sparkHistory: true, aggregatedLogs: true, nodeLogs: true, events: true, kerberos: false },
    yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
  });
  client.setQueryData(
    appSparkSource(application.id).queryKey,
    options.sparkSourceData ?? {
      mode: "history",
      baseUrl: "http://history:18080",
      sparkAppId: application.id,
      attempt: null,
      available: true,
      reason: null,
      hint: null,
    },
  );
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  parityStore.setState(() => ({ enabled: true }));
  window.__BURROW_PARITY__ = true;
});

describe("application sections", () => {
  it("renders the completed application header, status timeline, metrics, diagnostics and attempts", async () => {
    renderSections();
    expect(await screen.findByRole("heading", { name: "appdetail-finished" })).toBeTruthy();
    expect(screen.getByText("YARN application")).toBeTruthy();
    expect(screen.getByText("Status timeline")).toBeTruthy();
    expect(screen.getByText("Application Overview")).toBeTruthy();
    expect(screen.getByText("Application Metrics")).toBeTruthy();
    expect(screen.getByText("Resource usage")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Application attempts" })).toBeTruthy();
    expect(screen.getByText("Diagnostics")).toBeTruthy();
  });

  it("shows empty diagnostics and application fields that have no reported timeout", async () => {
    renderSections();
    await screen.findByText("Application Overview");
    expect(screen.getByText(/0 characters · 1 lines/)).toBeTruthy();
    expect(screen.getByText("Application Timeout (Remaining Time):")).toBeTruthy();
    expect(screen.getByText("Unmanaged Application:")).toBeTruthy();
  });

  it("opens the diagnostics reader and summarizes retries after a failed attempt", async () => {
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    const failed = { ...attempts[0]!, id: 0, appAttemptId: `${attempts[0]!.appAttemptId}_000002`, appAttemptState: "FAILED" };
    renderSections([...attempts, failed]);
    expect(await screen.findByRole("button", { name: "Show all" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("button", { name: "Collapse" })).toBeTruthy();
    expect(screen.getByText(/attempts — the application was retried after failures/)).toBeTruthy();
  });

  it("shows optional attempt fields and exports each attempt's source values", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:attempts");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderSections();
    await screen.findByRole("table", { name: "Application attempts" });
    const table = screen.getByRole("table", { name: "Application attempts" });
    for (const column of ["startTime", "finishedTime", "elapsed"]) {
      fireEvent.click(table.querySelector(`[data-col="${column}"] button`)!);
    }
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    expect(screen.getByRole("columnheader", { name: /Node ID \(RPC\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
    expect(createUrl).toHaveBeenCalledOnce();
    expect(clickAnchor).toHaveBeenCalledOnce();
  });

  it("shows raw blacklist values while omitting links for attempts without a container or node address", async () => {
    const sparse = {
      ...attempts[0]!,
      containerId: undefined,
      nodeHttpAddress: undefined,
      blacklistedNodes: "worker-a,worker-b",
      nodesBlacklistedBySystem: "worker-c",
    } as unknown as AppAttempt;
    renderSections([sparse]);
    const table = await screen.findByRole("table", { name: "Application attempts" });
    expect(table.querySelector('[data-yf="attempt.blacklistedNodes"][data-yv="worker-a,worker-b"]')).toBeTruthy();
    expect(table.querySelector('[data-yf="attempt.nodesBlacklistedBySystem"][data-yv="worker-c"]')).toBeTruthy();
    expect(table.querySelector('a[href^="http://"]')).toBeNull();
  });

  it("matches the application header description to each detail route", async () => {
    const cases = [
      ["spark", "Spark application activity, execution plans, and runtime details."],
      ["attempts/attempt-1", "Inspect this attempt’s lifecycle, resource requests, and allocated containers."],
      ["attempts", "Review attempt history, assigned nodes, and container totals."],
      ["containers/container-1", "Inspect this container’s assignment, resource use, logs, and execution state."],
      ["logs", "Read container log output and choose the stream to inspect."],
      ["", "Application state, lifecycle, and resource usage reported by YARN."],
    ] as const;
    for (const [suffix, description] of cases) {
      cleanup();
      renderSections(attempts, app, { path: `/apps/${app.id}${suffix ? `/${suffix}` : ""}` });
      expect(await screen.findByText(description)).toBeTruthy();
    }
  });

  it("handles unreported final status, empty tags, missing RM links and cluster retries", async () => {
    const finalApp = {
      ...app,
      state: "FINISHED",
      finalStatus: "UNDEFINED",
      trackingUI: "UNASSIGNED",
      trackingUrl: undefined,
      applicationTags: "",
    } as unknown as App;
    const successfulRetry = {
      ...attempts[0]!,
      id: 2,
      appAttemptId: `${attempts[0]!.appAttemptId}_000002`,
      appAttemptState: "FINISHED",
    };
    renderSections([attempts[0]!, successfulRetry], finalApp, {
      path: `/apps/${app.id}`,
      rmActive: null,
      rmUrls: [],
      sparkSourceData: { mode: "none", available: false, reason: "history unavailable", hint: null },
    });
    expect((await screen.findAllByText("Final status unreported")).length).toBeGreaterThan(1);
    expect(screen.getByText(/attempts — the application was retried by the cluster/)).toBeTruthy();
    expect(screen.queryByText("burrow")).toBeNull();
    expect(screen.queryByRole("link", { name: "YARN application page" })).toBeNull();
    expect(screen.getByText("Unassigned")).toBeTruthy();
  });

  it("shows elapsed time for a live app and uses the missing-url tracking label", async () => {
    const runningApp = { ...app, state: "RUNNING", finishedTime: 0, trackingUI: "HISTORY", trackingUrl: undefined, timeouts: undefined };
    renderSections(attempts, runningApp, { path: `/apps/${app.id}` });
    expect(await screen.findByText("YARN application")).toBeTruthy();
    expect(screen.getByText("elapsed")).toBeTruthy();
    expect(screen.getByText("History")).toBeTruthy();
  });

  it("explains that NodeManager tracking links are only reachable inside the cluster", async () => {
    const runningApp = {
      ...app,
      state: "RUNNING",
      finishedTime: 0,
      applicationType: "MAPREDUCE",
      trackingUI: "APPLICATIONMASTER",
      trackingUrl: "http://worker:8042/node/containerlogs/container_1_1_1_1/alice",
    };
    renderSections(attempts, runningApp, { path: `/apps/${app.id}` });
    expect((await screen.findAllByRole("link", { name: "ApplicationMaster" })).length).toBeGreaterThan(0);
  });

  it("renders accepted applications with a timeout countdown and an attempt-provided tracking URL", async () => {
    const acceptedApp = {
      ...app,
      state: "ACCEPTED",
      finalStatus: "UNDEFINED",
      trackingUI: "UNASSIGNED",
      trackingUrl: undefined,
      applicationTags: "",
      unmanagedApplication: true,
      startedTime: 0,
      launchTime: 0,
      finishedTime: 0,
      diagnostics: null,
      timeouts: { timeout: [{ type: "LIFETIME", remainingTimeInSeconds: 75 }] },
    } as unknown as App;
    renderSections([], acceptedApp, {
      path: `/apps/${app.id}`,
      attemptTrackingUrl: "http://rm:8088/proxy/application_1791010984040_0002/",
    });
    expect(await screen.findByText("waiting for AM container to be allocated, launched and register with RM.")).toBeTruthy();
    expect(screen.getByText("1m 15s left")).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
    expect(screen.getByText("The RM reports no attempts yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "ApplicationMaster" })).toBeTruthy();
  });

  it("uses the first non-lifetime timeout and renders the full date range across days", async () => {
    const finishedEarlier = {
      ...app,
      startedTime: app.startedTime - 86_400_000,
      finishedTime: app.finishedTime,
      timeouts: { timeout: [{ type: "CUSTOM", remainingTimeInSeconds: -1 }] },
    } as App;
    const zeroStart = { ...attempts[0]!, startTime: 0 };
    const view = renderSections([zeroStart], finishedEarlier, { path: `/apps/${app.id}` });
    expect(await screen.findByText("Unlimited")).toBeTruthy();
    expect(view.container.querySelector('[data-yf="app.timeouts.timeout.remainingTimeInSeconds"][data-yv="-1"]')).toBeTruthy();
  });

  it("renders timeline fallbacks when a live app has no reported milestones", async () => {
    const liveWithoutTimes = { ...app, state: "RUNNING", startedTime: 0, launchTime: 0, finishedTime: 0 };
    const pendingAttempt = { ...attempts[0]!, startTime: undefined, finishedTime: 0, appAttemptState: "PENDING" } as unknown as AppAttempt;
    renderSections([pendingAttempt], liveWithoutTimes, { path: `/apps/${app.id}` });
    expect(await screen.findByText(/→ now/)).toBeTruthy();
    expect(screen.getByRole("img", { name: /Attempt 1: PENDING/ })).toBeTruthy();
  });

  it("falls back to the full finish text when the formatter has no time component", async () => {
    const format = await import("~/lib/format");
    vi.spyOn(format, "fmtEpoch").mockReturnValue("N/A");
    renderSections(attempts, app, { path: `/apps/${app.id}` });
    expect(await screen.findByText("N/A → N/A")).toBeTruthy();
  });

  it("renders trimmed application tag chips", async () => {
    const taggedApp = { ...app, applicationTags: " alpha, , beta " };
    renderSections(attempts, taggedApp, { path: `/apps/${app.id}/spark`, insideSpark: true });
    const header = (await screen.findByText("alpha")).closest("header")!;
    expect(within(header).getByText("beta")).toBeTruthy();
  });
});
