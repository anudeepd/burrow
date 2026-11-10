// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ApiError } from "~/api/client";
import { errorInfo, useRemote } from "./hooks";

describe("scheduler remote query helpers", () => {
  it("maps empty, ordinary, schema, unreachable, and upstream errors to useful states", () => {
    expect(errorInfo(null)).toEqual({ title: "Something went wrong", message: "No error detail was provided." });

    const ordinary = errorInfo(new Error("offline"));
    expect(ordinary).toMatchObject({ title: "Request failed", message: "offline" });
    expect(ordinary.detail).toContain('"name": "Error"');

    const schema = errorInfo(new ApiError("bad shape", "schema", 200, null, null, "Check the daemon version."));
    expect(schema).toMatchObject({
      title: "Unexpected response shape",
      message: "bad shape",
      hint: "Check the daemon version.",
    });
    expect(schema.detail).toContain('"kind": "schema"');

    const network = errorInfo(new ApiError("offline", "network", null));
    expect(network).toMatchObject({ title: "Cannot reach the ResourceManager", message: "offline" });
    expect(network.detail).toContain('"kind": "network"');

    const rejected = errorInfo(new ApiError("rejected", "http", 400, null, { url: "/api/yarn/scheduler" }, null));
    expect(rejected).toMatchObject({ title: "The ResourceManager returned an error", message: "rejected" });
    expect(rejected.detail).toContain('"url": "/api/yarn/scheduler"');

    const upstream = errorInfo(
      new ApiError("upstream unavailable", "http", 502, null, { url: "/api/yarn/scheduler", status: 503 }, "Retry"),
    );
    expect(upstream).toMatchObject({ title: "Cannot reach the ResourceManager", message: "upstream unavailable", hint: "Retry" });
    expect(upstream.detail).toContain('"url": "/api/yarn/scheduler"');
    expect(upstream.detail).toContain('"status": 503');
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
