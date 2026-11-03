import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { metricHistorySample, startLive } from "./live";
import { historyStore } from "~/state/history";
import { parityStore } from "~/state/parity";
import { prefsStore } from "~/state/prefs";

const { startEventsMock } = vi.hoisted(() => ({ startEventsMock: vi.fn() }));
vi.mock("./events", () => ({ startEvents: startEventsMock }));

describe("metricHistorySample", () => {
  it("uses the cross-partition used and total resources shown by the overview", () => {
    const sample = metricHistorySample(
      {
        totalMB: 9000,
        allocatedMB: 0,
        totalVirtualCores: 12,
        allocatedVirtualCores: 0,
        crossPartitionMetricsAvailable: true,
        totalUsedResourcesAcrossPartition: { memory: 1024, vCores: 2 },
        totalReservedResourcesAcrossPartition: { memory: 0, vCores: 0 },
        totalClusterResourcesAcrossPartition: { memory: 9216, vCores: 12 },
        appsRunning: 1,
        appsPending: 0,
        containersAllocated: 2,
      },
      1234,
    );

    expect(sample).toEqual({
      t: 1234,
      memPct: (1024 / 9216) * 100,
      vcorePct: (2 / 12) * 100,
      appsRunning: 1,
      appsPending: 0,
      containers: 2,
    });
  });

  it("falls back to allocated percentages when cross-partition resources are absent", () => {
    const sample = metricHistorySample(
      {
        totalMB: 9000,
        allocatedMB: 900,
        totalVirtualCores: 12,
        allocatedVirtualCores: 3,
        crossPartitionMetricsAvailable: false,
        appsRunning: 1,
        appsPending: 0,
        containersAllocated: 2,
      },
      1234,
    );

    expect(sample).toMatchObject({ memPct: 10, vcorePct: 25 });
  });

  it("handles optional cross-partition values and zero capacity safely", () => {
    const partial = metricHistorySample(
      {
        totalMB: 1000,
        allocatedMB: 10,
        totalVirtualCores: 0,
        allocatedVirtualCores: 2,
        crossPartitionMetricsAvailable: true,
        totalUsedResourcesAcrossPartition: { memory: 200, vCores: 4 },
        appsRunning: 0,
        appsPending: 0,
        containersAllocated: 0,
      },
      1,
    );
    expect(partial).toMatchObject({ memPct: 20, vcorePct: 0 });
    expect(
      metricHistorySample(
        {
          totalMB: 0,
          allocatedMB: 0,
          totalVirtualCores: 0,
          allocatedVirtualCores: 0,
          crossPartitionMetricsAvailable: false,
          appsRunning: 0,
          appsPending: 0,
          containersAllocated: 0,
        },
        1,
      ),
    ).toBeNull();
  });
});

describe("startLive", () => {
  it("samples successful query data, starts SSE once, and refetches dynamic queries on resume", () => {
    const originalPrefs = prefsStore.get();
    const originalParity = parityStore.get().enabled;
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    const client = new QueryClient();
    historyStore.setState(() => ({ samples: [] }));
    startEventsMock.mockReset();
    parityStore.setState(() => ({ enabled: false }));

    try {
      startLive(client);
      startLive(client);
      expect(startEventsMock).toHaveBeenCalledOnce();
      const enabled = startEventsMock.mock.calls[0]![1] as () => boolean;

      expect(enabled()).toBe(true);
      client.setQueryData(["meta"], { now: Date.now() + 500, features: { events: false } });
      expect(enabled()).toBe(false);
      client.setQueryData(["meta"], { now: Date.now() + 500, features: { events: true } });
      expect(enabled()).toBe(true);

      client.setQueryData(["yarn", "metrics"], {
        clusterMetrics: {
          totalMB: 100,
          allocatedMB: 25,
          totalVirtualCores: 4,
          allocatedVirtualCores: 1,
          crossPartitionMetricsAvailable: false,
          appsRunning: 2,
          appsPending: 1,
          containersAllocated: 3,
        },
      });
      expect(historyStore.get().samples).toHaveLength(1);
      expect(historyStore.get().samples[0]).toMatchObject({ memPct: 25, vcorePct: 25, appsRunning: 2, appsPending: 1, containers: 3 });

      client.setQueryData(["yarn", "metrics"], { clusterMetrics: { totalMB: 0 } });
      expect(historyStore.get().samples).toHaveLength(1);
      client.setQueryData(["yarn", "metrics"], {});
      client.setQueryData(["meta"], { features: { events: true } });
      client.setQueryData(["other"], {});

      const refetch = vi.spyOn(client, "refetchQueries").mockResolvedValue(undefined);
      prefsStore.setState((p) => ({ ...p, livePaused: true }));
      prefsStore.setState((p) => ({ ...p, livePaused: false }));
      expect(refetch).toHaveBeenCalledTimes(1);
      const predicate = refetch.mock.calls[0]![0]?.predicate;
      expect(predicate?.({ meta: { refetchKind: "live" } } as never)).toBe(true);
      expect(predicate?.({ meta: { refetchKind: "slow" } } as never)).toBe(true);
      expect(predicate?.({ meta: { refetchKind: "static" } } as never)).toBe(false);
      expect(predicate?.({ meta: undefined } as never)).toBe(false);

      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(refetch).toHaveBeenCalledTimes(2);
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(refetch).toHaveBeenCalledTimes(2);
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      prefsStore.setState((p) => ({ ...p, liveIntervalMs: p.liveIntervalMs + 1000 }));
      expect(refetch).toHaveBeenCalledTimes(3);
    } finally {
      client.clear();
      prefsStore.setState(() => originalPrefs);
      parityStore.setState(() => ({ enabled: originalParity }));
      historyStore.setState(() => ({ samples: [] }));
      if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
      else Reflect.deleteProperty(document, "hidden");
    }
  });

  it("does not start in parity mode", async () => {
    const parity = window.__BURROW_PARITY__;
    window.__BURROW_PARITY__ = true;
    vi.resetModules();
    try {
      const { startLive: startParityLive } = await import("./live");
      startEventsMock.mockClear();
      startParityLive(new QueryClient());
      expect(startEventsMock).not.toHaveBeenCalled();
    } finally {
      window.__BURROW_PARITY__ = parity;
      vi.resetModules();
    }
  });

  it("returns before touching browser APIs during server rendering", async () => {
    vi.stubGlobal("window", undefined);
    vi.resetModules();
    try {
      const { startLive: startServerLive } = await import("./live");
      startEventsMock.mockClear();
      expect(() => startServerLive(new QueryClient())).not.toThrow();
      expect(startEventsMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
