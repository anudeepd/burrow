// @vitest-environment node
import { describe, expect, it } from "vitest";
import { motionAllowed, prefersReducedMotion, tokenMs } from "~/lib/motion";

describe("motion policy without browser APIs", () => {
  it("disables motion and uses duration fallbacks during server rendering", () => {
    expect(prefersReducedMotion()).toBe(false);
    expect(motionAllowed()).toBe(false);
    expect(tokenMs(null, "--dur-content", 220)).toBe(220);
    expect(tokenMs({} as Element, "--dur-content", 220)).toBe(220);
  });
});
