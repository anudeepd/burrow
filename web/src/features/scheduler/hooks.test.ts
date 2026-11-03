// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ApiError } from "~/api/client";
import { errorInfo, useRemote } from "./hooks";

describe("scheduler remote query helpers", () => {
  it("maps empty, ordinary, schema, unreachable, and upstream errors to useful states", () => {
    expect(errorInfo(null)).toEqual({ title: "Something went wrong", message: "No error detail was provided." });
    expect(errorInfo(new Error("offline"))).toEqual({ title: "Request failed", message: "offline" });
    expect(errorInfo(new ApiError("bad shape", "schema", 200, null, null, "Check the daemon version."))).toEqual({
      title: "Unexpected response shape",
      message: "bad shape",
      hint: "Check the daemon version.",
      detail: undefined,
    });
    expect(errorInfo(new ApiError("offline", "network", null))).toEqual({
      title: "Cannot reach the ResourceManager",
      message: "offline",
      hint: undefined,
      detail: undefined,
    });
    expect(errorInfo(new ApiError("rejected", "http", 400, null, { url: "/api/yarn/scheduler" }, null))).toEqual({
      title: "The ResourceManager returned an error",
      message: "rejected",
      hint: undefined,
      detail: "/api/yarn/scheduler",
    });
    expect(
      errorInfo(new ApiError("upstream unavailable", "http", 502, null, { url: "/api/yarn/scheduler", status: 503 }, "Retry")),
    ).toEqual({
      title: "Cannot reach the ResourceManager",
      message: "upstream unavailable",
      hint: "Retry",
      detail: "/api/yarn/scheduler → HTTP 503",
    });
  });

  it("exposes query data, loading/fetching, stale status, and retry", () => {
    let retries = 0;
    const remote = useRemote({
      data: { name: "root" },
      isPending: false,
      isFetching: true,
      error: new Error("refresh failed"),
      refetch: () => {
        retries += 1;
        return Promise.resolve({} as never);
      },
    } as never);

    expect(remote).toMatchObject({
      data: { name: "root" },
      loading: false,
      fetching: true,
      stale: true,
      error: { message: "refresh failed" },
    });
    remote.retry();
    expect(retries).toBe(1);

    const initial = useRemote({
      data: undefined,
      isPending: true,
      isFetching: true,
      error: undefined,
      refetch: () => Promise.resolve({} as never),
    } as never);
    expect(initial).toMatchObject({ data: undefined, loading: true, fetching: true, error: null, stale: false });
  });
});
