/**
 * Legacy-exact derivations the Scheduler page prints (CapacitySchedulerPage.java) — the texts the parity gate compares:
 * `FifoOrderingPolicy`, `1.0`, `<memory:1536, vCores:1>`, `Partition: <DEFAULT_PARTITION> <memory:3072, vCores:4>`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NodesResponseSchema, SchedulerResponseSchema } from "~/api/schemas";
import type { ResourceInfo } from "~/api/schemas";
import { orderingPolicyDisplayName, userWeightText } from "./format";
import { buildTree, findQueue } from "./model";
import { partitionUiTag } from "./NodeLabelsCard";
import { scaleResource, userRows } from "./UserTable";

const fixture = (rel: string): unknown => JSON.parse(readFileSync(`../fixtures/rm/${rel}`, "utf8"));
const root = () => buildTree(SchedulerResponseSchema.parse(fixture("scheduler/capacity/scheduler.json")).scheduler.schedulerInfo)!;

describe("ordering policy display name (getInfo)", () => {
  it("maps each built-in config name to its policy's getInfo()", () => {
    expect(orderingPolicyDisplayName("fifo")).toBe("FifoOrderingPolicy");
    expect(orderingPolicyDisplayName("fair")).toBe("FairOrderingPolicy");
    expect(orderingPolicyDisplayName("fifo-with-partitions")).toBe("FifoOrderingPolicyWithExclusivePartitions");
    expect(orderingPolicyDisplayName("fifo-for-pending-apps")).toBe("FifoOrderingPolicyForPendingApps");
  });

  it("keeps an unknown (custom class) policy name and reports absence as null", () => {
    expect(orderingPolicyDisplayName("com.example.MyPolicy")).toBe("com.example.MyPolicy");
    expect(orderingPolicyDisplayName(undefined)).toBeNull();
    expect(orderingPolicyDisplayName("")).toBeNull();
  });
});

describe("user weight text (String.valueOf(float))", () => {
  it("always carries a decimal point", () => {
    expect(userWeightText(1)).toBe("1.0");
    expect(userWeightText(2)).toBe("2.0");
    expect(userWeightText(0.5)).toBe("0.5");
    expect(userWeightText(undefined)).toBe("—");
  });
});

describe("queue user rows", () => {
  const r = (memory: number, vCores: number): ResourceInfo => ({ memory, vCores });

  it("Max AM Resource is the queue's partition userAmLimit, not the user's own entry", () => {
    const rows = userRows("root.default", findQueue(root(), "root.default")!.capacity);
    expect(rows.map((x) => x.user.username).sort()).toEqual(["alice", "carol"]);
    for (const row of rows) expect(row.maxAm).toEqual({ memory: 1536, vCores: 1, customs: [] });
  });

  it("falls back to the queue amLimit when it has no userAmLimit", () => {
    const raw = {
      resources: { resourceUsagesByPartition: [{ partitionName: "", amLimit: r(1024, 1) }] },
      users: { user: [{ username: "u", numPendingApplications: 0, numActiveApplications: 1, userWeight: 1 }] },
    };
    const [row] = userRows("root.q", raw as never);
    expect(row?.maxAm).toEqual({ memory: 1024, vCores: 1, customs: [] });
  });

  it("multiplies by the user weight with Java's (long) truncation, and only when the weight is not 1.0", () => {
    expect(scaleResource(r(1536, 3), 0.5)).toEqual({ memory: 768, vCores: 1, customs: [] });
    expect(scaleResource(r(1000, 1), 1.5)).toEqual({ memory: 1500, vCores: 1, customs: [] });
    const raw = {
      resources: { resourceUsagesByPartition: [{ partitionName: "", userAmLimit: r(1536, 1) }] },
      users: { user: [{ username: "w", numPendingApplications: 0, numActiveApplications: 1, userWeight: 2 }] },
    };
    expect(userRows("root.q", raw as never)[0]?.maxAm).toEqual({ memory: 3072, vCores: 2, customs: [] });
  });

  it("a missing AMResourceUsed prints as Resources.none()", () => {
    const raw = { users: { user: [{ username: "n", numPendingApplications: 0, numActiveApplications: 0 }] } };
    expect(userRows("root.q", raw as never)[0]?.amUsed).toEqual({ memory: 0, vCores: 0 });
  });

  it("uses partition-scoped usage instead of aggregate resourcesUsed", () => {
    const raw = {
      resources: {
        resourceUsagesByPartition: [
          { partitionName: "", userAmLimit: r(1, 1) },
          { partitionName: "ssd", userAmLimit: r(512, 1) },
        ],
      },
      users: {
        user: [
          {
            username: "a",
            numPendingApplications: 0,
            numActiveApplications: 1,
            userWeight: 1,
            resourcesUsed: r(2304, 3),
            resources: {
              resourceUsagesByPartition: [
                { partitionName: "", used: r(0, 0) },
                { partitionName: "ssd", used: r(256, 1) },
              ],
            },
          },
        ],
      },
    };
    const [row] = userRows("root.q", raw as never, "ssd");
    expect(row?.used).toEqual(r(256, 1));
    expect(row?.maxAm).toEqual({ memory: 512, vCores: 1, customs: [] });
    expect(userRows("root.q", raw as never)[0]?.used).toEqual(r(0, 0));
    // no entry for the partition => the stock UI prints zero (live: alice under gpu is `<memory:0, vCores:0>`)
    expect(userRows("root.q", raw as never, "gpu")[0]?.used).toEqual(r(0, 0));
  });

  it("falls back to aggregate usage only when partition usage is not exposed", () => {
    const raw = {
      users: { user: [{ username: "a", resourcesUsed: r(512, 1), numPendingApplications: 0, numActiveApplications: 1 }] },
    };
    expect(userRows("root.q", raw as never)[0]?.used).toEqual(r(512, 1));
    expect(userRows("root.q", raw as never, "ssd")[0]?.used).toEqual(r(0, 0));
  });
});

describe("partition tag (QueuesBlock)", () => {
  const nodes = NodesResponseSchema.parse(fixture("nodes/nodes.json")).nodes?.node ?? [];

  it("the default partition is the unlabelled nodes' total, printed as Resource.toString()", () => {
    const unlabelled = nodes.filter((n) => !n.nodeLabels?.length);
    expect(partitionUiTag("", unlabelled)).toBe("Partition: <DEFAULT_PARTITION> <memory:3072, vCores:4>");
  });

  it("a named label sums its own nodes", () => {
    const gpu = nodes.filter((n) => n.nodeLabels?.includes("gpu"));
    expect(partitionUiTag("gpu", gpu)).toBe("Partition: gpu <memory:3072, vCores:4>");
    expect(partitionUiTag("gpu", [...gpu, ...gpu])).toBe("Partition: gpu <memory:6144, vCores:8>");
  });
});
