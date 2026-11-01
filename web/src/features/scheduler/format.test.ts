import { describe, expect, it } from "vitest";
import {
  countText,
  deltaText,
  fmtMemory,
  fmtVcores,
  orderingPolicyDisplayName,
  partitionText,
  pctText,
  queueTitle,
  resourceText,
  resourceValueText,
  shareText,
  userWeightText,
} from "./format";

describe("scheduler operator text", () => {
  it("formats ResourceInfo as readable units and keeps custom resources", () => {
    expect(
      resourceText({
        memory: 1024,
        vCores: 1,
        resourceInformations: {
          resourceInformation: [
            { name: "memory-mb", value: 1024, tags: [] },
            { name: "vcores", value: 1, tags: [] },
            { name: "yarn.io/gpu", value: 2, units: "", tags: [] },
          ],
        },
      }),
    ).toBe("1 GiB · 1 vCore · yarn.io/gpu: 2");
  });

  it("uses a readable label for the default partition", () => {
    expect(partitionText("")).toBe("Default partition");
    expect(partitionText("<DEFAULT_PARTITION>")).toBe("Default partition");
    expect(partitionText("gpu")).toBe("gpu");
  });

  it("formats optional counts, percentages, resources, and user weights", () => {
    expect(fmtVcores(null)).toBe("—");
    expect(fmtVcores(Number.NaN)).toBe("—");
    expect(fmtVcores(2)).toBe("2 vCores");
    expect(fmtMemory(undefined)).toBe("—");
    expect(fmtMemory(Number.POSITIVE_INFINITY)).toBe("—");
    expect(countText(null)).toBe("—");
    expect(countText(1200)).toBe("1,200");
    expect(pctText(62.5)).toBe("62.5%");
    expect(pctText(1200)).toBe("1200%");
    expect(resourceText(null)).toBe("—");
    expect(
      resourceValueText(1024, 1, [
        { name: "yarn.io/gpu", value: 2, units: "cards" },
        { name: "zero", value: 0 },
        { name: "invalid", value: Number.NaN },
      ]),
    ).toBe("1 GiB · 1 vCore · yarn.io/gpu: 2 cards");
  });

  it("formats queue paths, shares, deltas, ordering policies, and weights", () => {
    expect(queueTitle("root.analytics.batch")).toBe("batch");
    expect(queueTitle("...")).toBe("...");
    expect(shareText(null)).toBe("—");
    expect(shareText(1024)).toBe("1 GiB");
    expect(deltaText(null)).toBe("—");
    expect(deltaText(512)).toBe("+512 MiB");
    expect(deltaText(-512)).toBe("−512 MiB");
    expect(orderingPolicyDisplayName(null)).toBeNull();
    expect(orderingPolicyDisplayName("")).toBeNull();
    expect(orderingPolicyDisplayName("fair")).toBe("FairOrderingPolicy");
    expect(orderingPolicyDisplayName("my.CustomPolicy")).toBe("my.CustomPolicy");
    expect(userWeightText(null)).toBe("—");
    expect(userWeightText(Number.NaN)).toBe("—");
    expect(userWeightText(1)).toBe("1.0");
    expect(userWeightText(0.5)).toBe("0.5");
  });
});
