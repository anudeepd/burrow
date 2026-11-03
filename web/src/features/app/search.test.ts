import { describe, expect, it } from "vitest";
import { attemptsSearchSchema, parseSearch, sortingFromParam, sortingToParam, visibilityFromParam, visibilityToParam } from "./search";

const DEFAULTS = { appAttemptId: true, startTime: true, nodeHttpAddress: false };

describe("sorting codec", () => {
  it("round-trips a multi-column sort", () => {
    const sorting = [
      { id: "startTime", desc: true },
      { id: "appAttemptId", desc: false },
    ];
    expect(sortingToParam(sorting)).toBe("startTime:desc,appAttemptId:asc");
    expect(sortingFromParam("startTime:desc,appAttemptId:asc")).toEqual(sorting);
  });

  it("treats a missing direction as ascending and empty as unsorted", () => {
    expect(sortingFromParam("startTime")).toEqual([{ id: "startTime", desc: false }]);
    expect(sortingFromParam(undefined)).toEqual([]);
    expect(sortingToParam([])).toBeUndefined();
    expect(sortingFromParam(",,")).toEqual([]);
  });
});

describe("column visibility codec", () => {
  it("falls back to the defaults when the param is absent", () => {
    expect(visibilityFromParam(undefined, DEFAULTS)).toEqual(DEFAULTS);
  });

  it("supports the all/none shorthands", () => {
    expect(visibilityFromParam("all", DEFAULTS)).toEqual({ appAttemptId: true, startTime: true, nodeHttpAddress: true });
    expect(visibilityFromParam("none", DEFAULTS)).toEqual({ appAttemptId: false, startTime: false, nodeHttpAddress: false });
  });

  it("round-trips a non-default selection and omits the default and the extremes", () => {
    const v = { appAttemptId: true, startTime: true, nodeHttpAddress: true };
    expect(visibilityToParam(v, DEFAULTS)).toBe("all");

    const onlyId = { appAttemptId: true, startTime: false, nodeHttpAddress: false };
    expect(visibilityToParam(onlyId, DEFAULTS)).toBe("appAttemptId");
    expect(visibilityFromParam("appAttemptId", DEFAULTS)).toEqual(onlyId);

    expect(visibilityToParam(DEFAULTS, DEFAULTS)).toBeUndefined();
    expect(visibilityToParam({ appAttemptId: false, startTime: false, nodeHttpAddress: false }, DEFAULTS)).toBe("none");
    expect(
      visibilityToParam({ appAttemptId: true }, { appAttemptId: true, startTime: undefined, nodeHttpAddress: undefined }),
    ).toBeUndefined();
    expect(
      visibilityToParam(
        { appAttemptId: true, startTime: false, nodeHttpAddress: false },
        { appAttemptId: true, startTime: undefined, nodeHttpAddress: false },
      ),
    ).toBe("appAttemptId");
  });
});

describe("search validation", () => {
  it("validates known keys while preserving sibling query parameters", () => {
    expect(parseSearch(attemptsSearchSchema, { sort: "startTime:desc", parity: "1" })).toEqual({
      sort: "startTime:desc",
      parity: "1",
    });
  });

  it("rejects invalid known search values", () => {
    expect(() => parseSearch(attemptsSearchSchema, { cols: 5 })).toThrow();
  });
});
