import { describe, expect, it } from "vitest";
import { partitionText, resourceText } from "./format";

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
});
