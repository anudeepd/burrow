import { describe, expect, it } from "vitest";
import { createQueryClient } from "./query-client";

describe("createQueryClient in the browser", () => {
  it("uses the finite query cache lifetime", () => {
    expect(createQueryClient().getDefaultOptions().queries?.gcTime).toBe(5 * 60_000);
  });
});
