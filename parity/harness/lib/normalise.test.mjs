import { describe, expect, it } from "bun:test";
import { parseResourceString } from "./normalise.mjs";

describe("resource-string normaliser", () => {
  it("treats unitless Hadoop memory as MiB", () => {
    expect(parseResourceString("<memory:2048, vCores:4>")).toBe("memory=2048;vcores=4");
  });

  it("converts explicit memory units to MiB", () => {
    expect(parseResourceString("<memory:2 GB, vCores:4>")).toBe("memory=2048;vcores=4");
  });

  it("uses the same MiB representation for REST resource objects", () => {
    expect(parseResourceString({ memory: 2048, vCores: 4 })).toBe("memory=2048;vcores=4");
  });
});
