import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { listOf } from "./_base";
import { boolish, entryMap, floatish } from "./_lenient";
import { selectApp } from "./app";
import { selectAppAttempts } from "./app-attempt";
import { selectAppStatistics, selectAppTimeouts } from "./app-misc";
import { selectClusterInfo } from "./cluster-info";
import { selectClusterMetrics } from "./cluster-metrics";
import { ContainerResponseSchema, ContainersResponseSchema, selectContainer, selectContainers } from "./container";
import { ConfResponseSchema, JmxResponseSchema, selectConf, selectJmxBeans } from "./daemon";
import { selectNodes, selectNode } from "./node";
import { selectLabelMappings, selectNodeLabels, selectNodeToLabels } from "./node-labels";
import { NmAppsResponseSchema, NmContainersResponseSchema, NmInfoResponseSchema } from "../queries/nodes";
import { isCapacityScheduler, isFairScheduler, isFifoScheduler, SchedulerInfoSchema, UnknownSchedulerInfoSchema } from "./scheduler";

describe("schema compatibility branches", () => {
  it("builds loose objects when strict schemas are disabled", async () => {
    const strict = Reflect.get(globalThis, "__BURROW_STRICT_SCHEMAS__");
    Reflect.set(globalThis, "__BURROW_STRICT_SCHEMAS__", false);
    vi.resetModules();
    try {
      const { obj } = await import("./_base");
      expect(obj({ value: z.string() }).parse({ value: "ok", extra: true })).toEqual({ value: "ok", extra: true });
    } finally {
      if (strict === undefined) Reflect.deleteProperty(globalThis, "__BURROW_STRICT_SCHEMAS__");
      else Reflect.set(globalThis, "__BURROW_STRICT_SCHEMAS__", strict);
      vi.resetModules();
    }
  });

  it("normalizes singleton, array, absent, and null list values and Java map shapes", () => {
    const list = listOf(z.string());
    expect(list.parse("one")).toEqual(["one"]);
    expect(list.parse(["one", "two"])).toEqual(["one", "two"]);
    expect(list.parse(null)).toEqual([]);
    expect(list.parse(undefined)).toEqual([]);

    expect(boolish.parse("true")).toBe(true);
    expect(boolish.parse("false")).toBe(false);
    expect(floatish.parse("NaN")).toBeNaN();
    expect(entryMap(z.number()).parse([{ key: "one", value: 1 }])).toEqual({ one: 1 });
    expect(entryMap(z.number()).parse({ entry: [{ key: "one", value: 1 }] })).toEqual({ one: 1 });
    expect(entryMap(z.number()).parse({ entry: { key: "one", value: 1 } })).toEqual({ one: 1 });
    expect(entryMap(z.number()).parse({ one: 1 })).toEqual({ one: 1 });
    expect(entryMap(z.number()).parse(null)).toEqual({});
  });

  it("selects wrapped app, attempt, timeout, statistics, cluster, node, and label data", () => {
    const item = { id: "item" } as never;
    expect(selectApp({ app: item })).toBe(item);
    expect(selectAppAttempts({})).toEqual([]);
    expect(selectAppAttempts({ appAttempts: null } as never)).toEqual([]);
    expect(selectAppAttempts({ appAttempts: { appAttempt: [item] } } as never)).toEqual([item]);
    expect(selectAppTimeouts({ timeouts: { timeout: [item] } } as never)).toEqual([item]);
    expect(selectAppStatistics({})).toEqual([]);
    expect(selectAppStatistics({ appStatInfo: { statItem: [item] } } as never)).toEqual([item]);
    expect(selectClusterInfo({ clusterInfo: item } as never)).toBe(item);
    expect(selectClusterMetrics({ clusterMetrics: item } as never)).toBe(item);
    expect(selectNodes({})).toEqual([]);
    expect(selectNodes({ nodes: { node: [item] } } as never)).toEqual([item]);
    expect(selectNode({ node: item } as never)).toBe(item);
    expect(selectNodeLabels({ nodeLabelInfo: [item] } as never)).toEqual([item]);
    expect(selectNodeToLabels({} as never)).toEqual({});
    expect(selectNodeToLabels({ nodeToLabels: { "worker:8041": { nodeLabelInfo: [item] } } } as never)).toEqual({
      "worker:8041": [item],
    });
    expect(selectLabelMappings({} as never)).toEqual([]);
    expect(selectLabelMappings({ labelsToNodes: { entry: [item] } } as never)).toEqual([item]);
  });

  it("normalizes wrapped and unwrapped container and daemon payloads", () => {
    const container = {
      containerId: "container_1",
      allocatedMB: 1,
      allocatedVCores: 1,
      priority: 1,
      startedTime: 1,
      finishedTime: 0,
      elapsedTime: 1,
      containerExitStatus: 0,
      containerState: "RUNNING",
      nodeId: "worker:8041",
    };
    expect(ContainersResponseSchema.parse({}).containers).toEqual({ container: [] });
    expect(ContainersResponseSchema.parse({ container: [container] }).containers?.container).toEqual([container]);
    expect(ContainersResponseSchema.parse({ containers: { container: [container] } }).containers?.container).toEqual([container]);
    expect(selectContainers({} as never)).toEqual([]);
    expect(selectContainers({ containers: { container: [container] } } as never)).toEqual([container]);
    expect(ContainerResponseSchema.parse(container)).toEqual({ container });
    expect(ContainerResponseSchema.parse({ container })).toEqual({ container });
    expect(selectContainer({ container } as never)).toBe(container);

    const property = { key: "x", value: "y", isFinal: false };
    expect(ConfResponseSchema.parse({ property })).toEqual({ properties: [property] });
    expect(selectConf({ properties: [property] } as never)).toEqual([property]);
    const bean = { name: "java.lang:type=Memory", used: 1 };
    expect(selectJmxBeans(JmxResponseSchema.parse({ beans: [bean] }))).toEqual([bean]);

    expect(NmContainersResponseSchema.parse({})).toEqual([]);
    expect(NmContainersResponseSchema.parse({ containers: {} })).toEqual([]);
    const nmContainer = {
      id: "container_1",
      nodeId: "worker:8041",
      state: "RUNNING",
      exitCode: 0,
      user: "alice",
      totalMemoryNeededMB: 1,
      totalVCoresNeeded: 1,
    };
    expect(NmContainersResponseSchema.parse({ containers: { container: [nmContainer] } })).toEqual([
      { ...nmContainer, containerLogFiles: [] },
    ]);
    expect(NmAppsResponseSchema.parse({})).toEqual([]);
    expect(NmAppsResponseSchema.parse({ apps: { app: [{ id: "app_1" }] } })).toEqual([{ id: "app_1", containerids: [] }]);
    expect(
      NmInfoResponseSchema.parse({
        nodeInfo: {
          healthReport: "",
          nodeHealthy: true,
          lastNodeUpdateTime: 1,
          totalVmemAllocatedContainersMB: 1,
          totalPmemAllocatedContainersMB: 1,
          totalVCoresAllocatedContainers: 1,
          vmemCheckEnabled: true,
          pmemCheckEnabled: false,
          nodeManagerVersion: "3.5",
        },
      }),
    ).toMatchObject({ nodeManagerVersion: "3.5" });
  });

  it("accepts unknown scheduler types and identifies every known scheduler kind", () => {
    expect(UnknownSchedulerInfoSchema.parse({ type: "futureScheduler", added: true })).toMatchObject({ type: "futureScheduler" });
    expect(() => UnknownSchedulerInfoSchema.parse({ type: "capacityScheduler" })).toThrow();
    expect(() => SchedulerInfoSchema.parse({ type: "capacityScheduler" })).toThrow();
    expect(isCapacityScheduler({ type: "capacityScheduler" } as never)).toBe(true);
    expect(isFairScheduler({ type: "fairScheduler" } as never)).toBe(true);
    expect(isFifoScheduler({ type: "fifoScheduler" } as never)).toBe(true);
    expect(isCapacityScheduler({ type: "futureScheduler" } as never)).toBe(false);
    expect(isFairScheduler({ type: "futureScheduler" } as never)).toBe(false);
    expect(isFifoScheduler({ type: "futureScheduler" } as never)).toBe(false);
  });
});
