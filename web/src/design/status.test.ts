import { describe, expect, it } from "vitest";
import { statusSpec } from "./status";

describe("status language fallbacks", () => {
  it("uses the base unknown label for missing states", () => {
    expect(statusSpec("app.state", null).label).toBe("Unknown");
    expect(statusSpec("app.state", undefined).label).toBe("Unknown");
  });

  it("gives unknown future states a neutral tone and readable label", () => {
    expect(statusSpec("app.state", "PAUSED_BY_FUTURE")).toMatchObject({
      label: "Paused by future",
      tone: "idle",
      shape: "dash",
      motion: "none",
    });
  });
});
