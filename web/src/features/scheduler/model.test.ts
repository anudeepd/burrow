/**
 * Unit tests over REAL captured payloads (fixtures/rm/scheduler/MANIFEST.json):
 * all three scheduler types, a nested capacity tree, the "empty cluster" FIFO shape, activities and conf.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SchedulerResponseSchema, SchedulerActivitiesSchema, SchedulerConfSchema } from "~/api/schemas";
import {
  activityField,
  activityRows,
  buildCapacityTree,
  buildFairTree,
  buildTree,
  capacityMetrics,
  fairMetrics,
  findQueue,
  healthOperations,
  headroomOf,
  leafNodes,
  metricsOf,
  num,
  overShareCount,
  partitionNames,
  partitionOf,
  pressurePctOf,
  rowsForQueue,
  schedKindOf,
  usedOfFairPct,
  usedOfMinPct,
  walkTree,
} from "./model";
import type { QueueNode } from "./model";
import { treemapItems } from "./TreemapSection";
import { squarify } from "./Treemap";

function fixture<T = unknown>(rel: string): T {
  // vitest runs with cwd = web/, and Vite rewrites `new URL(..., import.meta.url)` into an asset request
  return JSON.parse(readFileSync(`../fixtures/rm/scheduler/${rel}`, "utf8")) as T;
}

const parseScheduler = (rel: string) => SchedulerResponseSchema.parse(fixture(rel));

describe("captured scheduler payloads", () => {
  it("capacity: parses and builds the nested tree", () => {
    const res = parseScheduler("capacity/scheduler.json");
    const info = res.scheduler.schedulerInfo;
    expect(schedKindOf(info)).toBe("capacity");
    const root = buildTree(info);
    expect(root).not.toBeNull();
    const paths = walkTree(root!).map((n) => n.id);
    expect(paths).toContain("root");
    expect(paths).toContain("root.etl");
    expect(paths).toContain("root.etl.ingest");
    expect(paths).toContain("root.etl.transform");
    expect(findQueue(root, "root.etl.ingest")?.role).toBe("leaf");
    expect(findQueue(root, "root.etl")?.role).toBe("parent");
    expect(findQueue(root, "root.etl")?.children.map((c) => c.name)).toEqual(["ingest", "transform"]);
  });

  it("capacity: metrics come from the real keys (percent, MB, counters)", () => {
    const root = buildTree(parseScheduler("capacity/scheduler.json").scheduler.schedulerInfo)!;
    const ingest = findQueue(root, "root.etl.ingest")!;
    const m = metricsOf(ingest);
    expect(m.absCapPct).toBeCloseTo(24, 3);
    expect(m.capPct).toBeCloseTo(60.000004, 3);
    expect(m.maxPct).toBeCloseTo(100, 3);
    expect(ingest.capacity?.state).toBe("RUNNING");
    expect(m.maxApps).toBeGreaterThan(0);
    expect(typeof m.usedMb).toBe("number");
    // every leaf has a maxEffectiveCapacity → headroom is computable
    expect(m.maxMb).not.toBeNull();
    const h = headroomOf(ingest);
    expect(h.guaranteedFreePct).not.toBeNull();
    expect(h.burstRoomPct).not.toBeNull();
    expect(h.freeMb).not.toBeNull();
  });

  it("capacity: partitions are enumerated, default first", () => {
    const root = buildTree(parseScheduler("capacity/scheduler.json").scheduler.schedulerInfo)!;
    const parts = partitionNames(root);
    expect(parts[0]).toBe("");
    expect(parts).toContain("gpu");
    expect(parts).toContain("ssd");
    // the gpu partition has its own capacity numbers (this cluster mirrors the default share, so compare the entry itself)
    const ingest = findQueue(root, "root.etl.ingest")!;
    const gpu = capacityMetrics(ingest.capacity!, "gpu");
    expect(gpu.capPct).not.toBeNull();
    const { cap: gpuCap, res: gpuRes } = partitionOf(ingest, "gpu");
    expect(gpuCap?.partitionName).toBe("gpu");
    expect(gpuRes?.partitionName).toBe("gpu");
    expect(partitionOf(ingest, "nope").cap).toBeUndefined();
  });

  it("capacity: a queue can be over its guaranteed share (the freeness story)", () => {
    const root = buildTree(parseScheduler("capacity/scheduler.json").scheduler.schedulerInfo)!;
    expect(overShareCount(root)).toBeGreaterThanOrEqual(0);
    const rootNode = findQueue(root, "root")!;
    expect(headroomOf(rootNode).guaranteedFreePct).not.toBeNull();
  });

  it("capacity: reports unused share as a percentage of the queue's own guarantee", () => {
    const root = buildTree(parseScheduler("capacity/scheduler.json").scheduler.schedulerInfo)!;
    const queue = findQueue(root, "root.default")!;
    const defaultPartition = queue.capacity!.capacities!.queueCapacitiesByPartition![0]!;

    defaultPartition.usedCapacity = 0;
    expect(metricsOf(queue).usedPct).toBe(0);
    expect(headroomOf(queue).guaranteedFreePct).toBe(100);

    defaultPartition.usedCapacity = 50;
    expect(metricsOf(queue).usedPct).toBe(50);
    expect(headroomOf(queue).guaranteedFreePct).toBe(50);

    defaultPartition.usedCapacity = 125;
    expect(headroomOf(queue).guaranteedFreePct).toBe(0);
  });

  it("fair: parses, builds the childQueues tree and normalises fair metrics", () => {
    const res = parseScheduler("fair/scheduler.json");
    const info = res.scheduler.schedulerInfo;
    expect(schedKindOf(info)).toBe("fair");
    const root = buildFairTree(info as never);
    const names = walkTree(root).map((n) => n.id);
    expect(names[0]).toBe("root");
    expect(names).toContain("root.etl");
    expect(names).toContain("root.etl.transform");
    expect(names).toContain("root.adhoc");
    const etl = findQueue(root, "root.etl")!;
    const m = fairMetrics(etl.fair!);
    expect(m.fairMb).not.toBeNull();
    expect(m.minMb).not.toBeNull();
    expect(m.maxMb).not.toBeNull();
    expect(m.policy).toBeTruthy();
    expect(headroomOf(etl).fairShareFreeMb).not.toBeNull();
    // parents have no numActiveApps in the fair shape
    expect(m.activeApps).toBeNull();
  });

  it("fifo: parses the single-queue shape of an empty cluster", () => {
    const res = parseScheduler("fifo/scheduler.json");
    const info = res.scheduler.schedulerInfo;
    expect(schedKindOf(info)).toBe("fifo");
    expect(buildTree(info)).toBeNull();
    if (info.type === "fifoScheduler") {
      expect(info.numNodes).toBe(0);
      expect(info.numContainers).toBe(0);
      expect(info.capacity).toBeGreaterThan(0);
      expect(Number.isFinite(info.usedCapacity)).toBe(true);
    }
  });

  it("activities: flattens the allocation tree with depth-accurate field paths", () => {
    const act = SchedulerActivitiesSchema.parse(fixture("capacity/scheduler-activities.json")).activities;
    const rows = activityRows(act);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.depth).toBe(0);
    expect(rows[0]?.queue).toBeTruthy();
    expect(activityField(0, "name")).toBe("activities.allocations.root.name");
    expect(activityField(1, "name")).toBe("activities.allocations.root.children.name");
    expect(rowsForQueue(rows, "root").length).toBe(rows.length);
    expect(rowsForQueue(rows, "root.does-not-exist")).toHaveLength(0);
  });

  it("activities: an empty snapshot still parses (waiting for next allocation)", () => {
    const act = SchedulerActivitiesSchema.parse({ activities: { diagnostic: "waiting for next allocation" } }).activities;
    expect(activityRows(act)).toHaveLength(0);
  });

  it("preserves allocation fallback rows and node identity across empty and nested snapshots", () => {
    const rows = activityRows({
      timestamp: 1_791_015_558_000,
      nodeId: "nm:8042",
      diagnostic: "no root payload",
      allocations: [
        { updatedContainerId: "container_1", partition: "gpu", finalAllocationState: "SKIPPED" },
        {
          root: {
            name: "",
            nodeIds: [],
            children: [
              { name: "root.child", nodeIds: ["node-list:8041"], children: [] },
              { name: "root.specific", nodeId: "node-field:8041", nodeIds: ["ignored"], children: [] },
            ],
          },
        },
      ],
    });
    expect(rows).toMatchObject([
      {
        time: 1_791_015_558_000,
        containerId: "container_1",
        nodeId: "nm:8042",
        queue: "no root payload",
        state: null,
        diagnostic: "no root payload",
        partition: "gpu",
        finalState: "SKIPPED",
        depth: 0,
      },
      { queue: "", nodeId: "nm:8042", depth: 0 },
      { queue: "root.child", nodeId: "node-list:8041", depth: 1 },
      { queue: "root.specific", nodeId: "node-field:8041", depth: 1 },
    ]);
    expect(rowsForQueue(rows, "root")).toHaveLength(2);
    expect(activityRows({ allocations: [] })).toEqual([]);
    expect(activityRows(undefined)).toEqual([]);
  });

  it("handles missing capacity and fair metrics without inventing percentages", () => {
    expect(num("42")).toBe(42);
    expect(num("Infinity")).toBeNull();
    expect(num(Number.NaN)).toBeNull();
    expect(num(true)).toBeNull();

    const capacity = buildCapacityTree({ type: "capacityScheduler", queueName: "root", capacity: 100, usedCapacity: 0, maxCapacity: 100 });
    const fair: QueueNode = {
      id: "root",
      name: "root",
      depth: 0,
      role: "root",
      children: [],
      fair: {} as NonNullable<QueueNode["fair"]>,
    };
    expect(partitionOf({ id: "empty", name: "empty", depth: 0, role: "leaf", children: [] }, "gpu")).toEqual({
      cap: undefined,
      res: undefined,
    });
    expect(partitionNames(capacity)).toEqual([]);
    expect(metricsOf({ id: "empty", name: "empty", depth: 0, role: "leaf", children: [] }).usedMb).toBeNull();
    expect(pressurePctOf(capacity, { ...metricsOf(capacity), usedPct: null, absUsedPct: 25, absCapPct: 50 })).toBe(50);
    expect(pressurePctOf(capacity, { ...metricsOf(capacity), usedPct: null, absUsedPct: null, absCapPct: 50 })).toBeNull();
    expect(pressurePctOf(capacity, { ...metricsOf(capacity), absCapPct: 0, absUsedPct: 1 })).toBe(Number.POSITIVE_INFINITY);
    expect(pressurePctOf(fair, { ...metricsOf(fair), fairMb: 0, usedMb: 1 })).toBe(Number.POSITIVE_INFINITY);
    expect(pressurePctOf(fair, { ...metricsOf(fair), fairMb: 25, usedMb: 10 })).toBe(40);
    expect(pressurePctOf(fair, { ...metricsOf(fair), fairMb: 0, usedMb: null })).toBeNull();
    expect(usedOfFairPct(fair)).toBeNull();
    expect(usedOfMinPct(fair)).toBeNull();
  });

  it("maps scheduler health operations and preserves unknown operations", () => {
    expect(healthOperations(undefined)).toEqual([]);
    expect(
      healthOperations({
        lastrun: 0,
        lastRunDetails: [],
        operationsInfo: [
          { operation: "last-allocation", nodeId: "n1", containerId: "c1", queue: "root" },
          { operation: "last-release" },
          { operation: "last-preemption" },
          { operation: "last-reservation" },
          { operation: "future-operation" },
        ],
      }),
    ).toEqual([
      { operation: "last-allocation", kind: "Allocation", nodeId: "n1", containerId: "c1", queue: "root" },
      { operation: "last-release", kind: "Release", nodeId: null, containerId: null, queue: null },
      { operation: "last-preemption", kind: "Preemption", nodeId: null, containerId: null, queue: null },
      { operation: "last-reservation", kind: "Reservation", nodeId: null, containerId: null, queue: null },
      { operation: "future-operation", kind: "Other", nodeId: null, containerId: null, queue: null },
    ]);
  });

  it("conf: the captured scheduler configuration parses into property rows", () => {
    const conf = SchedulerConfSchema.parse(fixture("capacity/scheduler-conf.json"));
    expect(conf.property.length).toBeGreaterThan(10);
    expect(conf.property.every((p) => p.name.startsWith("yarn."))).toBe(true);
  });
});

describe("treemap geometry", () => {
  it("squarify fills the viewport without overlap", () => {
    const items = [
      { key: "a", label: "a", value: 6, field: "f", raw: 6, usedPct: 50 },
      { key: "b", label: "b", value: 3, field: "f", raw: 3, usedPct: 50 },
      { key: "c", label: "c", value: 1, field: "f", raw: 1, usedPct: 50 },
    ];
    const tiles = squarify(items, 0, 0, 100, 50);
    expect(tiles).toHaveLength(3);
    const area = tiles.reduce((a, t) => a + t.w * t.h, 0);
    expect(area).toBeCloseTo(5000, 4);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(100.0001);
      expect(t.y + t.h).toBeLessThanOrEqual(50.0001);
    }
  });

  it("squarify returns nothing for an empty or zero-area input", () => {
    expect(squarify([], 0, 0, 100, 50)).toHaveLength(0);
    expect(squarify([{ key: "a", label: "a", value: 0, field: "f", raw: 0, usedPct: null }], 0, 0, 100, 50)).toHaveLength(0);
  });

  it("treemap items use leaf queues and the partition-aware used field", () => {
    const root = buildTree(parseScheduler("capacity/scheduler.json").scheduler.schedulerInfo)!;
    const items = treemapItems(root, "used", "");
    expect(items.length).toBe(leafNodes(root).length);
    expect(items.every((i) => i.field === "queue.resourcesUsed.memory")).toBe(true);
    const gpuItems = treemapItems(root, "used", "gpu");
    expect(gpuItems.every((i) => i.field === "queue.resources.resourceUsagesByPartition.used.memory")).toBe(true);
  });
});

describe("capacity tree edge cases", () => {
  it("a root with no children is a single leaf-ish root", () => {
    const node = buildCapacityTree({
      type: "capacityScheduler",
      capacity: 100,
      usedCapacity: 0,
      maxCapacity: 100,
      queueName: "root",
      queuePath: "root",
    });
    expect(node.children).toHaveLength(0);
    expect(node.role).toBe("root");
    expect(walkTree(node)).toHaveLength(1);
    expect(partitionNames(node)).toEqual([]);
    expect(overShareCount(node)).toBe(0);
  });
});
