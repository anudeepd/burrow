// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createQueryClient } from "./query-client";
import { ApiError } from "./client";
import { parityStore } from "~/state/parity";

describe("createQueryClient during server rendering", () => {
  it("does not keep the prerender process alive for query garbage collection", () => {
    const client = createQueryClient();

    expect(client.getDefaultOptions().queries?.gcTime).toBe(Number.POSITIVE_INFINITY);
    const retry = client.getDefaultOptions().queries?.retry;
    expect(typeof retry).toBe("function");
    if (typeof retry === "function") {
      expect(retry(0, new ApiError("missing", "http", 404))).toBe(false);
      expect(retry(0, new ApiError("schema", "schema", null))).toBe(false);
      expect(retry(0, new ApiError("aborted", "abort", null))).toBe(false);
      expect(retry(0, new ApiError("server error", "http", 500))).toBe(true);
      expect(retry(0, new Error("network error"))).toBe(true);
      expect(retry(2, new Error("retry cap"))).toBe(false);
    }
    const retryDelay = client.getDefaultOptions().queries?.retryDelay;
    if (typeof retryDelay === "function") {
      expect(retryDelay(0, new Error("retry"))).toBe(1000);
      expect(retryDelay(9, new Error("retry cap"))).toBe(4000);
    }
    expect(client.getDefaultOptions().queries?.refetchOnReconnect).toBe(true);
    parityStore.setState(() => ({ enabled: true }));
    expect(createQueryClient().getDefaultOptions().queries?.refetchOnReconnect).toBe(false);
    parityStore.setState(() => ({ enabled: false }));
  });
});
