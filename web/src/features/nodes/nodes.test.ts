// @vitest-environment node
/**
 * Nodes domain tests — every fixture is the REAL payload captured from the live Hadoop 3.4.3 cluster
 * (`fixtures/rm/nodes/**`), parsed in STRICT schema mode (vitest.setup.ts), so an unknown key fails here first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LabelMappingsResponseSchema,
  NodeLabelsResponseSchema,
  NodeResponseSchema,
  NodesResponseSchema,
  NodeToLabelsResponseSchema,
} from "~/api/schemas";
import { NmAppsResponseSchema, NmContainersResponseSchema, NmInfoResponseSchema } from "~/api/queries/nodes";
import { nodeColumns } from "./columns";
import {
  allocationTagSummary,
  averageNodeMemoryUtilization,
  appIdOfContainer,
  buildLabelRows,
  countByTab,
  customResourceNames,
  customResourceValue,
  resourceMatrix,
  DEFAULT_LABEL,
  groupByRack,
  labelNameText,
  labelTypeText,
  resourceText,
  healthOf,
  inTab,
  matchesFilter,
  numOf,
  NODE_STATE_TABS,
  rackOf,
  STANDARD_RESOURCE_TYPES,
  summarize,
  totalMemoryMB,
  totalVCores,
  utilBand,
  utilOf,
} from "./domain";
const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/rm/nodes/${name}`, import.meta.url)), "utf8")) as unknown;

const nodes = NodesResponseSchema.parse(fixture("nodes.json")).nodes?.node ?? [];
const node = NodeResponseSchema.parse(fixture("node-127.0.0.3_8041.json")).node;
const labels = NodeLabelsResponseSchema.parse(fixture("get-node-labels.json"));
const nodeToLabels = NodeToLabelsResponseSchema.parse(fixture("get-node-to-labels.json"));
const mappings = LabelMappingsResponseSchema.parse(fixture("label-mappings.json"));

describe("node payloads (live capture)", () => {
  it("parses 3 nodes with the fields the 16 legacy columns need", () => {
    expect(nodes).toHaveLength(3);
    for (const n of nodes) {
      expect(n.id).toMatch(/^127\.0\.0\.\d+:8041$/);
      expect(n.state).toBe("RUNNING");
      expect(typeof n.usedMemoryMB).toBe("number");
      expect(typeof n.availMemoryMB).toBe("number");
      expect(typeof n.usedVirtualCores).toBe("number");
      expect(typeof n.availableVirtualCores).toBe("number");
      expect(typeof n.memUtilization).toBe("number");
      expect(typeof n.cpuUtilization).toBe("number");
      expect(n.totalResource?.memory).toBeGreaterThan(0);
      expect(n.resourceUtilization?.nodePhysicalMemoryMB).toBeGreaterThan(0);
    }
  });

  it("round-trips a single-node payload", () => {
    expect(node.id).toBe("127.0.0.3:8041");
    expect(node.nodeLabels).toEqual(["ssd"]);
    expect(node.version).toBe("3.4.3");
  });

  it("legacy column set is exactly the 16 columns, in legacy order", () => {
    const cols = nodeColumns();
    expect(cols.map((c) => (c.meta as { label: string }).label)).toEqual([
      "Node Labels",
      "Rack",
      "Node State",
      "Node Address",
      "Node HTTP Address",
      "Last health-update",
      "Health-report",
      "Containers",
      "Allocation Tags",
      "Mem Used",
      "Mem Avail",
      "Phys Mem Used %",
      "VCores Used",
      "VCores Avail",
      "Phys VCores Used %",
      "Version",
    ]);
    expect(cols).toHaveLength(16);
    for (const c of cols) expect(c.cell, `column ${c.id} needs a cell`).toBeTypeOf("function");
  });
});

describe("derived values", () => {
  it("reads both utilisation percentages and bands them", () => {
    const u = utilOf(node);
    expect(u.mem).toBeCloseTo(node.memUtilization as number, 6);
    expect(u.cpu).toBeCloseTo(node.cpuUtilization as number, 6);
    expect(u.max).toBe(Math.max(u.mem, u.cpu));
    expect(utilBand(0)).toBe("idle");
    expect(utilBand(12)).toBe("ok");
    expect(utilBand(60)).toBe("busy");
    expect(utilBand(80)).toBe("hot");
    expect(utilBand(95)).toBe("full");
  });

  it("derives health from the explicit node state rather than diagnostic text", () => {
    const running = { ...node, state: "RUNNING", healthReport: "1/1 local-dirs usable" };
    const unhealthy = { ...node, state: "UNHEALTHY", healthReport: "" };
    const lost = { ...node, state: "LOST", healthReport: "" };
    expect(healthOf(running)).toBe("healthy");
    expect(healthOf(unhealthy)).toBe("unhealthy");
    expect(healthOf(lost)).toBe("unknown");
  });

  it("falls back to totalResource when used+avail are both zero (inactive node)", () => {
    expect(totalMemoryMB(node)).toBe((node.usedMemoryMB as number) + (node.availMemoryMB as number));
    expect(totalMemoryMB({ usedMemoryMB: 0, availMemoryMB: 0, totalResource: { memory: 8192, vCores: 8 } })).toBe(8192);
    expect(totalVCores({ usedVirtualCores: 0, availableVirtualCores: 0, totalResource: { memory: 8192, vCores: 8 } })).toBe(8);
  });

  it("summarises the cluster", () => {
    const s = summarize(nodes);
    expect(s.total).toBe(3);
    expect(s.running).toBe(3);
    expect(s.unhealthy).toBe(0);
    expect(s.memTotalMB).toBeGreaterThan(0);
    expect(s.vcoresTotal).toBe(12);
  });

  it("averages physical memory utilization across reporting active nodes", () => {
    expect(
      averageNodeMemoryUtilization([
        { state: "RUNNING", memUtilization: 60 },
        { state: "UNHEALTHY", memUtilization: 90 },
        { state: "LOST", memUtilization: 100 },
        { state: "RUNNING", memUtilization: null },
      ]),
    ).toEqual({ percent: 75, reportingNodes: 2 });
    expect(averageNodeMemoryUtilization([{ state: "RUNNING", memUtilization: null }])).toEqual({
      percent: null,
      reportingNodes: 0,
    });
  });

  it("includes unhealthy nodes in All and keeps state filters exact", () => {
    expect(countByTab(nodes, "ALL")).toBe(3);
    expect(countByTab(nodes, "RUNNING")).toBe(3);
    expect(countByTab(nodes, "LOST")).toBe(0);
    expect(inTab({ state: "UNHEALTHY" }, "ALL")).toBe(true);
    expect(countByTab([...nodes, { state: "UNHEALTHY" }], "ALL")).toBe(4);
    expect(inTab({ state: "UNHEALTHY" }, "UNHEALTHY")).toBe(true);
    expect(NODE_STATE_TABS.map((t) => t.id)).toContain("DECOMMISSIONING");
  });

  it("filters by label, rack and free text", () => {
    expect(nodes.filter((n) => matchesFilter(n, { label: "ssd" })).map((n) => n.id)).toEqual(["127.0.0.3:8041"]);
    expect(nodes.filter((n) => matchesFilter(n, { label: "(none)" })).map((n) => n.id)).toEqual(["127.0.0.4:8041"]);
    expect(nodes.filter((n) => matchesFilter(n, { rack: "/rack1" }))).toHaveLength(2);
    expect(nodes.filter((n) => matchesFilter(n, { rack: "/rack2" }))).toHaveLength(1);
    expect(nodes.filter((n) => matchesFilter(n, { q: "8041" }))).toHaveLength(3);
    expect(nodes.filter((n) => matchesFilter(n, { q: "nope" }))).toHaveLength(0);
  });

  it("groups by rack with a default rack fallback and shows allocation tags like legacy", () => {
    const groups = groupByRack(nodes);
    expect(groups.map((g) => g.rack)).toEqual(["/rack1", "/rack2"]);
    expect(groups[0]?.nodes.map((n) => n.id)).toEqual(["127.0.0.2:8041", "127.0.0.3:8041"]);
    expect(groups[1]?.nodes).toHaveLength(1);
    expect(rackOf({ rack: "" })).toBe("/default-rack");
    expect(
      allocationTagSummary({
        allocationTags: {
          allocationTagInfo: [
            { allocationTag: "a", allocationsCount: 2 },
            { allocationTag: "b", allocationsCount: 1 },
          ],
        },
      }),
    ).toBe("a(2),b(1)");
    expect(allocationTagSummary({ allocationTags: { allocationTagInfo: [] } })).toBe("");
  });

  it("joins every resource type into one total/used/available matrix", () => {
    const rows = resourceMatrix(node);
    expect(rows.map((r) => r.name)).toEqual(["memory-mb", "vcores"]);
    expect(rows[0]?.units).toBe("Mi");
    expect(rows[0]?.total).toBe(3072);
    expect(rows[0]?.used).toBe(0);
    expect(rows[0]?.available).toBe(3072);
    expect(rows[0]?.resourceType).toBe("COUNTABLE");

    const withGpu = resourceMatrix({
      totalResource: {
        memory: 1,
        vCores: 1,
        resourceInformations: {
          resourceInformation: [
            { name: "memory-mb", value: 8192, units: "Mi", resourceType: "COUNTABLE", tags: [] },
            { name: "yarn.io/gpu", value: 4, tags: [] },
          ],
        },
      },
      usedResource: { memory: 0, vCores: 0, resourceInformations: { resourceInformation: [{ name: "yarn.io/gpu", value: 3, tags: [] }] } },
      availableResource: {
        memory: 0,
        vCores: 0,
        resourceInformations: { resourceInformation: [{ name: "yarn.io/gpu", value: 1, tags: [] }] },
      },
    });
    expect(withGpu.map((r) => r.name)).toEqual(["memory-mb", "yarn.io/gpu"]);
    const gpu = withGpu[1];
    expect(gpu).toMatchObject({ total: 4, used: 3, available: 1, units: "", resourceType: "" });
    expect(withGpu[0]?.used).toBeUndefined();
  });

  it("derives the application id from a container id", () => {
    expect(appIdOfContainer("container_1767000000000_0001_01_000001")).toBe("application_1767000000000_0001");
    expect(appIdOfContainer("container_e17_1767000000000_0001_01_000001")).toBe("application_1767000000000_0001");
    expect(appIdOfContainer("container_123_456_garbage")).toBeNull();
    expect(appIdOfContainer("not-a-container")).toBeNull();
    expect(numOf(undefined)).toBe(0);
  });

  it("lists only non-memory/vcores resource types, in RM order", () => {
    // the live cluster configures only memory-mb/vcores -> the legacy custom columns are absent
    expect(customResourceNames(nodes)).toEqual([]);
    expect([...STANDARD_RESOURCE_TYPES]).toEqual(["memory-mb", "vcores"]);
    const info = (name: string, value: number) => ({ name, value, tags: [] });
    const gpuNode = {
      totalResource: {
        memory: 8192,
        vCores: 8,
        resourceInformations: { resourceInformation: [info("memory-mb", 8192), info("vcores", 8), info("yarn.io/gpu", 4)] },
      },
      usedResource: {
        memory: 0,
        vCores: 0,
        resourceInformations: { resourceInformation: [info("memory-mb", 0), info("vcores", 0), info("yarn.io/gpu", 3)] },
      },
      availableResource: {
        memory: 0,
        vCores: 0,
        resourceInformations: { resourceInformation: [info("memory-mb", 0), info("vcores", 0), info("yarn.io/gpu", 1)] },
      },
    };
    expect(customResourceNames([gpuNode])).toEqual(["yarn.io/gpu"]);
    expect(customResourceValue(gpuNode, "yarn.io/gpu", "used")).toBe(3);
    expect(customResourceValue(gpuNode, "yarn.io/gpu", "avail")).toBe(1);
    // Hadoop Resource.getResourceValue returns 0 for a type the node does not report
    expect(customResourceValue(gpuNode, "yarn.io/fpga", "used")).toBe(0);
    expect(customResourceValue({}, "yarn.io/gpu", "avail")).toBe(0);
  });
});

describe("label payloads (live capture)", () => {
  it("parses the declared labels with exclusivity and partition resources", () => {
    expect(labels.nodeLabelInfo.map((l) => l.name).sort()).toEqual(["gpu", "ssd"]);
    expect(labels.nodeLabelInfo.find((l) => l.name === "gpu")?.exclusivity).toBe(true);
    expect(labels.nodeLabelInfo.find((l) => l.name === "ssd")?.exclusivity).toBe(false);
    expect(labels.nodeLabelInfo[0]?.partitionInfo?.resourceAvailable?.memory).toBe(3072);
  });

  it("parses node→label and label→nodes mappings", () => {
    // nodeToLabels value is a NodeLabelsInfo ({nodeLabelInfo:[…]}), not a bare array (Jersey "mapped" notation).
    expect(nodeToLabels.nodeToLabels?.["127.0.0.3:8041"]?.nodeLabelInfo[0]?.name).toBe("ssd");
    const ssd = mappings.labelsToNodes?.entry.find((e) => e.key.name === "ssd");
    expect(ssd?.value.nodes).toContain("127.0.0.3:8041");
  });

  it("derives active NMs from the live node list and adds the DEFAULT partition", () => {
    const rows = buildLabelRows(labels.nodeLabelInfo, nodes);
    expect(rows[0]?.label.name).toBe(DEFAULT_LABEL);
    expect(rows[0]?.derived).toBe(true);
    expect(rows[0]?.activeNMs).toBe(1);
    expect(rows[0]?.label.exclusivity).toBe(true);
    expect(labelTypeText(rows[0]?.label.exclusivity ?? false)).toBe("Exclusive Partition");
    expect(labelNameText(rows[0]?.label.name ?? "x")).toBe("<DEFAULT_PARTITION>");
    const res = rows[0]?.label.partitionInfo?.resourceAvailable;
    expect(resourceText(res?.memory ?? 0, res?.vCores ?? 0)).toBe("<memory:3 GB, vCores:4>");
    const ssd = rows.find((r) => r.label.name === "ssd");
    expect(ssd?.activeNMs).toBe(1);
    expect(ssd?.nodes.map((n) => n.id)).toEqual(["127.0.0.3:8041"]);
    const gpu = rows.find((r) => r.label.name === "gpu");
    expect(gpu?.activeNMs).toBe(1);
    expect(gpu?.nodes.map((n) => n.id)).toEqual(["127.0.0.2:8041"]);
  });

  it("does not count inactive nodes as active members or default-partition capacity", () => {
    const inactive = { ...nodes[2]!, id: "lost:8041", state: "LOST" as const, usedMemoryMB: 0, availMemoryMB: 0 };
    const rows = buildLabelRows(labels.nodeLabelInfo, [...nodes, inactive]);
    expect(rows[0]?.activeNMs).toBe(1);
    expect(rows[0]?.nodes.map((n) => n.id)).not.toContain("lost:8041");
    const lostLabel = { ...inactive, nodeLabels: ["ssd"] };
    expect(buildLabelRows(labels.nodeLabelInfo, [lostLabel]).find((r) => r.label.name === "ssd")?.activeNMs).toBe(0);
  });

  it("does not duplicate an explicitly declared DEFAULT partition", () => {
    const rows = buildLabelRows([{ name: "", exclusivity: false }], nodes);
    expect(rows.filter((r) => r.label.name === DEFAULT_LABEL)).toHaveLength(1);
    expect(rows[0]?.derived).toBe(false);
  });
});

describe("NodeManager payloads (live capture)", () => {
  const nm4 = {
    containers: NmContainersResponseSchema.parse(fixture("nm-127.0.0.4_8042-containers.json")),
    apps: NmAppsResponseSchema.parse(fixture("nm-127.0.0.4_8042-apps.json")),
    info: NmInfoResponseSchema.parse(fixture("nm-127.0.0.4_8042-info.json")),
  };

  it("parses the NM container list — JAXB FIELD keys, not the DAO getters", () => {
    expect(nm4.containers).toHaveLength(4);
    const c = nm4.containers[0];
    expect(c?.id).toMatch(/^container_\d+_\d+_\d+_\d+$/);
    expect(c?.state).toBe("RUNNING");
    expect(c?.totalMemoryNeededMB).toBe(768);
    expect(c?.totalVCoresNeeded).toBe(1);
    expect(c?.containerLogsLink).toContain("/node/containerlogs/");
    expect(c?.containerLogFiles).toContain("stdout");
    expect(c?.exitCode).toBe(-1000);
    // the getter names must NOT be the wire keys (regression guard for the earlier schema mistake)
    expect(c).not.toHaveProperty("memoryNeeded");
    expect(c).not.toHaveProperty("logLink");
  });

  it("parses the NM app list and node info", () => {
    expect(nm4.apps.map((a) => a.id)).toEqual(["application_1791010984040_0014", "application_1791010984040_0001"]);
    expect(nm4.apps[1]?.containerids).toHaveLength(3);
    expect(nm4.info.nodeManagerVersion).toBe("3.4.3");
    expect(nm4.info.hadoopVersion).toBe("3.4.3");
    expect(nm4.info.nodeHealthy).toBe(true);
    expect(nm4.info.nodeManagerBuildVersion).toContain("3.4.3 from");
  });

  it('accepts an empty container list (`{"containers":{}}`, the live shape on an idle node)', () => {
    expect(NmContainersResponseSchema.parse(fixture("nm-127.0.0.2_8042-containers.json"))).toEqual([]);
  });
});
