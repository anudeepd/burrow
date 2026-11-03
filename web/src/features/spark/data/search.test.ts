import { describe, expect, it } from "vitest";
import {
  boolParam,
  compact,
  intParam,
  matchesQuery,
  parseColumns,
  parseSort,
  serializeColumns,
  serializeSort,
  sparkSearch,
  strParam,
} from "./search";

describe("Spark URL search helpers", () => {
  it("parses a single sort and clears invalid or absent sort values", () => {
    expect(parseSort({ sort: "duration" })).toEqual([{ id: "duration", desc: false }]);
    expect(parseSort({ sort: "duration", dir: "desc" })).toEqual([{ id: "duration", desc: true }]);
    expect(parseSort({ sort: "", dir: "desc" })).toEqual([]);
    expect(parseSort({ sort: 12, dir: "desc" })).toEqual([]);
  });

  it("serializes only the first sort and clears sort parameters when empty", () => {
    expect(serializeSort([])).toEqual({ sort: undefined, dir: undefined });
    expect(
      serializeSort([
        { id: "name", desc: true },
        { id: "ignored", desc: false },
      ]),
    ).toEqual({
      sort: "name",
      dir: "desc",
    });
    expect(serializeSort([{ id: 7, desc: false }])).toEqual({ sort: "7", dir: "asc" });
  });

  it("parses and serializes visible and explicitly hidden columns", () => {
    expect(parseColumns({ cols: "name, -error,, status " })).toEqual({ name: true, error: false, status: true });
    expect(parseColumns({ cols: "" })).toEqual({});
    expect(parseColumns({ cols: 12 })).toEqual({});
    expect(serializeColumns({ error: false, name: true, ignored: undefined })).toEqual({ cols: "-error,name" });
    expect(serializeColumns({})).toEqual({ cols: undefined });
  });

  it("copies only non-empty string and numeric whitelisted search values", () => {
    expect(sparkSearch({ attempt: "2", page: 0, q: "", all: true, unlisted: "ignored" })).toEqual({
      attempt: "2",
      page: "0",
    });
  });

  it("compacts empty values while preserving meaningful falsy numbers", () => {
    expect(compact({ missing: undefined, nil: null, empty: "", no: false, zero: 0, yes: true })).toEqual({ zero: 0, yes: true });
  });

  it("parses integer, string, and boolean query parameters defensively", () => {
    expect(intParam(undefined, 4)).toBe(4);
    expect(intParam(null)).toBeUndefined();
    expect(intParam("", 5)).toBe(5);
    expect(intParam("4.9")).toBe(4);
    expect(intParam(2.8)).toBe(2);
    expect(intParam("not-a-number", 6)).toBe(6);
    expect(intParam(Number.POSITIVE_INFINITY, 7)).toBe(7);

    expect(strParam("value")).toBe("value");
    expect(strParam(2)).toBeUndefined();
    expect(strParam("")).toBeUndefined();

    expect(["1", "true", true].map(boolParam)).toEqual([true, true, true]);
    expect(["0", "false", false].map(boolParam)).toEqual([false, false, false]);
    expect(boolParam("yes")).toBeUndefined();
  });

  it("matches case-insensitively and skips null fields", () => {
    expect(matchesQuery([null, undefined, "Executor Failed"], "failed")).toBe(true);
    expect(matchesQuery([null, 42], "42")).toBe(true);
    expect(matchesQuery([null, undefined], "missing")).toBe(false);
    expect(matchesQuery([], "")).toBe(true);
  });
});
