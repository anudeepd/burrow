import { describe, expect, it } from "vitest";
import { AppsWindowResponseSchema, selectAppsWindow } from "~/api/schemas";
import apps from "~/api/schemas/samples/apps.json";

const meta = {
  offset: 100,
  limit: 200,
  total: 10_000,
  filteredTotal: 42,
  ready: true,
  partial: false,
  stale: false,
  version: 3,
  ageMs: 125,
  retryAfterMs: null,
  refreshError: null,
  facets: {
    total: 10_000,
    byState: { RUNNING: 5, FINISHED: 9_995 },
    byFinal: { UNDEFINED: 5, SUCCEEDED: 9_995 },
    active: 5,
    users: [{ value: "alice", count: 6_000 }],
    queues: [{ value: "root.default", count: 10_000 }],
    types: [{ value: "SPARK", count: 10_000 }],
    tags: [{ value: "etl", count: 4_000 }],
  },
};

describe("AppsWindowResponseSchema", () => {
  it("parses a complete window and preserves unknown app fields in loose mode", () => {
    const parsed = AppsWindowResponseSchema.parse({ ...apps, window: meta });
    expect(selectAppsWindow(parsed).length).toBeGreaterThan(0);
    expect(parsed.window?.filteredTotal).toBe(42);
  });

  it("accepts the preview shape and the legacy full-list fallback", () => {
    const preview = AppsWindowResponseSchema.parse({
      apps: { app: [] },
      window: { ...meta, total: null, ready: false, partial: true, version: 0, retryAfterMs: 500 },
    });
    expect(preview.window?.total).toBeNull();
    expect(preview.window?.partial).toBe(true);

    const fallback = AppsWindowResponseSchema.parse(apps);
    expect(fallback.window).toBeUndefined();
    expect(selectAppsWindow(fallback).length).toBeGreaterThan(0);
    expect(selectAppsWindow(AppsWindowResponseSchema.parse({ apps: null }))).toEqual([]);
  });

  it("rejects an unknown window field in strict schema mode", () => {
    expect(() => AppsWindowResponseSchema.parse({ ...apps, window: { ...meta, unexpected: true } })).toThrow();
  });
});
