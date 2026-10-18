/**
 * Unit tests for the ANSI SGR parser. The important guarantees are: style is applied where it is asked for, and *nothing is
 * ever dropped* — a truncated escape at a chunk boundary, a non-SGR CSI, or an OSC title all survive as text.
 */
import { describe, expect, it } from "vitest";
import { parseAnsi, segmentAnsi } from "./Ansi";

const ESC = "\u001b";
const plain = (spans: readonly { text: string }[]) => spans.map((s) => s.text).join("");

describe("parseAnsi", () => {
  it("returns the text unchanged when there is nothing to style", () => {
    expect(parseAnsi("plain log line\n")).toEqual([{ text: "plain log line\n" }]);
    expect(parseAnsi("")).toEqual([]);
  });

  it("applies foreground colours and resets on 0", () => {
    expect(parseAnsi(`a${ESC}[31mb${ESC}[0mc`)).toEqual([{ text: "a" }, { text: "b", fg: 31 }, { text: "c" }]);
    expect(parseAnsi(`${ESC}[32mgreen${ESC}[0m`)).toEqual([{ text: "green", fg: 32 }]);
  });

  it("handles the bright foreground range 90–97", () => {
    expect(parseAnsi(`${ESC}[91mred${ESC}[97mwhite${ESC}[0m`)).toEqual([
      { text: "red", fg: 91 },
      { text: "white", fg: 97 },
    ]);
  });

  it("handles bold, dim and 22 (back to normal intensity)", () => {
    expect(parseAnsi(`${ESC}[1mbold${ESC}[2mdim${ESC}[22mplain${ESC}[0m`)).toEqual([
      { text: "bold", bold: true },
      { text: "dim", bold: true, dim: true },
      { text: "plain" },
    ]);
  });

  it("handles multi-parameter sequences", () => {
    expect(parseAnsi(`${ESC}[1;31mboth${ESC}[0m`)).toEqual([{ text: "both", bold: true, fg: 31 }]);
    expect(parseAnsi(`${ESC}[;34mblue${ESC}[0m`)).toEqual([{ text: "blue", fg: 34 }]);
  });

  it("resets only the foreground on 39", () => {
    expect(parseAnsi(`${ESC}[1;31mx${ESC}[39my`)).toEqual([
      { text: "x", bold: true, fg: 31 },
      { text: "y", bold: true },
    ]);
  });

  it("consumes 256-colour and truecolour without inventing a colour", () => {
    expect(parseAnsi(`${ESC}[38;5;196mx${ESC}[0m`)).toEqual([{ text: "x" }]);
    expect(parseAnsi(`${ESC}[38;2;10;20;30mx${ESC}[0m`)).toEqual([{ text: "x" }]);
    // …and the surrounding colour is untouched by the ignored one
    expect(parseAnsi(`${ESC}[33m${ESC}[38;5;9my${ESC}[0m`)).toEqual([{ text: "y", fg: 33 }]);
  });

  it("ignores background codes but keeps the text", () => {
    expect(parseAnsi(`${ESC}[41mx${ESC}[49m${ESC}[100my${ESC}[0m`)).toEqual([{ text: "xy" }]);
  });

  it("keeps a truncated escape at a chunk boundary verbatim", () => {
    const truncated = `2026-10-03 12:00:00 INFO x${ESC}[3`;
    const spans = parseAnsi(truncated);
    expect(plain(spans)).toBe(truncated);
  });

  it("keeps unknown, non-SGR escapes verbatim", () => {
    const withCsi = `${ESC}[2Jclear${ESC}[?25lh`;
    const withOsc = `${ESC}]0;title\u0007text`;
    expect(plain(parseAnsi(withCsi))).toBe(withCsi);
    expect(plain(parseAnsi(withOsc))).toBe(withOsc);
  });

  it("merges runs that carry the same style", () => {
    expect(parseAnsi(`a${ESC}[31mb${ESC}[31mc`)).toEqual([{ text: "a" }, { text: "bc", fg: 31 }]);
  });

  it("only ever removes SGR sequences — never a byte of text", () => {
    const mixed = `start${ESC}[1;32m ok ${ESC}[0m mid ${ESC}[38;5;12m256${ESC}[2J tail`;
    expect(plain(parseAnsi(mixed))).toBe(`start ok  mid 256${ESC}[2J tail`);
  });

  it("handles a plain daemon log sample without inventing a style", () => {
    const text = "2026-10-13 20:00:14,000 INFO org.example.ResourceManager: Started\n";
    const spans = parseAnsi(text);
    expect(spans).toEqual([{ text }]);
    expect(text.includes(ESC)).toBe(false);
  });
});

describe("segmentAnsi", () => {
  const spans = [{ text: "ERROR one\nerror two\n" }, { text: "ERROR three", fg: 31 }];

  it("numbers case-insensitive, non-overlapping hits across styled runs", () => {
    const { segments, hits } = segmentAnsi(spans, "error");
    expect(hits).toBe(3);
    expect(segments.filter((s) => s.hit !== null).map((s) => s.hit)).toEqual([0, 1, 2]);
    expect(segments.filter((s) => s.hit !== null).map((s) => s.text)).toEqual(["ERROR", "error", "ERROR"]);
    // the matched run keeps its style, so the viewer can render the colour and the mark together
    expect(segments.find((s) => s.hit === 2)?.fg).toBe(31);
  });

  it("returns the whole window with no hits for an empty query", () => {
    const { segments, hits } = segmentAnsi(spans, "   ");
    expect(hits).toBe(0);
    expect(segments.map((s) => s.text).join("")).toBe("ERROR one\nerror two\nERROR three");
    expect(segments.every((s) => s.hit === null)).toBe(true);
  });

  it("preserves every character when a query matches nothing", () => {
    const { segments, hits } = segmentAnsi(spans, "zzz");
    expect(hits).toBe(0);
    expect(segments.map((s) => s.text).join("")).toBe("ERROR one\nerror two\nERROR three");
  });

  it('does not overlap: "aaa" contains one "aa"', () => {
    expect(segmentAnsi([{ text: "aaa" }], "aa").hits).toBe(1);
    expect(segmentAnsi([{ text: "aaaa" }], "aa").hits).toBe(2);
  });
});
