import { describe, expect, it } from "vitest";
import { fmtBytes, fmtDuration, fmtEpoch, fmtInt, fmtMB, fmtPct, fmtRelative, formatByTag, rawString } from "~/lib/format";

describe("formatters", () => {
  it("formats integers with a fixed locale", () => {
    expect(fmtInt(1234567)).toBe("1,234,567");
    expect(fmtInt(0)).toBe("0");
    expect(fmtInt(null)).toBe("—");
    expect(fmtInt(Number.NaN)).toBe("—");
  });

  it("formats percentages and treats negatives as missing", () => {
    expect(fmtPct(12.345)).toBe("12.3%");
    expect(fmtPct(12.345, 2)).toBe("12.35%");
    expect(fmtPct(-1)).toBe("—");
    expect(fmtPct(null)).toBe("—");
  });

  it("formats bytes and YARN megabytes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1536)).toBe("1.5 KiB");
    expect(fmtMB(2048)).toBe("2 GiB");
    expect(fmtMB(512)).toBe("512 MiB");
  });

  it("formats durations the way operators read them", () => {
    expect(fmtDuration(340)).toBe("340 ms");
    expect(fmtDuration(1000)).toBe("1s");
    expect(fmtDuration(3_725_000)).toBe("1h 2m 5s");
    expect(fmtDuration(90_000)).toBe("1m 30s");
    expect(fmtDuration(-1)).toBe("—");
  });

  it("formats epochs in the requested zone and hides the 'not yet' sentinel", () => {
    const ms = Date.UTC(2026, 9, 3, 12, 4, 9);
    expect(fmtEpoch(ms, "utc")).toBe("2026-10-03 12:04:09");
    expect(fmtEpoch(0)).toBe("—");
    expect(fmtEpoch(-1)).toBe("—");
    expect(fmtEpoch(null)).toBe("—");
  });

  it("formats relative times", () => {
    expect(fmtRelative(1000, 1500)).toBe("just now");
    expect(fmtRelative(0, 5000)).toBe("5s ago");
    expect(fmtRelative(0, 120_000)).toBe("2m ago");
    expect(fmtRelative(0, 7_200_000)).toBe("2h ago");
  });

  it("stringifies raw values exactly as JSON would (data-yv)", () => {
    expect(rawString(null)).toBe("");
    expect(rawString(undefined)).toBe("");
    expect(rawString("RUNNING")).toBe("RUNNING");
    expect(rawString(0)).toBe("0");
    expect(rawString(-1)).toBe("-1");
    expect(rawString(false)).toBe("false");
    expect(rawString(1767225600000)).toBe("1767225600000");
    expect(rawString({ a: 1 })).toBe('{"a":1}');
  });

  it("maps format tags to the visible text only", () => {
    expect(formatByTag("int", "42")).toBe("42");
    expect(formatByTag("pct", 0.5)).toBe("0.5%");
    expect(formatByTag("epoch", 0)).toBe("—");
    expect(formatByTag("text", "NEW")).toBe("NEW");
    expect(formatByTag("int", null)).toBe("—");
  });
});
