// @vitest-environment node
/**
 * URL search codecs. Regression guard for a real bug found by the stacks page: TanStack `JSON.parse`s search values, so a
 * hand-typed `?thread=3` / `?q=42` / `?overridden=1` arrived as a number and the string-only codecs silently dropped the
 * filter (the router then canonicalised the URL without it).
 */
import { describe, expect, it } from "vitest";
import { flag, formatCols, formatSort, nodeLabelsSearchSchema, nodesSearchSchema, optStr, parseCols, parseSort } from "./search";

describe("search codecs", () => {
  it("keeps a numeric query value as a string instead of dropping it", () => {
    expect(optStr.parse("42")).toBe("42");
    expect(optStr.parse(42)).toBe("42");
    expect(optStr.parse(0)).toBe("0");
    expect(optStr.parse(undefined)).toBeUndefined();
  });

  it("understands the flag as a boolean, a number or the string forms", () => {
    expect(flag.parse(true)).toBe(true);
    expect(flag.parse(1)).toBe(true);
    expect(flag.parse("1")).toBe(true);
    expect(flag.parse("true")).toBe(true);
    expect(flag.parse(0)).toBe(false);
    expect(flag.parse("0")).toBe(false);
    expect(flag.parse("false")).toBe(false);
  });

  it("parses a full node search (URL values as the router delivers them)", () => {
    const parsed = nodesSearchSchema.parse({ state: "RUNNING", q: 42, rack: "/rack1", view: "heatmap", sort: "id:desc", overridden: 1 });
    expect(parsed).toMatchObject({ state: "RUNNING", q: "42", rack: "/rack1", view: "heatmap" });
    // unknown params (e.g. parity=1) are stripped, which the parity contract expects: parity is decided once per load
    expect(nodesSearchSchema.parse({ parity: "1" })).toEqual({});
    expect(nodesSearchSchema.parse({ state: "NOPE" }).state).toBeUndefined();
  });

  it("parses the labels search", () => {
    expect(nodeLabelsSearchSchema.parse({ open: "ssd", view: "mapping" })).toEqual({ open: "ssd", view: "mapping" });
  });
});

describe("sort and column codecs", () => {
  it("round-trips sorting and ignores malformed entries", () => {
    expect(parseSort("id:desc")).toEqual([{ id: "id", desc: true }]);
    expect(parseSort("state:asc,memUtilization:desc")).toEqual([
      { id: "state", desc: false },
      { id: "memUtilization", desc: true },
    ]);
    expect(parseSort("nonsense")).toEqual([]);
    expect(parseSort(undefined)).toEqual([]);
    expect(formatSort([{ id: "id", desc: true }])).toBe("id:desc");
    expect(formatSort([])).toBeUndefined();
  });

  it("round-trips column visibility", () => {
    expect(parseCols("id,rack")).toEqual({ id: true, rack: true });
    expect(parseCols(undefined)).toBeUndefined();
    expect(formatCols({ id: true, rack: false })).toBe("id");
    expect(formatCols({})).toBeUndefined();
  });
});
