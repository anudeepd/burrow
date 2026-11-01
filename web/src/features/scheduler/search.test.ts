// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  hideFromVisibility,
  parseOpenQueues,
  parseSorting,
  queueSearchSchema,
  schedulerSearchSchema,
  serializeOpenQueues,
  serializeSorting,
  visibilityFromHide,
} from "./search";

describe("scheduler URL state", () => {
  it("accepts known tabs and drops invalid enum values", () => {
    expect(schedulerSearchSchema.parse({ tab: "health", basis: "capacity", sort: "free" })).toMatchObject({
      tab: "health",
      basis: "capacity",
      sort: "free",
    });
    expect(schedulerSearchSchema.parse({ tab: "applications", basis: "bad", sort: "bad" })).toMatchObject({});
    expect(queueSearchSchema.parse({ tab: "apps", confAll: "true", groupBy: "DIAGNOSTIC" })).toMatchObject({
      tab: "apps",
      confAll: true,
      groupBy: "DIAGNOSTIC",
    });
    expect(queueSearchSchema.parse({ tab: "applications", confAll: "invalid", groupBy: "bad" })).toMatchObject({});
  });

  it("parses and serializes multi-column sorting", () => {
    expect(parseSorting(undefined)).toEqual([]);
    expect(parseSorting("name:desc,, :asc, used:asc, free")).toEqual([
      { id: "name", desc: true },
      { id: "used", desc: false },
      { id: "free", desc: false },
    ]);
    expect(serializeSorting([])).toBeUndefined();
    expect(
      serializeSorting([
        { id: "name", desc: true },
        { id: "used", desc: false },
      ]),
    ).toBe("name:desc,used:asc");
  });

  it("converts between hidden columns and table visibility states", () => {
    const defaults = { queue: true, users: false };
    expect(visibilityFromHide(undefined, defaults)).toBe(defaults);
    expect(visibilityFromHide("queue,,users", defaults)).toEqual({ queue: false, users: false });
    expect(visibilityFromHide("", defaults)).toEqual({});
    expect(hideFromVisibility({})).toBe("");
    expect(hideFromVisibility({ queue: true, users: false, apps: false })).toBe("users,apps");
    expect(hideFromVisibility({ queue: true })).toBe("");
  });

  it("preserves an absent open-queue override and serializes explicit tree state", () => {
    expect(parseOpenQueues(undefined)).toBeNull();
    expect(parseOpenQueues("root,,root.etl")).toEqual(["root", "root.etl"]);
    expect(parseOpenQueues("")).toEqual([]);
    expect(serializeOpenQueues([])).toBe("");
    expect(serializeOpenQueues(["root", "root.etl"])).toBe("root,root.etl");
  });
});
