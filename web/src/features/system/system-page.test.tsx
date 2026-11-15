import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionStore } from "~/api/connection";
import { parityStore } from "~/state/parity";
import { RouterProvider, SYSTEM_FIXTURE, queryClient, routerAt, serveFixtures } from "~/__tests__/route-test-utils";

window.__BURROW_PARITY__ = true;

function statFor(label: string): HTMLElement {
  return screen.getAllByText(label)[0]!.parentElement as HTMLElement;
}

const errorResponse = (message: string) =>
  new Response(JSON.stringify({ error: { message } }), {
    // A 404 is final (no retry backoff), so the page reaches its error state in one round trip.
    status: 404,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  parityStore.setState(() => ({ enabled: true }));
  serveFixtures();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  connectionStore.setState((state) => ({
    ...state,
    lastCache: null,
    consecutiveFailures: 0,
    lastError: null,
    lastErrorAt: null,
  }));
  parityStore.setState(() => ({ enabled: false }));
});

describe("system page", () => {
  it("shows the skeleton until the system fixture resolves", async () => {
    const deferred = Promise.withResolvers<unknown>();
    serveFixtures({ "/api/system": () => deferred.promise });
    const view = render(<RouterProvider router={routerAt("/system")} />);

    expect(await screen.findByRole("status", { name: "Loading system metrics" })).toBeTruthy();
    deferred.resolve(SYSTEM_FIXTURE);

    expect(await screen.findByText("Active browsers")).toBeTruthy();
    view.unmount();
  });

  it("renders process, client, request, chart, error and runtime data", async () => {
    serveFixtures({
      "/api/system": {
        ...SYSTEM_FIXTURE,
        memoryHistory: [
          { atMs: 1_791_010_000_000, rssBytes: 120 * 1024 * 1024 },
          { atMs: 1_791_010_005_000, rssBytes: 134_217_728 },
        ],
      },
    });
    render(<RouterProvider router={routerAt("/system")} />);

    expect(await screen.findByRole("heading", { name: "System" })).toBeTruthy();
    expect(screen.getByText("Burrow's own process, traffic and connected clients")).toBeTruthy();

    expect(within(statFor("Active browsers")).getByText("2")).toBeTruthy();
    expect(screen.getByText("1 live stream · last 5 min")).toBeTruthy();
    expect(within(statFor("Process RSS")).getByText("128 MiB")).toBeTruthy();
    expect(screen.getByText("peak 150 MiB")).toBeTruthy();
    expect(within(statFor("Failed requests")).getByText("4")).toBeTruthy();
    expect(within(statFor("Failed requests")).getByText(/2 in the last 15 min · 20 client errors/)).toBeTruthy();
    expect(statFor("Failed requests").querySelector(".text-fail")).toBeTruthy();
    expect(within(statFor("Uptime")).getByText("20m 34s")).toBeTruthy();
    expect(screen.getByText(/^since \d{2}:\d{2}:\d{2}$/)).toBeTruthy();
    expect(within(statFor("API latency")).getByText("21 ms")).toBeTruthy();
    expect(screen.getByText("p50 3 ms")).toBeTruthy();

    const requestChart = screen.getByRole("group", { name: "Requests per minute over the last 15 minutes" });
    const memoryChart = screen.getByRole("group", { name: "Process RSS over the last 15 minutes" });
    fireEvent.focus(within(requestChart).getByRole("slider", { name: "Request history samples" }));
    expect(within(requestChart).getByRole("slider").getAttribute("aria-valuetext")).toContain("55 requests at");
    fireEvent.focus(within(memoryChart).getByRole("slider", { name: "Memory history samples" }));
    expect(within(memoryChart).getByRole("slider").getAttribute("aria-valuetext")).toContain("128 MiB at");

    const table = screen.getByRole("table", { name: "Recent failed requests, newest first" });
    expect(within(table).getByText("502")).toBeTruthy();
    expect(within(table).getByText("GET")).toBeTruthy();
    expect(within(table).getByText("/api/apps")).toBeTruthy();
    expect(within(table).getByText("12 ms")).toBeTruthy();

    expect(screen.getByText("0.2.3")).toBeTruthy();
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(screen.getByText("95.2%")).toBeTruthy();
    expect(screen.getByText("120.6 KiB")).toBeTruthy();
    expect(screen.getByText("1.9 GiB")).toBeTruthy();
  });

  it("renders an unavailable state when the platform reports no memory", async () => {
    serveFixtures({
      "/api/system": {
        ...SYSTEM_FIXTURE,
        process: {
          ...SYSTEM_FIXTURE.process,
          memory: { rssBytes: null, peakRssBytes: null, virtualBytes: null },
        },
      },
    });
    render(<RouterProvider router={routerAt("/system")} />);

    expect(await screen.findByText("platform does not report process memory")).toBeTruthy();
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
  });

  it("shows a dash for cache hit rate before any cache lookup", async () => {
    serveFixtures({
      "/api/system": {
        ...SYSTEM_FIXTURE,
        cache: { ...SYSTEM_FIXTURE.cache, hits: 0, misses: 0 },
      },
    });
    render(<RouterProvider router={routerAt("/system")} />);

    expect(await screen.findByText("Cache hit rate")).toBeTruthy();
    const field = screen.getByText("Cache hit rate").closest("div")!;
    expect(within(field).getByText("—")).toBeTruthy();
  });

  it("pluralizes the live stream count", async () => {
    serveFixtures({
      "/api/system": {
        ...SYSTEM_FIXTURE,
        clients: { ...SYSTEM_FIXTURE.clients, streams: 3 },
      },
    });
    render(<RouterProvider router={routerAt("/system")} />);

    expect(await screen.findByText("3 live streams · last 5 min")).toBeTruthy();
  });

  it("formats sub-millisecond API latency", async () => {
    serveFixtures({
      "/api/system": {
        ...SYSTEM_FIXTURE,
        requests: { ...SYSTEM_FIXTURE.requests, p50Ms: 0.2, p95Ms: 0.4 },
        recentErrors: [{ ...SYSTEM_FIXTURE.recentErrors[0], durationMs: 0.5 }],
      },
    });
    render(<RouterProvider router={routerAt("/system")} />);

    expect(await screen.findByText("400 µs")).toBeTruthy();
    expect(screen.getByText("p50 200 µs")).toBeTruthy();
    expect(screen.getByText("500 µs")).toBeTruthy();
    expect(screen.getByText(/p95 400 µs/)).toBeTruthy();
  });

  it("shows the no-errors state and an ok failure tone when nothing failed", async () => {
    serveFixtures({
      "/api/system": {
        ...SYSTEM_FIXTURE,
        requests: {
          ...SYSTEM_FIXTURE.requests,
          errorsLast15m: 0,
          byStatus: { ...SYSTEM_FIXTURE.requests.byStatus, "5xx": 0 },
        },
        recentErrors: [],
      },
    });
    render(<RouterProvider router={routerAt("/system")} />);

    expect(await screen.findByText("No errors since startup")).toBeTruthy();
    expect(statFor("Failed requests").querySelector(".text-ok")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Recent failed requests, newest first" })).toBeNull();
  });

  it("shows the fatal error state and retries the request", async () => {
    serveFixtures({ "/api/system": errorResponse("system endpoint offline") });
    render(<RouterProvider router={routerAt("/system")} />);

    expect(await screen.findByText("Cannot read Burrow's system metrics")).toBeTruthy();
    expect(screen.getByText("system endpoint offline")).toBeTruthy();
    const fetchMock = vi.mocked(fetch);
    const before = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/system")).length;
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/system")).length).toBeGreaterThan(before),
    );
  });

  it("refreshes on demand and keeps the last reading when a refresh fails", async () => {
    render(<RouterProvider router={routerAt("/system")} />);
    expect(await screen.findByText("Active browsers")).toBeTruthy();

    const fetchMock = vi.mocked(fetch);
    const before = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/system")).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh system metrics" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/system")).length).toBeGreaterThan(before),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorResponse("refresh failed")),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh system metrics" }));
    expect(await screen.findByText("System metrics refresh failed; showing the last reading")).toBeTruthy();
    expect(screen.getByText("refresh failed")).toBeTruthy();
    expect(screen.getByText("Active browsers")).toBeTruthy();
  });

  it("loads the route and lists System in the primary navigation", async () => {
    render(<RouterProvider router={routerAt("/system")} />);

    expect(await screen.findByTestId("system")).toBeTruthy();
    const rail = screen.getByTestId("rail");
    expect(within(rail).getByRole("link", { name: "System" })).toBeTruthy();
  });
});
