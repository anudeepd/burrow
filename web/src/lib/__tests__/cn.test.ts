import { describe, expect, it } from "vitest";
import { cn } from "~/lib/cn";

describe("class names", () => {
  it("merges custom text sizes without dropping text colors", () => {
    expect(cn("text-on-live", "text-small")).toBe("text-on-live text-small");
    expect(cn("text-body", "text-small")).toBe("text-small");
  });

  it("joins conditional class values and resolves conflicting utilities", () => {
    expect(cn("p-2", false && "p-4", ["px-4", { hidden: true }])).toBe("p-2 px-4 hidden");
  });
});
