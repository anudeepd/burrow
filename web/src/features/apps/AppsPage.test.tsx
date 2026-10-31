import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "~/api/schemas";

window.__BURROW_PARITY__ = true;

const { cleanup, render, screen, fireEvent } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { AppsPage } = await import("./apps-page");
const { appsSearchSchema } = await import("./search");

const FIXTURE = resolve(process.cwd(), "../fixtures/rm/overview/apps.json");
const apps = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { apps: { app: App[] } }).apps.app;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.__BURROW_PARITY__ = true;
});

describe("AppsPage", () => {
  it("renders captured application rows, state counts, and resets a custom URL view", async () => {
    const patch = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ apps: { app: apps } }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(q.apps().queryKey, { apps: { app: apps } });
    client.setQueryData(q.meta().queryKey, {
      name: "Burrow",
      version: "0.1.0",
      now: Date.now(),
      readOnly: true,
      rm: { urls: [], active: null, reachable: true },
      services: { sparkHistory: { configured: false }, jobHistory: { configured: false }, timeline: { configured: false } },
      features: { sparkLive: false, sparkHistory: false, aggregatedLogs: false, nodeLogs: false, events: false, kerberos: false },
      yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: null },
    });
    const root = createRootRoute();
    const index = createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => (
        <AppsPage
          search={appsSearchSchema.parse({ states: "FINISHED", user: "alice" })}
          patch={patch}
          onOpenApp={vi.fn()}
          renderVersion="post"
          previewApps={apps}
        />
      ),
    });
    const appStub = createRoute({ getParentRoute: () => root, path: "/apps/$appId", component: () => null });
    const router = createRouter({ routeTree: root.addChildren([index, appStub]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(screen.getByText("Sample data")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Applications" })).toBeTruthy();
    expect(screen.getAllByText(/application_/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({ states: undefined, user: undefined, name: undefined, sort: undefined, cols: undefined }),
    );
  });

  it("renders the review loading and unavailable states and resets their URL filters", async () => {
    const loading = renderAppsPage({ renderVersion: "pre", previewState: "loading" });
    await screen.findByRole("heading", { name: "Applications" });
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    loading.unmount();

    const unavailable = renderAppsPage({ renderVersion: "post", previewState: "unavailable", search: { user: "alice" } });
    expect(await screen.findByRole("heading", { name: "Cannot load applications" })).toBeTruthy();
    expect(screen.getByText(/Cannot reach the ResourceManager/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(unavailable.patch).toHaveBeenCalledWith(expect.objectContaining({ user: undefined, name: undefined, states: undefined }));
  });

  it("distinguishes an empty ResourceManager response from filters with no matching rows", async () => {
    const empty = renderAppsPage({ previewApps: [] });
    expect(await screen.findByText("The ResourceManager reported no applications at all.")).toBeTruthy();
    empty.unmount();

    const filtered = renderAppsPage({ search: { user: "no-such-user" }, previewApps: apps });
    expect(await screen.findByRole("heading", { name: "No applications match these filters" })).toBeTruthy();
    expect(screen.getByText("Parity mode keeps the URL filters; clear them to see every row.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" }).at(-1)!);
    expect(filtered.patch).toHaveBeenCalledWith(expect.objectContaining({ user: undefined, name: undefined, states: undefined }));
  });

  it("uses the lifecycle picker when the measured content area is compact", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          this.callback([{ target, contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
        unobserve() {}
      },
    );
    renderAppsPage({ previewApps: apps });
    expect(await screen.findByRole("combobox", { name: "Lifecycle state" })).toBeTruthy();
  });

  it("writes lifecycle and column choices back to URL search", async () => {
    window.__BURROW_PARITY__ = false;
    const { patch } = renderAppsPage({ search: { cols: "all" }, previewApps: apps });
    fireEvent.click(await screen.findByRole("tab", { name: /Completed/ }));
    expect(patch).toHaveBeenCalledWith({ states: "FINISHED,FAILED,KILLED" });

    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "User" }));
    expect(patch.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ cols: expect.any(String) }));
  });

  it("keeps stale applications visible and distinguishes failed initial loads", async () => {
    const stale = renderAppsPage({ live: true, queryError: new Error("refresh failed"), previewApps: apps });
    expect(await screen.findByText("Applications refresh failed; showing the last loaded rows")).toBeTruthy();
    expect(screen.getByText("stale")).toBeTruthy();
    stale.unmount();

    const emptyStale = renderAppsPage({ live: true, queryError: new Error("refresh failed"), previewApps: [] });
    expect(await screen.findByText("Applications refresh failed; showing the last loaded result")).toBeTruthy();
    emptyStale.unmount();

    renderAppsPage({ live: true, queryError: new Error("initial load failed"), queryHasData: false });
    expect(await screen.findByRole("heading", { name: "Cannot load applications" })).toBeTruthy();
  });
});

function renderAppsPage(options: {
  search?: Record<string, unknown>;
  renderVersion?: "pre" | "post";
  previewState?: "loaded" | "loading" | "unavailable";
  previewApps?: App[];
  live?: boolean;
  queryError?: Error;
  queryHasData?: boolean;
} = {}) {
  const patch = vi.fn();
  const onOpenApp = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (options.live) {
    const key = q.apps().queryKey;
    client.setQueryData(key, { apps: { app: options.previewApps ?? apps } });
    if (options.queryError) {
      const query = client.getQueryCache().find({ queryKey: key })!;
      query.setState({
        ...query.state,
        data: options.queryHasData === false ? undefined : { apps: { app: options.previewApps ?? apps } },
        status: "error",
        error: options.queryError,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    }
  }
  const renderVersion = options.live ? undefined : (options.renderVersion ?? "post");
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <AppsPage
        search={appsSearchSchema.parse(options.search ?? {})}
        patch={patch}
        onOpenApp={onOpenApp}
        renderVersion={renderVersion}
        previewState={options.previewState ?? "loaded"}
        previewApps={options.previewApps ?? apps}
      />
    ),
  });
  const appStub = createRoute({ getParentRoute: () => root, path: "/apps/$appId", component: () => null });
  const router = createRouter({ routeTree: root.addChildren([index, appStub]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, client, router, patch, onOpenApp };
}
