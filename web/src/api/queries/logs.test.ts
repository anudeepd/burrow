import { describe, expect, it } from "vitest";
import { ApiError } from "../client";
import { isLogEndpointMissing } from "./logs";

describe("isLogEndpointMissing", () => {
  it("recognizes a backend 404 without upstream provenance", () => {
    expect(isLogEndpointMissing(new ApiError("route not found", "http", 404))).toBe(true);
  });

  it("does not treat an upstream 404 as a missing Burrow route", () => {
    expect(isLogEndpointMissing(new ApiError("file not found", "http", 404, null, { url: "http://nm/logs", status: 404 }))).toBe(false);
    expect(
      isLogEndpointMissing(
        new ApiError("upstream returned 404", "http", 404, null, null, null, {
          api: null,
          cache: null,
          upstream: "http://nm/logs",
          ageMs: null,
          etag: null,
        }),
      ),
    ).toBe(false);
  });

  it("does not classify other failures as a missing route", () => {
    expect(isLogEndpointMissing(new ApiError("bad gateway", "http", 502))).toBe(false);
    expect(isLogEndpointMissing(new Error("network error"))).toBe(false);
  });
});
