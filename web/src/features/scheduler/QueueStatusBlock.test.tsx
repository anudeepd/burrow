import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FairQueueInfo } from "~/api/schemas";
import type { CapacityRaw } from "./model";
import { CapacityQueueStatus, FairQueueStatus } from "./QueueStatusBlock";

afterEach(cleanup);

const resource = { memory: 1024, vCores: 2 };

describe("CapacityQueueStatus", () => {
  it("renders configured values and optional leaf details", () => {
    const raw = {
      state: "RUNNING",
      orderingPolicyInfo: "fifo",
      nodeLabels: ["gpu"],
      numActiveApplications: 1,
      numPendingApplications: 2,
      numContainers: 3,
      maxApplications: 4,
      maxApplicationsPerUser: 5,
      userLimit: 50,
      userLimitFactor: 0,
      preemptionDisabled: false,
      intraQueuePreemptionDisabled: true,
      defaultNodeLabelExpression: "gpu",
      defaultPriority: 6,
      isAutoCreatedLeafQueue: true,
      maxApplicationLifetime: -1,
      defaultApplicationLifetime: 30,
      configuredMaxAMResourceLimit: 40,
      capacities: {
        queueCapacitiesByPartition: [
          {
            weight: 2,
            usedCapacity: 25,
            capacity: 50,
            maxCapacity: 100,
            configuredMinResource: resource,
            configuredMaxResource: { memory: 2048, vCores: 4 },
            effectiveMinResource: resource,
            effectiveMaxResource: { memory: 2048, vCores: 4 },
            maxAMLimitPercentage: 25,
          },
        ],
      },
      resources: {
        resourceUsagesByPartition: [{ used: resource, amLimit: resource, amUsed: resource, userAmLimit: resource }],
      },
    } as unknown as CapacityRaw;
    render(<CapacityQueueStatus raw={raw} leaf />);

    for (const label of [
      "Queue State",
      "Configured Weight",
      "Configured Max Capacity",
      "Effective Capacity",
      "Effective Max Capacity",
      "Used Resources",
      "Used Application Master Resources",
      "Num Schedulable Applications",
      "Accessible Node Labels",
      "Preemption",
      "Intra-queue Preemption",
      "Max Application Lifetime",
      "Default Application Lifetime",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.queryByText("(unlimited)")).toBeNull();
  });

  it("renders fallbacks for an unweighted sparse queue and omits leaf-only rows for parents", () => {
    const raw = {
      state: "STOPPED",
      nodeLabels: [],
      capacities: {
        queueCapacitiesByPartition: [
          {
            weight: -1,
            configuredMaxResource: { memory: 0, vCores: 0 },
          },
        ],
      },
      resources: { resourceUsagesByPartition: [{}] },
    } as unknown as CapacityRaw;
    const view = render(<CapacityQueueStatus raw={raw} leaf />);
    expect(screen.getByText("Configured Capacity")).toBeTruthy();
    expect(screen.getByText("(unlimited)")).toBeTruthy();
    expect(screen.queryByText("Configured Weight")).toBeNull();
    expect(screen.queryByText("Ordering Policy")).toBeTruthy();
    view.unmount();

    render(<CapacityQueueStatus raw={raw} leaf={false} />);
    expect(screen.queryByText("Queue State")).toBeNull();
    expect(screen.queryByText("Num Schedulable Applications")).toBeNull();
  });
});

describe("FairQueueStatus", () => {
  it("renders resources, a normal application limit, and leaf preemption state", () => {
    const raw = {
      usedResources: resource,
      demandResources: resource,
      amUsedResources: resource,
      amMaxResources: resource,
      minResources: resource,
      maxResources: resource,
      maxContainerAllocation: resource,
      reservedResources: resource,
      pendingContainers: 1,
      allocatedContainers: 2,
      reservedContainers: 3,
      maxApps: 10,
      steadyFairResources: resource,
      fairResources: resource,
      schedulingPolicy: "fair",
      clusterResources: resource,
      preemptable: false,
      numActiveApps: 4,
      numPendingApps: 5,
    } as unknown as FairQueueInfo;
    render(<FairQueueStatus raw={raw} leaf />);
    for (const label of [
      "Used Resources",
      "Demand Resources",
      "AM Used Resources",
      "AM Max Resources",
      "Max Container Allocation",
      "Reserved Resources",
      "Steady Fair Share",
      "Instantaneous Fair Share",
      "Num Active Applications",
      "Preemptable",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.getByText("false")).toBeTruthy();
  });

  it("renders missing resources and the parent preemption explanation", () => {
    const raw = {
      usedResources: resource,
      minResources: resource,
      maxResources: resource,
      demandResources: resource,
      steadyFairResources: resource,
      fairResources: resource,
      pendingContainers: 0,
      allocatedContainers: 0,
      reservedContainers: 0,
      maxApps: 2147483647,
      schedulingPolicy: null,
      clusterResources: undefined,
      maxContainerAllocation: undefined,
      reservedResources: undefined,
      preemptable: null,
    } as unknown as FairQueueInfo;
    const view = render(<FairQueueStatus raw={raw} leaf />);
    expect(screen.getByText(/2,147,483,647 \(unlimited\)/)).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    view.unmount();

    render(<FairQueueStatus raw={{ ...raw, maxApps: null } as unknown as FairQueueInfo} leaf={false} />);
    expect(screen.getByText("parent queues have no preemptable field")).toBeTruthy();
    expect(screen.queryByText("Demand Resources")).toBeNull();
  });
});
