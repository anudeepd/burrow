import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "~/api/schemas";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: Array.from({ length: index }, (_, i) => estimateSize(i)).reduce((sum, height) => sum + height, 0),
      })),
    measure: vi.fn(),
  }),
}));

window.__BURROW_PARITY__ = false;

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { AppsPage } = await import("./apps-page");
const { appsSearchSchema } = await import("./search");
const { computeFacets } = await import("./view");
const { parityStore } = await import("~/state/parity");

const FIXTURE = resolve(process.cwd(), "../fixtures/rm/overview/apps.json");
const apps = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { apps: { app: App[] } }).apps.app;
const first = apps.slice(0, 2);
const later = apps.slice(0, 5);

function meta(overrides: Record<string, unknown> = {}) {
  return {
    offset: 0,
    limit: 100,
    total: apps.length,
    filteredTotal: apps.length,
    ready: true,
    partial: false,
    stale: false,
    version: 1,
    ageMs: 0,
    retryAfterMs: null,
    refreshError: null,
    facets: computeFacets(apps),
    ...overrides,
  };
}

function windowResponse(appsPage: App[], window = meta()) {
  return { apps: { app: appsPage }, window };
}

function renderPage(search: Record<string, unknown> = {}) {
  const patch = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <AppsPage search={appsSearchSchema.parse(search)} patch={patch} onOpenApp={vi.fn()} />,
  });
  const appStub = createRoute({ getParentRoute: () => root, path: "/apps/$appId", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([index, appStub]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, patch, client, router };
}

beforeEach(() => {
  parityStore.setState(() => ({ enabled: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("windowed AppsPage", () => {
  it("paints the preview first, widens it in the background, and swaps to exact counts", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const readyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request) => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify(
            windowResponse(
              first,
              meta({ total: null, filteredTotal: first.length, ready: false, partial: true, version: 0, facets: computeFacets(first) }),
            ),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      await readyGate;
      return new Response(JSON.stringify(windowResponse(later)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    expect((await screen.findAllByText(/application_/)).length).toBeGreaterThan(0);
    expect(screen.getByTestId("apps-indexing")).toBeTruthy();
    expect(screen.queryByText(`${apps.length.toLocaleString("en-US")} rows`)).toBeNull();

    release();
    await waitFor(() => expect(screen.queryByTestId("apps-indexing")).toBeNull());
    expect(screen.getByText(`${apps.length.toLocaleString("en-US")} rows`)).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^All/ }).textContent).toContain(apps.length.toLocaleString("en-US"));

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("window=1") && url.includes("limit=100"))).toBe(true);
    expect(urls.some((url) => url.includes("limit=500"))).toBe(true);
    const firstUrl = new URL(urls[0]!, "http://localhost");
    expect(firstUrl.searchParams.get("offset")).toBe("0");
    expect(firstUrl.searchParams.get("sort")).toBe("-starttime");
    expect(firstUrl.searchParams.get("deSelects")).toBe("resourceRequests");
  });

  it("sends filters and sorting to the server instead of filtering the window locally", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify(windowResponse(later)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderPage({ states: "RUNNING", user: "alice", sort: "name" });
    expect((await screen.findAllByText(/application_/)).length).toBeGreaterThan(0);
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("states")).toBe("RUNNING");
    expect(url.searchParams.get("user")).toBe("alice");
    expect(url.searchParams.get("sort")).toBe("name");
  });

  it("shows the snapshot stale flag and keeps the rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(windowResponse(later, meta({ stale: true, refreshError: "rm down" }))), {
            status: 200,
          }),
      ),
    );
    renderPage();
    expect(await screen.findByText("stale")).toBeTruthy();
    expect(screen.getAllByText(/application_/).length).toBeGreaterThan(0);
  });

  it("distinguishes an empty cluster, an empty filter, and the indexing gap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(windowResponse([], meta({ total: 0, filteredTotal: 0, facets: computeFacets([]) }))), {
            status: 200,
          }),
      ),
    );
    const empty = renderPage();
    expect(await screen.findByText("The ResourceManager reported no applications at all.")).toBeTruthy();
    empty.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(windowResponse([], meta({ filteredTotal: 0 }))), { status: 200 })),
    );
    const filtered = renderPage({ user: "nobody" });
    expect(await screen.findByText("No applications match these filters")).toBeTruthy();
    filtered.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(windowResponse([], meta({ ready: false, partial: true, total: null, filteredTotal: 0 }))), {
            status: 200,
          }),
      ),
    );
    renderPage();
    expect(await screen.findByText("Indexing applications")).toBeTruthy();
  });

  it("exports the complete filtered result from the index instead of the loaded window", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:apps");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify(windowResponse(later)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await screen.findAllByText(/application_/);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1));
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    const all = urls.find((url) => new URL(url, "http://localhost").searchParams.get("limit") === String(apps.length));
    expect(all).toBeTruthy();
    expect(new URL(all!, "http://localhost").searchParams.get("offset")).toBe("0");
  });

  it("renders the legacy unavailable state through the window query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "upstream_unreachable", message: "ResourceManager unavailable" } }), {
            status: 502,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    renderPage();
    expect(await screen.findByRole("heading", { name: "Cannot load applications" })).toBeTruthy();
    expect(screen.getByText("ResourceManager unavailable")).toBeTruthy();
  });
});
