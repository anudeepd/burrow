// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createQueryClient } from "./query-client";

describe("createQueryClient during server rendering", () => {
  it("does not keep the prerender process alive for query garbage collection", () => {
    const client = createQueryClient();

    expect(client.getDefaultOptions().queries?.gcTime).toBe(Number.POSITIVE_INFINITY);
  });
});
