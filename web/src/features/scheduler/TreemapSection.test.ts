// @vitest-environment node
import { describe, expect, it } from "vitest";
import { shortQueueLabels, treemapItems } from "./TreemapSection";

describe("scheduler treemap derivation", () => {
  it("selects default and labeled capacity values for both sizing bases", () => {
    const root = {
      id: "root",
      name: "root",
      depth: 0,
      role: "root",
      children: [
        {
          id: "root.analytics",
          name: "analytics",
          depth: 1,
          role: "leaf",
          children: [],
          capacity: {
            resourcesUsed: { memory: 256 },
            minEffectiveCapacity: { memory: 512 },
            usedCapacity: 50,
            absoluteUsedCapacity: 25,
            capacity: 100,
            absoluteCapacity: 100,
            maxCapacity: 100,
            absoluteMaxCapacity: 100,
            capacities: { queueCapacitiesByPartition: [{ partitionName: "gpu", effectiveMinResource: { memory: 64 } }] },
            resources: { resourceUsagesByPartition: [{ partitionName: "gpu", used: { memory: 128 } }] },
          },
        },
      ],
    } as never;

    expect(treemapItems(root, "used")).toEqual([
      {
        key: "root.analytics",
        label: "analytics",
        value: 256,
        field: "queue.resourcesUsed.memory",
        raw: 256,
        usedPct: 50,
        sub: "256 MiB used of 512 MiB guaranteed",
      },
    ]);
    expect(treemapItems(root, "capacity")[0]).toMatchObject({
      value: 512,
      field: "queue.minEffectiveCapacity.memory",
      raw: 512,
      sub: "guaranteed 512 MiB, 256 MiB used",
    });
    expect(treemapItems(root, "used", "gpu")[0]).toMatchObject({
      value: 256,
      field: "queue.resources.resourceUsagesByPartition.used.memory",
      raw: 128,
      sub: "256 MiB used of 512 MiB guaranteed",
    });
    expect(treemapItems(root, "capacity", "gpu")[0]).toMatchObject({
      value: 512,
      field: "queue.capacities.queueCapacitiesByPartition.effectiveMinResource.memory",
      raw: 64,
      sub: "guaranteed 512 MiB, 256 MiB used",
    });
  });

  it("uses the shortest unique queue suffix, keeping root only when it disambiguates", () => {
    expect([...shortQueueLabels(["root", "root.prod.etl", "root.dev.etl", "root.prod.reports", "root.team-01"]).entries()].sort()).toEqual([
      ["root", "root"],
      ["root.dev.etl", "dev.etl"],
      ["root.prod.etl", "prod.etl"],
      ["root.prod.reports", "reports"],
      ["root.team-01", "team-01"],
    ]);
    expect(shortQueueLabels([""]).get("")).toBe("");
  });

  it("handles fair leaves and missing used or guaranteed resources", () => {
    const root = {
      id: "root",
      name: "root",
      depth: 0,
      role: "root",
      children: [
        {
          id: "root.fair",
          name: "fair",
          depth: 1,
          role: "leaf",
          children: [],
          fair: { usedResources: { memory: 128 }, minResources: { memory: 256 }, fairResources: { memory: 300 } },
        },
        { id: "root.empty", name: "empty", depth: 1, role: "leaf", children: [], fair: {} },
      ],
    } as never;

    expect(treemapItems(root, "used")).toMatchObject([
      { key: "root.fair", value: 128, field: "queue.usedResources.memory", raw: 128, sub: "128 MiB used of 256 MiB guaranteed" },
      { key: "root.empty", value: 0, field: "queue.usedResources.memory", raw: undefined, sub: "— used" },
    ]);
    expect(treemapItems(root, "capacity")).toMatchObject([
      { key: "root.fair", value: 256, field: "queue.minResources.memory", raw: 256, sub: "guaranteed 256 MiB, 128 MiB used" },
      { key: "root.empty", value: 0, field: "queue.minResources.memory", raw: undefined, sub: "guaranteed —" },
    ]);
    expect(treemapItems(root, "used").map((entry) => entry.label)).toEqual(["fair", "empty"]);
  });
});
