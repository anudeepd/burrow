import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { connectionStore, parseBurrowHeaders, recordFailure, recordSuccess, useConnection } from "./connection";

const initial = connectionStore.get();

afterEach(() => connectionStore.setState(() => initial));

describe("API connection state", () => {
  it("parses absent, invalid, and numeric age headers", () => {
    expect(parseBurrowHeaders(new Headers()).ageMs).toBeNull();
    expect(parseBurrowHeaders(new Headers({ "x-burrow-age": "unknown" })).ageMs).toBeNull();
    expect(parseBurrowHeaders(new Headers({ "x-burrow-age": "42" })).ageMs).toBe(42);
  });

  it("publishes successful and failed request state to subscribers", () => {
    const { result } = renderHook(() => useConnection((state) => state));
    act(() => recordSuccess({ api: "v1", cache: "hit", upstream: "rm", ageMs: 5, etag: "tag" }));
    expect(result.current).toMatchObject({ consecutiveFailures: 0, lastCache: "hit", lastUpstream: "rm" });
    act(() => recordFailure("offline"));
    expect(result.current).toMatchObject({ consecutiveFailures: 1, lastError: "offline" });
  });
});
