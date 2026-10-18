/**
 * Unit tests for the JMX tree/format helpers, over the REAL captured `RM /jmx` payload (464 KB, 75 beans).
 *
 * The payload goes through the production `JmxResponseSchema` first — in vitest that runs in STRICT mode, so a bean shape
 * the UI cannot represent fails here. Counts are exact because they are the evidence the page is complete: every bean,
 * every attribute and every nested value must appear in the tree.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { JmxResponseSchema } from "~/api/schemas";
import {
  allExpandableIds,
  ancestorIds,
  attrFieldId,
  beanGroup,
  beanShort,
  buildJmxTree,
  findBeanNode,
  findValueNode,
  flattenJmxTree,
  fmtJmxNumber,
  highlightJmxText,
  jmxBranchSummary,
  jmxErrorBean,
  jmxMemoryShape,
  jmxNumberHint,
  jmxScalarText,
  jmxValueJson,
  jmxValueKind,
  jmxValueText,
  matchJmxTree,
  memoryPercent,
  memorySummary,
  parseObjectName,
  truncateMiddle,
} from "./jmx";

const jmxFixture: unknown = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/tools/jmx.json"), "utf8"));
const response = JmxResponseSchema.parse(jmxFixture);
const beans = response.beans;
const tree = buildJmxTree(beans);

describe("payload + tree shape", () => {
  it("parses the captured payload with the production schema", () => {
    expect(beans).toHaveLength(75);
    expect(beans.every((b) => typeof b.name === "string" && b.name.length > 0)).toBe(true);
    expect(beans.some((b) => b.modelerType === "sun.management.RuntimeImpl")).toBe(true);
  });

  it("indexes every bean, attribute and nested value", () => {
    expect(tree.beans).toBe(75);
    expect(tree.groups).toBe(25);
    expect(tree.attributes).toBe(2370); // 2445 keys - 75 `name` fields (the entity keys)
    expect(tree.values).toBe(7492); // scalar leaves (nulls included), `name` excluded
    expect(tree.nodes).toBe(9261); // groups + beans + every nested node
    expect(tree.byId.size).toBe(tree.nodes);
  });

  it("groups beans by the MBean name prefix before the first comma", () => {
    const rm = tree.roots.find((r) => r.label === "Hadoop:service=ResourceManager");
    expect(rm?.children).toHaveLength(51);
    expect(tree.roots.find((r) => r.label === "java.lang:type=Runtime")?.children).toHaveLength(1);
    for (const root of tree.roots) {
      expect(root.kind).toBe("group");
      expect(root.children.every((c) => c.kind === "bean" && c.parent === root)).toBe(true);
    }
  });

  it("builds the nested memory object as an object node with the four JVM keys", () => {
    const memory = findBeanNode(tree, "java.lang:type=Memory");
    const heap = memory?.children.find((c) => c.label === "HeapMemoryUsage");
    expect(heap?.kind).toBe("object");
    expect(heap?.children.map((c) => c.label)).toEqual(["committed", "init", "max", "used"]);
    expect(jmxMemoryShape(heap?.value)).not.toBeNull();
    expect(heap?.leaves).toBe(4);
  });

  it("keeps arrays as expandable nodes with indexed element paths", () => {
    const threading = findBeanNode(tree, "java.lang:type=Threading");
    const ids = threading?.children.find((c) => c.label === "AllThreadIds");
    expect(ids?.kind).toBe("array");
    expect(ids?.children[0]?.label).toBe("[0]");
    expect(ids?.children[0]?.path).toEqual(["AllThreadIds", "[0]"]);
    expect(ids?.children).toHaveLength(((ids?.value ?? []) as unknown[]).length);
    expect(findValueNode(tree, "java.lang:type=Threading", ["AllThreadIds", "[0]"])).toBe(ids?.children[0]);
  });

  it("refuses to invent a memory shape for anything else", () => {
    expect(jmxMemoryShape({ used: 1, committed: 2 })).toEqual({ used: 1, committed: 2 });
    expect(jmxMemoryShape({ used: 1, other: 2 })).toBeNull();
    expect(jmxMemoryShape([1, 2, 3])).toBeNull();
    expect(jmxMemoryShape(null)).toBeNull();
  });
});

describe("flattening", () => {
  it("shows the groups when nothing is expanded, then beans at depth 2", () => {
    const collapsed = flattenJmxTree(tree, { expanded: new Set() });
    expect(collapsed).toHaveLength(25);
    expect(collapsed.every((n) => n.kind === "group")).toBe(true);

    const groups = new Set(tree.roots.map((r) => r.id));
    const oneLevel = flattenJmxTree(tree, { expanded: groups });
    expect(oneLevel).toHaveLength(25 + 75);
    expect(oneLevel.filter((n) => n.depth === 1)).toHaveLength(75);
  });

  it("expands everything deterministically (parity mode / expand all)", () => {
    const all = flattenJmxTree(tree, { expanded: new Set(), all: true });
    expect(all).toHaveLength(tree.nodes);
    const seen = new Set<string>();
    for (const node of all) {
      if (node.parent) expect(seen.has(node.parent.id)).toBe(true);
      seen.add(node.id);
    }
    expect(allExpandableIds(tree)).toHaveLength(1768); // groups + beans + non-empty objects/arrays
  });

  it("never shows a child without its parent", () => {
    const expanded = new Set(tree.roots.map((r) => r.id));
    for (const node of flattenJmxTree(tree, { expanded })) {
      if (node.parent) expect(expanded.has(node.parent.id)).toBe(true);
    }
  });
});

describe("search", () => {
  it("does nothing for an empty query", () => {
    const match = matchJmxTree(tree, "   ");
    expect(match).toMatchObject({ active: false, count: 0 });
    expect(match.ids.size).toBe(0);
  });

  it("matches attribute paths, is case-insensitive and keeps the ancestors", () => {
    const match = matchJmxTree(tree, "heapmemoryusage");
    expect(match.active).toBe(true);
    expect(match.count).toBeGreaterThan(0);
    const memoryId = "b:java.lang:type=Memory";
    expect(match.ids.has(memoryId)).toBe(true);
    expect(match.expand.has(memoryId)).toBe(true);
    const rows = flattenJmxTree(tree, { expanded: new Set(), match });
    expect(rows.length).toBe(match.ids.size);
    expect(rows.map((r) => r.id)).toContain(memoryId);
  });

  it("matches raw values, not just keys", () => {
    const match = matchJmxTree(tree, "java.nio:type=BufferPool");
    expect(match.count).toBeGreaterThanOrEqual(3); // the ObjectName attributes of the three buffer pools
    const node = [...match.ids].map((id) => tree.byId.get(id)).find((n) => n?.kind === "value" && n.label === "ObjectName");
    expect(node?.value).toBe("java.nio:type=BufferPool,name=direct");
  });

  it("matches whole beans by name", () => {
    const match = matchJmxTree(tree, "JMImplementation");
    expect(match.ids.has("g:JMImplementation:type=MBeanServerDelegate")).toBe(true);
    expect(match.ids.has("b:JMImplementation:type=MBeanServerDelegate")).toBe(true);
    expect(match.count).toBe(1);
  });

  it("auto-expands the ancestors of a deep match", () => {
    const match = matchJmxTree(tree, "HeapMemoryUsage.max");
    const rows = flattenJmxTree(tree, { expanded: new Set(), match });
    const kinds = rows.map((r) => r.kind);
    expect(kinds[0]).toBe("group");
    expect(rows.some((r) => r.kind === "value" && r.path.join(".") === "HeapMemoryUsage.max")).toBe(true);
    const leaf = rows.find((r) => r.kind === "value" && r.path.join(".") === "HeapMemoryUsage.max");
    expect(leaf).toBeDefined();
    for (const id of ancestorIds(leaf as NonNullable<typeof leaf>)) expect(match.ids.has(id)).toBe(true);
  });
});

describe("formatting", () => {
  it("formats numbers with separators and keeps doubles meaningful", () => {
    expect(fmtJmxNumber(641693976)).toBe("641,693,976");
    expect(fmtJmxNumber(0)).toBe("0");
    expect(fmtJmxNumber(0.5)).toBe("0.5");
    expect(fmtJmxNumber(1234.5678)).toBe("1,234.5678");
  });

  it("renders scalars and branches", () => {
    expect(jmxScalarText(null)).toBe("—");
    expect(jmxScalarText(undefined)).toBe("—");
    expect(jmxScalarText(true)).toBe("true");
    expect(jmxScalarText(12)).toBe("12");
    expect(jmxScalarText("hi")).toBe("hi");
    expect(jmxBranchSummary("object", 4)).toBe("{4 keys}");
    expect(jmxBranchSummary("object", 1)).toBe("{1 key}");
    expect(jmxBranchSummary("object", 0)).toBe("{}");
    expect(jmxBranchSummary("array", 150)).toBe("[150 items]");
    expect(jmxBranchSummary("array", 0)).toBe("[]");
  });

  it("classifies values", () => {
    expect(jmxValueKind(null)).toBe("null");
    expect(jmxValueKind(true)).toBe("boolean");
    expect(jmxValueKind(1)).toBe("number");
    expect(jmxValueKind("x")).toBe("string");
    expect(jmxValueKind([])).toBe("array");
    expect(jmxValueKind({})).toBe("object");
  });

  it("stringifies values for search / copy", () => {
    expect(jmxValueText(null)).toBe("");
    expect(jmxValueText(3)).toBe("3");
    expect(jmxValueText({ a: 1 })).toBe('{"a":1}');
    expect(jmxValueJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(jmxValueJson(undefined)).toBe("");
  });

  it("adds a 1024-based hint for Bytes/Memory/Size names only", () => {
    expect(jmxNumberHint(["CommittedVirtualMemorySize"], 8 * 1024 * 1024 * 1024)).toEqual({ kind: "bytes", text: "8 GiB" });
    expect(jmxNumberHint(["HeapMemoryUsage", "used"], 1536)).toEqual({ kind: "bytes", text: "1.5 KiB" });
    expect(jmxNumberHint(["TotalThreadAllocatedBytes"], 641693976)).toEqual({ kind: "bytes", text: "612 MiB" });
    expect(jmxNumberHint(["Count"], 96)).toBeNull();
  });

  it("interprets Time/Millis names as epoch or duration", () => {
    const hint = jmxNumberHint(["StartTime"], 1791010984040);
    expect(hint?.kind).toBe("epoch");
    expect(hint?.text).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(jmxNumberHint(["LastGcMillis"], 4200)).toEqual({ kind: "duration", text: "4s" });
    expect(jmxNumberHint(["LastGcMillis"], 420)).toEqual({ kind: "duration", text: "420 ms" });
    expect(jmxNumberHint(["UptimeSeconds"], 4200)).toBeNull();
  });
  it("formats epoch hints in the selected timezone", () => {
    const startTime = Date.UTC(2026, 9, 3, 12, 4, 9);
    const local = new Date(startTime);
    const twoDigits = (n: number) => String(n).padStart(2, "0");
    const localText = [
      `${local.getFullYear()}-${twoDigits(local.getMonth() + 1)}-${twoDigits(local.getDate())}`,
      `${twoDigits(local.getHours())}:${twoDigits(local.getMinutes())}:${twoDigits(local.getSeconds())}`,
    ].join(" ");
    expect(jmxNumberHint(["StartTime"], startTime, "utc")).toEqual({ kind: "epoch", text: "2026-10-03 12:04:09" });
    expect(jmxNumberHint(["StartTime"], startTime, "local")).toEqual({ kind: "epoch", text: localText });
  });

  it("computes memory bars without dividing by the JVM's -1 max", () => {
    expect(memoryPercent({ used: 512, max: 1024 })).toBe(50);
    expect(memoryPercent({ used: 1024, committed: 2048, max: -1 })).toBe(50);
    expect(memoryPercent({ used: 5 })).toBe(0);
    expect(Number.isNaN(memoryPercent({ used: 5, max: 0 }))).toBe(false);
    expect(memorySummary({ used: 512, max: 1024 })).toBe("used 512 B of 1 KiB (50%)");
    expect(memorySummary({ used: 2, committed: 4 })).toBe("used 2 B of 4 B committed (50%)");
    expect(memorySummary({ used: 2 })).toBe("used 2 B");
  });

  it("splits text for highlighting, case-insensitively", () => {
    expect(highlightJmxText("HeapMemoryUsage", "memory")).toEqual([
      { text: "Heap", hit: false },
      { text: "Memory", hit: true },
      { text: "Usage", hit: false },
    ]);
    expect(highlightJmxText("abc", "")).toEqual([{ text: "abc", hit: false }]);
    expect(highlightJmxText("abc", "zz")).toEqual([{ text: "abc", hit: false }]);
    expect(highlightJmxText("aa", "a")).toEqual([
      { text: "a", hit: true },
      { text: "a", hit: true },
    ]);
  });

  it("truncates long strings in the middle", () => {
    expect(truncateMiddle("short", 20)).toBe("short");
    const long = "x".repeat(50);
    const out = truncateMiddle(long, 12);
    expect(out).toHaveLength(12);
    expect(out).toContain("…");
  });
});

describe("MBean names", () => {
  it("parses object names into domain + properties", () => {
    expect(parseObjectName("Hadoop:service=ResourceManager,name=QueueMetrics,q0=root")).toEqual({
      domain: "Hadoop",
      properties: [
        { key: "service", value: "ResourceManager" },
        { key: "name", value: "QueueMetrics" },
        { key: "q0", value: "root" },
      ],
    });
    expect(parseObjectName("no-colon-here")).toEqual({ domain: "no-colon-here", properties: [] });
    expect(parseObjectName("java.nio:name=mapped - 'non-volatile memory',type=BufferPool").properties[0]).toEqual({
      key: "name",
      value: "mapped - 'non-volatile memory'",
    });
  });

  it("exposes the group prefix and the compact remainder", () => {
    expect(beanGroup("Hadoop:service=ResourceManager,name=RpcActivityForPort8031")).toBe("Hadoop:service=ResourceManager");
    expect(beanShort("Hadoop:service=ResourceManager,name=RpcActivityForPort8031")).toBe("name=RpcActivityForPort8031");
    expect(beanGroup("solitary")).toBe("solitary");
  });

  it("stamps the documented JMX field-id grammar", () => {
    expect(attrFieldId(["HeapMemoryUsage", "used"])).toBe("jmx.HeapMemoryUsage.used");
    expect(attrFieldId(["AllThreadIds", "[3]"])).toBe("jmx.AllThreadIds.[3]");
  });

  it("recognises the daemon's pattern-error bean", () => {
    expect(jmxErrorBean({ name: "Nope:*", result: "ERROR", message: "No MBean matching Nope:*" })).toEqual({
      message: "No MBean matching Nope:*",
    });
    expect(jmxErrorBean({ name: "java.lang:type=Runtime" })).toBeNull();
  });
});
