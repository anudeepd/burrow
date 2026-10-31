import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, AppAttempt } from "~/api/schemas";

window.__BURROW_PARITY__ = true;

const { cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
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

function renderSections() {
  const root = createRootRoute();
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <Entity id={app.id}>
        <AppHeader app={app} attempts={attempts} now={now} />
        <OverviewTab app={app} attempts={attempts} />
        <AttemptsTab
          appId={app.id}
          attempts={attempts}
          now={now}
          sorting={[]}
          onSortingChange={vi.fn()}
          columnVisibility={ATTEMPT_DEFAULT_VISIBILITY}
          onColumnVisibilityChange={vi.fn()}
        />
      </Entity>
    ),
  });
  const routeStubs = [
    createRoute({ getParentRoute: () => root, path: "/scheduler/$queue", component: () => null }),
    createRoute({ getParentRoute: () => root, path: "/apps/$appId/attempts", component: () => null }),
    createRoute({ getParentRoute: () => root, path: "/apps/$appId/attempts/$attemptId", component: () => null }),
  ];
  const router = createRouter({
    routeTree: root.addChildren([home, ...routeStubs]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(q.meta().queryKey, {
    name: "Burrow",
    version: "0.1.0",
    now,
    readOnly: true,
    rm: { urls: ["http://rm:8088"], active: "http://rm:8088", reachable: true },
    services: {
      sparkHistory: { configured: true, url: "http://history:18080", reachable: true },
      jobHistory: { configured: false },
      timeline: { configured: false },
    },
    features: { sparkLive: true, sparkHistory: true, aggregatedLogs: true, nodeLogs: true, events: true, kerberos: false },
    yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
  });
  client.setQueryData(appSparkSource(app.id).queryKey, {
    mode: "history",
    baseUrl: "http://history:18080",
    sparkAppId: app.id,
    attempt: null,
    available: true,
    reason: null,
    hint: null,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

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
});
