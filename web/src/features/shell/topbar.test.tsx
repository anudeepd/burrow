import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { q } from "~/api/queries";
import { connectionStore } from "~/api/connection";
import type { ClusterInfo, ClusterMetrics, Meta } from "~/api/schemas";
import { parityStore } from "~/state/parity";
import { prefsStore, setPrefs } from "~/state/prefs";

window.__BURROW_PARITY__ = true;

const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { Topbar } = await import("./topbar");

const read = (path: string) => JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as Record<string, unknown>;
const meta = read("src/api/schemas/samples/meta.json") as Meta;
const info = read("../fixtures/rm/overview/info.json") as { clusterInfo: ClusterInfo };
const metrics = read("../fixtures/rm/overview/metrics.json") as { clusterMetrics: ClusterMetrics };
const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");

function renderTopbar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(q.meta().queryKey, meta);
  client.setQueryData(q.info().queryKey, info);
  client.setQueryData(q.metrics().queryKey, metrics);
  const onOpenRail = vi.fn();
  const onOpenPalette = vi.fn();
  const result = render(
    <QueryClientProvider client={client}>
      <Topbar onOpenRail={onOpenRail} onOpenPalette={onOpenPalette} />
    </QueryClientProvider>,
  );
  return { ...result, client, onOpenRail, onOpenPalette };
}

afterEach(() => {
  cleanup();
  setPrefs({ theme: "system", tz: "local", motion: "system", liveIntervalMs: 3000, livePaused: false, railCollapsed: false });
  parityStore.setState(() => ({ enabled: false }));
  connectionStore.setState(() => ({
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastCache: null,
    lastUpstream: null,
    clockSkewMs: 0,
  }));
  if (originalUserAgent) Object.defineProperty(navigator, "userAgent", originalUserAgent);
});

describe("Topbar", () => {
  it("reports cluster identity and changes live, theme, time-zone and cadence controls", async () => {
    const { onOpenRail, onOpenPalette } = renderTopbar();
    expect(screen.getByTestId("cluster-id").textContent).toContain("YARN");
    expect(screen.getByTestId("ha-pill").textContent).toContain("Active");
    expect(screen.getByTestId("topbar").getAttribute("data-live")).toBe("live");

    fireEvent.click(screen.getByRole("button", { name: "Pause live updates" }));
    await waitFor(() => expect(screen.getByTestId("topbar").getAttribute("data-live")).toBe("paused"));
    expect(prefsStore.get().livePaused).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Resume live updates" }));
    await waitFor(() => expect(screen.getByTestId("topbar").getAttribute("data-live")).toBe("live"));

    fireEvent.click(screen.getByRole("button", { name: "Theme: light" }));
    fireEvent.click(screen.getByRole("button", { name: "Times in UTC" }));
    expect(prefsStore.get().theme).toBe("light");
    expect(prefsStore.get().tz).toBe("utc");

    expect(screen.getByRole("combobox", { name: "Refresh interval" }).textContent).toContain("3 s");
    fireEvent.click(screen.getByRole("combobox", { name: "Refresh interval" }));
    const fiveSeconds = await screen.findByRole("option", { name: "5 s" });
    fireEvent.pointerDown(fiveSeconds, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(fiveSeconds, { button: 0, pointerType: "mouse" });
    fireEvent.click(fiveSeconds);
    await waitFor(() => expect(prefsStore.get().liveIntervalMs).toBe(5000));

    fireEvent.click(screen.getByRole("button", { name: /Search applications and pages/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(onOpenPalette).toHaveBeenCalledOnce();
    expect(onOpenRail).toHaveBeenCalledOnce();
  });

  it("shows response age, parity state, and connection details for the loaded cluster", async () => {
    connectionStore.setState((state) => ({
      ...state,
      lastOkAt: Date.now() - 5_000,
      lastUpstream: "http://rm:8088",
      lastCache: "hit",
      clockSkewMs: 1300,
    }));
    parityStore.setState(() => ({ enabled: true }));
    renderTopbar();
    expect(screen.getByText("parity")).toBeTruthy();
    expect(screen.getByTestId("last-updated").textContent).not.toContain("…");
    fireEvent.click(screen.getByRole("button", { name: "Connection: healthy" }));
    expect(await screen.findByText("Connection")).toBeTruthy();
    expect(screen.getByText("hit")).toBeTruthy();
    expect(screen.getByText("http://rm:8088")).toBeTruthy();
    expect(screen.getByText("+1s")).toBeTruthy();
    expect(screen.getByText("Spark History Server")).toBeTruthy();
  });

  it("marks the connection unhealthy and exposes the last request failure", async () => {
    connectionStore.setState((state) => ({ ...state, consecutiveFailures: 2, lastError: "gateway timeout" }));
    renderTopbar();
    fireEvent.click(screen.getByRole("button", { name: "Connection: 2 failed request(s)" }));
    expect((await screen.findByRole("alert")).textContent).toContain("gateway timeout");
    expect(screen.getByRole("button", { name: "Retry failed requests on this page" })).toBeTruthy();
  });

  it("shows failed query details, retries active failures, and updates connection settings", async () => {
    parityStore.setState(() => ({ enabled: true }));
    const { client } = renderTopbar();
    const metaQuery = client.getQueryCache().find({ queryKey: q.meta().queryKey })!;
    act(() => {
      metaQuery.setState({
        ...metaQuery.state,
        status: "error",
        error: new Error("metadata refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: 1,
      });
      const infoQuery = client.getQueryCache().find({ queryKey: q.info().queryKey })!;
      infoQuery.setState({
        ...infoQuery.state,
        status: "error",
        error: "raw identity refresh failed" as unknown as Error,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: 1,
      });
      const metricsQuery = client.getQueryCache().find({ queryKey: q.metrics().queryKey })!;
      metricsQuery.setState({
        ...metricsQuery.state,
        status: "error",
        error: new Error("metrics refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: 1,
      });
    });
    await waitFor(() => expect(screen.getByTestId("connection").getAttribute("aria-label")).toContain("3 failed"));
    fireEvent.click(screen.getByTestId("connection"));
    const errors = await screen.findAllByRole("alert");
    expect(errors.map((error) => error.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Burrow service metadata failed: metadata refresh failed"),
        expect.stringContaining("ResourceManager cluster info failed: raw identity refresh failed"),
        expect.stringContaining("ResourceManager cluster metrics failed: metrics refresh failed"),
      ]),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    );
    const refetch = vi.spyOn(client, "refetchQueries");
    fireEvent.click(screen.getByRole("button", { name: "Retry failed requests on this page" }));
    expect(refetch).toHaveBeenCalledWith(expect.objectContaining({ type: "active", predicate: expect.any(Function) }));

    fireEvent.click(screen.getByRole("combobox", { name: "Theme" }));
    const dark = await screen.findByRole("option", { name: "Dark" });
    fireEvent.pointerDown(dark, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(dark, { button: 0, pointerType: "mouse" });
    fireEvent.click(dark);
    await waitFor(() => expect(prefsStore.get().theme).toBe("dark"));

    fireEvent.click(screen.getByRole("combobox", { name: "Time zone" }));
    const utc = await screen.findByRole("option", { name: "UTC" });
    fireEvent.pointerDown(utc, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(utc, { button: 0, pointerType: "mouse" });
    fireEvent.click(utc);
    await waitFor(() => expect(prefsStore.get().tz).toBe("utc"));
  });

  it("formats missing upstream fields, unconfigured services and negative clock skew", async () => {
    const { client } = renderTopbar();
    act(() => {
      client.setQueryData(q.info().queryKey, { clusterInfo: null } as never);
      client.setQueryData(q.meta().queryKey, {
        ...meta,
        rm: { ...meta.rm, active: null, reachable: null },
        services: {
          sparkHistory: { configured: true, urls: [], url: null, reachable: null },
          jobHistory: { configured: true, urls: [], url: "http://jhs:19888", reachable: null },
          timeline: { configured: false },
        },
      } as never);
      connectionStore.setState((state) => ({ ...state, clockSkewMs: -2300 }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Connection: healthy" }));
    expect(await screen.findByText("-2s")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("configured")).toBeTruthy();
    expect(screen.getByText("http://jhs:19888")).toBeTruthy();
    expect(screen.getByText("not configured")).toBeTruthy();
  });

  it("uses the Apple command key after mounting on macOS", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Macintosh" });
    renderTopbar();
    await waitFor(() => expect(screen.getByRole("button", { name: /Search applications and pages \(⌘ K\)/ })).toBeTruthy());
  });
});
