/**
 * Tests for the segment merger: ANSI styling and search highlights must compose without dropping or duplicating text.
 */
import { describe, expect, it } from "vitest";
import { splitSegments } from "./segments";
import { stripAnsi } from "./model";

const textOf = (segs: { text: string }[]) => segs.map((s) => s.text).join("");

describe("splitSegments", () => {
  it("returns one plain run when there is no ANSI and no match", () => {
    const segs = splitSegments("hello world", []);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ text: "hello world", hit: null });
  });

  it("marks a match inside plain text", () => {
    const segs = splitSegments("an ERROR here", [{ start: 3, end: 8, global: 0 }]);
    expect(segs.map((s) => s.text)).toEqual(["an ", "ERROR", " here"]);
    expect(segs[1]!.hit).toBe(0);
    expect(segs[0]!.hit).toBeNull();
  });

  it("keeps ANSI styling and a highlight on the same run", () => {
    const line = "\u001b[31mERROR\u001b[0m boom";
    const segs = splitSegments(line, [{ start: 0, end: 5, global: 0 }]);
    // visible text is preserved exactly
    expect(textOf(segs)).toBe(stripAnsi(line));
    const hit = segs.find((s) => s.hit === 0);
    expect(hit?.text).toBe("ERROR");
    // the hit run also carries the red foreground class from the ANSI parser
    expect(hit?.cls ?? "").toContain("text-");
  });

  it("splits a match that spans two styled runs", () => {
    const line = "\u001b[31mfoo\u001b[32mbar\u001b[0m";
    const segs = splitSegments(line, [{ start: 2, end: 5, global: 3 }]);
    expect(textOf(segs)).toBe("foobar");
    expect(segs.filter((s) => s.hit === 3).map((s) => s.text)).toEqual(["o", "ba"]);
  });

  it("handles multiple matches on one line", () => {
    const segs = splitSegments("aXaXa", [
      { start: 1, end: 2, global: 0 },
      { start: 3, end: 4, global: 1 },
    ]);
    expect(textOf(segs)).toBe("aXaXa");
    expect(segs.filter((s) => s.hit != null).map((s) => s.hit)).toEqual([0, 1]);
  });
});
