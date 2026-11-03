import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Meta } from "~/api/schemas";
import { connectionStore } from "~/api/connection";
import { ov } from "~/api/queries/overview";
import { BurrowCapabilities } from "./BurrowCapabilities";

const meta: Meta = {
  name: "Burrow",
  version: "0.1.0",
  now: 1_791_000_000_000,
  readOnly: true,
  rm: { urls: ["http://rm:8088"], active: "http://rm:8088", haState: "ACTIVE", hadoopVersion: "3.4.3", reachable: true },
  services: {
    sparkHistory: { configured: true, url: "http://shs:18080", reachable: true },
    jobHistory: { configured: true, url: "http://jhs:19888", reachable: false },
    timeline: { configured: true, url: "http://ats:8188", reachable: null },
  },
  features: {
    sparkLive: true,
    sparkHistory: true,
    aggregatedLogs: true,
    nodeLogs: true,
    events: true,
    kerberos: false,
  },
  yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

describe("BurrowCapabilities service status", () => {
  it("uses the shared status treatment for reachable, unreachable, and unprobed services", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
    client.setQueryData(ov.meta().queryKey, meta);
    const { container } = render(
      <QueryClientProvider client={client}>
        <BurrowCapabilities />
      </QueryClientProvider>,
    );

    for (const [label, tone] of [
      ["Reachable", "ok"],
      ["Unreachable", "fail"],
      ["Configured", "wait"],
    ] as const) {
      const pill = screen.getByText(label).closest(".burrow-pill");
      expect(pill, `${label} uses a status pill`).not.toBeNull();
      expect(pill?.className).toContain(`burrow-tone-${tone}`);
      expect(pill?.querySelector("svg"), `${label} has its status icon`).not.toBeNull();
    }
    expect(container.querySelectorAll(".burrow-pill")).toHaveLength(3);
  });

  it("shows current API health, write access, endpoint candidates, and configured fallbacks", () => {
    connectionStore.setState((state) => ({ ...state, lastOkAt: 1_791_000_000_000 }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
    client.setQueryData(ov.meta().queryKey, {
      ...meta,
      readOnly: false,
      services: {
        sparkHistory: {
          configured: true,
          candidates: [
            { url: "http://shs-a:18080", reachable: true },
            { url: "http://shs-b:18080", reachable: false, reason: "connection refused" },
            { url: "http://shs-c:18080", reachable: false },
          ],
        },
        jobHistory: { configured: true, reachable: false, reason: "not responding" },
        timeline: { configured: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <BurrowCapabilities />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Read/write")).toBeTruthy();
    expect(screen.getByText(/OK /)).toBeTruthy();
    expect(screen.getByText("not responding")).toBeTruthy();
    expect(screen.getByText("No URL configured or discovered")).toBeTruthy();
    expect(screen.getByText("Not supported")).toBeTruthy();
    expect(document.querySelector('[data-burrow-help="Spark History Server endpoint probes"]')).not.toBeNull();
  });

  it("shows the initial-load failure and lets the user retry", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "offline", message: "meta unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={client}>
        <BurrowCapabilities />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Could not load Burrow capabilities")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("shows the unavailable placeholder while metadata has not loaded", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryDefaults(ov.meta().queryKey, { enabled: false });
    render(
      <QueryClientProvider client={client}>
        <BurrowCapabilities />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Capability details are unavailable.")).toBeTruthy();
  });

  it("keeps cached capabilities visible after a failed refresh", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
    client.setQueryData(ov.meta().queryKey, meta);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "offline", message: "refresh failed" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={client}>
        <BurrowCapabilities />
      </QueryClientProvider>,
    );

    await client.refetchQueries({ queryKey: ov.meta().queryKey });
    expect(await screen.findByText("Capability refresh failed; showing the last loaded data")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.getByText("refresh failed")).toBeTruthy();
  });

  it("stringifies a non-Error refresh failure", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ov.meta().queryKey;
    client.setQueryDefaults(queryKey, { enabled: false });
    client.setQueryData(queryKey, meta);
    const query = client.getQueryCache().find({ queryKey });
    query?.setState({
      ...query.state,
      error: "raw refresh failure" as unknown as Error,
      status: "error",
      fetchStatus: "idle",
    });
    render(
      <QueryClientProvider client={client}>
        <BurrowCapabilities />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Capability refresh failed; showing the last loaded data")).toBeTruthy();
    expect(screen.getByText("raw refresh failure")).toBeTruthy();
  });
});
