import { describe, expect, it } from "vitest";
import { metricHistorySample } from "./live";

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
});
