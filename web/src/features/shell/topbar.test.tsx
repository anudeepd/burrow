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

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { Topbar } = await import("./topbar");

const read = (path: string) => JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as Record<string, unknown>;
const meta = read("src/api/schemas/samples/meta.json") as Meta;
const info = read("../fixtures/rm/overview/info.json") as { clusterInfo: ClusterInfo };
const metrics = read("../fixtures/rm/overview/metrics.json") as { clusterMetrics: ClusterMetrics };

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
});
