import { describe, expect, it } from "vitest";
import { pressureTone, utilizationTone } from "./progress-tone";

describe("progress tones", () => {
  it("classifies every pressure and utilization band, including invalid readings", () => {
    expect(pressureTone(null)).toBe("idle");
    expect(pressureTone(Number.NaN)).toBe("idle");
    expect(pressureTone(151)).toBe("fail");
    expect(pressureTone(120)).toBe("warn");
    expect(pressureTone(85)).toBe("wait");
    expect(pressureTone(50)).toBe("live");
    expect(pressureTone(49)).toBe("ok");

    expect(utilizationTone(Number.POSITIVE_INFINITY)).toBe("idle");
    expect(utilizationTone(101)).toBe("fail");
    expect(utilizationTone(85)).toBe("warn");
    expect(utilizationTone(50)).toBe("live");
    expect(utilizationTone(49)).toBe("ok");
  });
});
