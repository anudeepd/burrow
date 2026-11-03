// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isParity } from "~/state/parity";

describe("parity mode during server rendering", () => {
  it("stays disabled when there is no browser window", () => {
    expect(isParity()).toBe(false);
  });
});
