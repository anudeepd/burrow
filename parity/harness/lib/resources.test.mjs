import { describe, expect, it } from "bun:test";
import path from "node:path";
import { declaredDynamicPathCovers, expandResources, parseApiContract } from "../coverage.mjs";
import { compareThreadDumps, filterTimeDerived, normalizeBulkActivities, runWire, theirUrl } from "../wire.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe("contract resource coverage", () => {
  it("recognizes explicitly declared JMX attribute maps without covering unrelated schemas", () => {
    expect(declaredDynamicPathCovers("beans[].<attrName>", "beans.*.RpcCallSuccesses")).toBe(true);
    expect(declaredDynamicPathCovers("beans[].<attrName>", "beans.*.Composite.nested.value")).toBe(true);
    expect(declaredDynamicPathCovers("beans[].<attrName>", "app.allocatedMB")).toBe(false);
    expect(declaredDynamicPathCovers("beans[].name", "beans.*.DroppedAttribute")).toBe(false);
  });
  it("includes all RM, NM, and daemon surfaces declared in the contract", () => {
    const spec = parseApiContract(repoRoot);
    expect(spec.rm).toContain("/ws/v1/cluster/userinfo");
    expect(spec.rm).toContain("/ws/v1/cluster/apps/{appId}/appattempts/{attemptId}");
    expect(spec.nm).toContain("/ws/v1/node/containers/{containerId}");
    expect(spec.daemon).toContain("/conf?format=json");
    expect(spec.nmDaemon).toContain("/jmx?qry=Hadoop:*");
  });

  it("expands grouped subresources, attempts, and every NodeManager without partial URLs", () => {
    const scenario = {
      rmBase: "http://rm:8088",
      nodeBases: [{ webapp: "http://nm1:8042" }, { webapp: "http://nm2:8042" }],
      params: { appId: "application_1_0001", attemptId: "appattempt_1_0001_000001", nodeId: "nm1:8041" },
    };
    const targets = expandResources(parseApiContract(repoRoot), scenario);
    const paths = targets.map((t) => t.path);
    expect(paths).toContain("/ws/v1/cluster/apps/application_1_0001/timeouts/LIFETIME");
    expect(paths).toContain("/ws/v1/cluster/apps/application_1_0001/appattempts/appattempt_1_0001_000001");
    expect(paths).toContain("/ws/v1/cluster/apps/application_1_0001/state");
    expect(paths.some((p) => p.includes("{") || p.endsWith("/") || p.includes("//"))).toBe(false);
    expect(targets.filter((t) => t.path === "/ws/v1/node/info").map((t) => t.base)).toEqual(["http://nm1:8042", "http://nm2:8042"]);
    expect(targets.filter((t) => t.kind === "nm-daemon")).toHaveLength(4);
    expect(theirUrl("http://nm2:8042/conf?format=json", scenario)).toBe("/api/nm/nm2:8042/conf?format=json");
    expect(theirUrl("http://rm:8088/metrics", scenario)).toBe("/api/rm/metrics");
    expect(targets.find((t) => t.path === "/conf?format=json").headers.Accept).toBe("application/json");
  });

  it("normalizes activity request clocks without ignoring unrelated timestamps or lost fields", () => {
    const result = filterTimeDerived([
      { path: "$.appActivities.timestamp", kind: "value", a: 1000, b: 1005 },
      { path: "$.app.timestamp", kind: "value", a: 1000, b: 1005 },
      { path: "$.appActivities.timestamp", kind: "missing-in-b", a: 1000 },
    ]);
    expect(result.ignored).toHaveLength(1);
    expect(result.kept).toHaveLength(2);
    const duration = [{ path: "$[0].totalDuration", kind: "value", a: 1000, b: 1005 }];
    expect(filterTimeDerived(duration, { resource: "executors", a: [{ id: "driver" }], b: [{ id: "driver" }] }).ignored).toHaveLength(1);
    expect(filterTimeDerived(duration, { resource: "executors", a: [{ id: "1" }], b: [{ id: "1" }] }).kept).toHaveLength(1);
  });

  it("detects lost threads and sections even when thread stacks are live samples", () => {
    const dump = (count, body) => `Process Thread Dump: \n${count} active threads\n${body}`;
    const thread = (id, frame) => `Thread ${id} (Worker):\n  State: RUNNABLE\n  Blocked count: 0\n  Waited count: 0\n  Stack:\n    ${frame}\n`;
    expect(compareThreadDumps(dump(1, thread(1, "before")), dump(1, thread(1, "after"))).diff).toEqual([]);
    expect(compareThreadDumps(dump(2, thread(1, "a") + thread(2, "b")), dump(1, thread(1, "a"))).diff.length).toBeGreaterThan(0);
    expect(compareThreadDumps(dump(1, thread(1, "a")), dump(1, thread(1, "a").replace("  Stack:\n", ""))).diff.length).toBeGreaterThan(0);
  });

  it("preserves activity payload fields, every distinct decision, and total count across recording windows", () => {
    const body = (activities) => ({ bulkActivities: { activities } });
    const first = { nodeId: "nm1", timestamp: 10, dateTime: "first", allocations: [{ partition: "gpu", diagnostic: "waiting" }] };
    const second = { ...first, timestamp: 20, dateTime: "second" };
    expect(normalizeBulkActivities(body([first, second]))).toEqual(normalizeBulkActivities(body([second, first])));
    expect(normalizeBulkActivities(body([first, second]))).not.toEqual(normalizeBulkActivities(body([first])));
    expect(normalizeBulkActivities(body([first]))).not.toEqual(normalizeBulkActivities(body([{ ...first, allocations: [{}] }])));
  });

  it("fails the wire proof if a NodeManager body loses a field", async () => {
    const scenario = { rmBase: "http://rm:8088", oursBase: "http://ours:8787", nodeBases: [{ webapp: "http://nm:8042" }], params: {} };
    const response = (json) => ({ status: 200, json, text: JSON.stringify(json), headers: { "x-ys-api": "1" } });
    const direct = { get: async () => response({ preserved: true }) };
    const ours = { get: async (url) => response(url.includes("/api/nm/") ? {} : { preserved: true }) };
    const result = await runWire({ repoRoot, scenario, direct, ours, inventory: { fields: new Map() }, spark: false, log: () => {} });
    expect(result.status).toBe("fail");
    expect(result.mismatches.some((m) => m.ourPath.startsWith("/api/nm/"))).toBe(true);
  });

  it("fails Spark wire parity when a proxied collection loses data", async () => {
    const scenario = { rmBase: "http://rm:8088", oursBase: "http://ours:8787", shsBase: "http://shs:18080", nodeBases: [], params: {} };
    const app = "application_1_0001";
    const response = (json) => ({ status: 200, json, text: JSON.stringify(json), headers: { "x-ys-api": "1" } });
    const body = (url) => {
      if (url === "http://rm:8088/ws/v1/cluster/apps" || url === "http://ours:8787/api/yarn/apps") return { apps: { app: [{ id: app, state: "FINISHED", applicationType: "SPARK" }] } };
      if (url.includes("/api/v1/applications/") || url.includes("/api/spark/")) {
        if (url.endsWith("/jobs")) return [{ jobId: 1, name: "preserved" }];
        if (url.endsWith(`/${app}`) || url.endsWith("/application")) return { id: app, attempts: [] };
        return [];
      }
      return { preserved: true };
    };
    const direct = { get: async (url) => response(body(url)) };
    const ours = { get: async (url) => response(url.includes("/api/spark/") && url.endsWith("/jobs") ? [] : body(url)) };
    const result = await runWire({ repoRoot, scenario, direct, ours, inventory: { fields: new Map() }, log: () => {} });
    expect(result.status).toBe("fail");
    expect(result.spark.mismatches.some((m) => m.resource === "jobs")).toBe(true);
    expect(result.spark.checked.some((m) => m.resource === "environment")).toBe(true);
  });
});
