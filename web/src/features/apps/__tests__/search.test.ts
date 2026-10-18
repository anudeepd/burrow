import { describe, expect, it } from "vitest";
import {
  APP_TABS,
  colsToParam,
  DEFAULT_SORT,
  filterCount,
  hiddenFromParam,
  parseStates,
  sortFromParam,
  sortToParam,
  tabOf,
  visibilityOf,
  withPatch,
  appsSearchSchema,
} from "~/features/apps/search";

const parse = (input: unknown) => appsSearchSchema.parse(input);

describe("apps search codec", () => {
  it("accepts an empty search (a bare /apps visit)", () => {
    expect(parse({})).toEqual({});
    expect(tabOf(undefined)).toBe("all");
    expect(parseStates(undefined)).toEqual([]);
  });

  it("coerces numbers that arrive as strings (URL params are strings)", () => {
    expect(parse({ startedAfter: "1767225600000" }).startedAfter).toBe(1767225600000);
    expect(parse({ startedAfter: 1767225600000 }).startedAfter).toBe(1767225600000);
  });

  it("drops invalid values instead of throwing (a broken URL must still render)", () => {
    expect(parse({ startedAfter: "yesterday" }).startedAfter).toBeUndefined();
    expect(parse({ startedAfter: -5 }).startedAfter).toBeUndefined();
    expect(parse({ user: "" }).user).toBeUndefined();
    expect(parse({ states: 123 }).states).toBeUndefined();
  });

  it("parses the states param: upper-cased, deduped, unknown dropped, ALL ignored", () => {
    expect(parseStates("running,FAILED")).toEqual(["RUNNING", "FAILED"]);
    expect(parseStates("RUNNING,running")).toEqual(["RUNNING"]);
    expect(parseStates("ALL")).toEqual([]);
    expect(parseStates("NOPE,RUNNING")).toEqual(["RUNNING"]);
    expect(parseStates("  ")).toEqual([]);
  });

  it("maps states to the legacy tab set", () => {
    expect(APP_TABS.map((t) => t.id)).toEqual([
      "all",
      "pending",
      "active",
      "completed",
      "NEW",
      "NEW_SAVING",
      "SUBMITTED",
      "ACCEPTED",
      "RUNNING",
      "FINISHED",
      "FAILED",
      "KILLED",
    ]);
    expect(tabOf("RUNNING")).toBe("RUNNING");
    expect(tabOf("NEW,NEW_SAVING,SUBMITTED,ACCEPTED")).toBe("pending");
    expect(tabOf("NEW,NEW_SAVING,SUBMITTED,ACCEPTED,RUNNING")).toBe("active");
    expect(tabOf("FINISHED,FAILED,KILLED")).toBe("completed");
    expect(tabOf("NEW,RUNNING")).toBe("all");
    expect(tabOf(undefined)).toBe("all");
  });

  it("merges patches and strips empty values so the URL stays minimal", () => {
    const base = parse({ states: "RUNNING", user: "alice" });
    expect(withPatch(base, { user: undefined })).toEqual({ states: "RUNNING" });
    expect(withPatch(base, { queue: "root.prod" })).toEqual({ states: "RUNNING", user: "alice", queue: "root.prod" });
    expect(withPatch(base, { name: "" })).toEqual({ states: "RUNNING", user: "alice" });
  });

  it("counts active filters", () => {
    expect(filterCount(parse({}))).toBe(0);
    expect(filterCount(parse({ states: "RUNNING", user: "alice", name: "spark" }))).toBe(3);
  });

  it("round-trips sort", () => {
    expect(sortFromParam(undefined)).toEqual([{ id: "id", desc: true }]);
    expect(sortFromParam(DEFAULT_SORT)).toEqual([{ id: "id", desc: true }]);
    expect(sortFromParam("startedTime")).toEqual([{ id: "startedTime", desc: false }]);
    expect(sortFromParam("-allocatedMB")).toEqual([{ id: "allocatedMB", desc: true }]);
    expect(sortToParam([{ id: "id", desc: true }])).toBeUndefined();
    expect(sortToParam([{ id: "startedTime", desc: false }])).toBe("startedTime");
    expect(sortToParam([{ id: "allocatedMB", desc: true }])).toBe("-allocatedMB");
    expect(sortToParam([])).toBeUndefined();
  });

  it("round-trips a multi-column sort in order", () => {
    const multi = [
      { id: "name", desc: false },
      { id: "user", desc: true },
      { id: "startedTime", desc: false },
    ];
    expect(sortToParam(multi)).toBe("name,-user,startedTime");
    expect(sortFromParam("name,-user,startedTime")).toEqual(multi);
    // the default stays absent from the URL, whether it is the only sort or the first of several
    expect(sortFromParam("-id,user")).toEqual([
      { id: "id", desc: true },
      { id: "user", desc: false },
    ]);
    // junk tokens are dropped rather than turning into columns
    expect(sortFromParam("name,, - ")).toEqual([{ id: "name", desc: false }]);
  });

  it("round-trips hidden and all-visible columns", () => {
    expect(hiddenFromParam(undefined).size).toBe(0);
    expect([...hiddenFromParam("queue,ui")]).toEqual(["queue", "ui"]);
    const hidden = visibilityOf(["id", "user", "queue"], new Set(["queue"]));
    expect(hidden).toEqual({ id: true, user: true, queue: false });
    expect(colsToParam(hidden)).toBe("queue");
    const allVisible = visibilityOf(["id", "user"], hiddenFromParam("all"));
    expect(allVisible).toEqual({ id: true, user: true });
    expect(colsToParam(allVisible)).toBe("all");
  });
});
