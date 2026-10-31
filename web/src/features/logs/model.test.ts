/**
 * Unit tests for the container-log line model. Everything here is pure: no DOM, no network. The cases that matter are
 * the ones a viewer gets wrong silently — byte offsets after a reconnect, dedupe overlap, ring-buffer trimming, and
 * matching in the coordinate space the user actually sees.
 */
import { describe, expect, it } from "vitest";
import {
  LineBuffer,
  byteRangeLabel,
  compileSearch,
  detectLevel,
  detectTimestamp,
  findMatches,
  firstErrorLine,
  hasAnsi,
  isBadRegex,
  levelPasses,
  matchesByLine,
  parseLevelFilter,
  parseWindowHeaders,
  relativeMs,
  relativeTimestampMs,
  scanMatchesAsync,
  sliceBytes,
  sourceLabel,
  stepMatch,
  stripAnsi,
  utf8Len,
} from "./model";
import type { TimestampReference } from "./model";

describe("utf8Len", () => {
  it("counts ASCII, 2-, 3- and 4-byte code points", () => {
    expect(utf8Len("abc")).toBe(3);
    expect(utf8Len("é")).toBe(2); // U+00E9
    expect(utf8Len("→")).toBe(3); // U+2192
    expect(utf8Len("😀")).toBe(4); // surrogate pair
    expect(utf8Len("a😀b")).toBe(6);
    expect(utf8Len("")).toBe(0);
  });
});

describe("sliceBytes", () => {
  it("drops an ASCII overlap exactly", () => {
    expect(sliceBytes("hello world", 6)).toBe("world");
  });
  it("drops a multi-byte overlap without splitting a code point", () => {
    // "é" is 2 bytes; dropping 3 bytes must remove "aé" and nothing partial
    expect(sliceBytes("aé→", 3)).toBe("→");
  });
  it("rounds a mid-code-point budget down to a whole character", () => {
    // "😀" is 4 bytes; asking for 2 must yield "" rather than a lone surrogate
    expect(sliceBytes("😀x", 0, 2)).toBe("");
    expect(sliceBytes("😀x", 0, 4)).toBe("😀");
  });

  it("supports a finite byte window and empty overlap", () => {
    expect(sliceBytes("aé😀z", 1, 6)).toBe("é😀");
    expect(sliceBytes("abc", 3)).toBe("");
  });
});

describe("ANSI", () => {
  it("detects and strips SGR while leaving other escapes literal", () => {
    expect(hasAnsi("plain")).toBe(false);
    expect(hasAnsi("\u001b[31mred\u001b[0m")).toBe(true);
    expect(stripAnsi("\u001b[31mred\u001b[0m!")).toBe("red!");
    // a non-SGR escape is not SGR: it stays visible (nothing is silently dropped)
    expect(stripAnsi("a\u001b[2Kb")).toBe("a\u001b[2Kb");
  });
});

describe("detectLevel", () => {
  it("finds the log4j level token", () => {
    expect(detectLevel("2026-10-03 12:00:00,123 INFO [main] org.Foo - hi")).toBe("INFO");
    expect(detectLevel("26/10/03 12:00:00 WARN Util: message")).toBe("WARN");
  });
  it("collapses aliases onto the six canonical levels", () => {
    expect(detectLevel("WARNING: deprecated")).toBe("WARN");
    expect(detectLevel("SEVERE: boom")).toBe("ERROR");
    expect(detectLevel("FINE: trace-ish")).toBe("DEBUG");
  });
  it("ignores a level token buried in the payload", () => {
    const long = `${"x".repeat(200)} ERROR`;
    expect(detectLevel(long)).toBeNull();
  });
  it("returns null when there is no level", () => {
    expect(detectLevel("\tat java.lang.Thread.run(Thread.java:840)")).toBeNull();
  });
});

describe("parseLevelFilter / levelPasses", () => {
  it("parses the URL filter", () => {
    expect(parseLevelFilter(undefined)).toBeNull();
    expect(parseLevelFilter("all")).toBeNull();
    expect(parseLevelFilter("warn")).toBe("WARN");
    expect(parseLevelFilter("WARN+")).toBe("WARN");
    expect(parseLevelFilter("nonsense")).toBeNull();
  });
  it("keeps unlevelled lines regardless of the filter", () => {
    expect(levelPasses(null, "ERROR")).toBe(true);
    expect(levelPasses("INFO", "WARN")).toBe(false);
    expect(levelPasses("ERROR", "WARN")).toBe(true);
    expect(levelPasses("INFO", null)).toBe(true);
  });
});

describe("timestamps", () => {
  it("parses an ISO-ish stamp to an epoch", () => {
    const t = detectTimestamp("2026-10-03 12:34:56,789 INFO x");
    expect(t?.timeOnly).toBe(false);
    expect(t?.epoch).toBe(Date.UTC(2026, 9, 3, 12, 34, 56, 789));
  });
  it("parses Hadoop's log4j `yy/MM/dd HH:mm:ss` pattern", () => {
    const t = detectTimestamp("26/10/03 13:39:14 WARN NativeCodeLoader: …");
    expect(t?.timeOnly).toBe(false);
    expect(t?.epoch).toBe(Date.UTC(2026, 9, 3, 13, 39, 14));
  });
  it("parses a time-only stamp without inventing a date", () => {
    const t = detectTimestamp("12:34:56.7 INFO x");
    expect(t?.timeOnly).toBe(true);
    expect(t?.epoch).toBeNull();
    expect(t?.msOfDay).toBe(((12 * 60 + 34) * 60 + 56) * 1000 + 700);
  });
  it("returns null for an unstamped line", () => {
    expect(detectTimestamp("\tat Foo.bar(Foo.java:1)")).toBeNull();
  });
  it("unwraps midnight in relative deltas", () => {
    expect(relativeMs(1000, 23 * 3600 * 1000)).toBe(1000 - 23 * 3600 * 1000 + 24 * 3600 * 1000);
    expect(relativeMs(5000, 4000)).toBe(1000);
    expect(relativeMs(5000, null)).toBeNull();
    expect(relativeMs(23 * 3600 * 1000, 1000)).toBe(-3600 * 1000 - 1000);
  });
  it("computes elapsed time for full date stamps and clock-only stamps", () => {
    const dated = detectTimestamp("2026-10-03 12:00:00.000 INFO x")!;
    const earlierDated = detectTimestamp("2026-10-03 11:59:58.500 INFO x")!;
    const clock = detectTimestamp("00:00:01.000 INFO x")!;
    expect(relativeTimestampMs(dated, `epoch:${earlierDated.epoch!}`)).toBe(1_500);
    expect(relativeTimestampMs(clock, "clock:86399000")).toBe(2_000);
    expect(relativeTimestampMs(dated, "clock:10500")).toBeNull();
    expect(relativeTimestampMs(dated, null)).toBeNull();
    expect(relativeTimestampMs(dated, "epoch:not-a-number" as TimestampReference)).toBeNull();
    expect(relativeTimestampMs(clock, "epoch:0")).toBeNull();
  });
});

describe("search", () => {
  it("escapes literal queries and honours the case toggle", () => {
    expect(findMatches(["a.b", "axb"], { query: "a.b", regex: false, caseSensitive: false })).toEqual([{ line: 0, start: 0, end: 3 }]);
    expect(findMatches(["Error", "error"], { query: "error", regex: false, caseSensitive: true })).toEqual([{ line: 1, start: 0, end: 5 }]);
  });
  it("supports regex", () => {
    const m = findMatches(["id=42", "id=abc"], { query: String.raw`id=\d+`, regex: true, caseSensitive: false });
    expect(m).toEqual([{ line: 0, start: 0, end: 5 }]);
  });
  it("flags a bad regex instead of silently matching nothing", () => {
    expect(isBadRegex({ query: "(", regex: true, caseSensitive: false })).toBe(true);
    expect(compileSearch({ query: "(", regex: true, caseSensitive: false })).toBeNull();
    expect(isBadRegex({ query: "hit", regex: true, caseSensitive: false })).toBe(false);
    expect(isBadRegex({ query: "", regex: true, caseSensitive: false })).toBe(false);
    expect(isBadRegex({ query: "(", regex: false, caseSensitive: false })).toBe(false);
  });
  it("matches in the visible (ANSI-stripped) coordinate space", () => {
    const m = findMatches(["\u001b[31mERROR\u001b[0m boom"], { query: "boom", regex: false, caseSensitive: false });
    expect(m).toEqual([{ line: 0, start: 6, end: 10 }]);
  });
  it("does not spin on zero-length matches", () => {
    const m = findMatches(["abc"], { query: "^", regex: true, caseSensitive: false });
    expect(m.length).toBe(1);
  });
  it("caps the result set", () => {
    const lines = Array.from({ length: 100 }, () => "x");
    expect(findMatches(lines, { query: "x", regex: false, caseSensitive: false }, 10)).toHaveLength(10);
    expect(findMatches(["", "hit"], { query: "hit", regex: false, caseSensitive: false })).toEqual([{ line: 1, start: 0, end: 3 }]);
  });
  it("groups by line and steps with wrap-around", () => {
    const matches = findMatches(["a a", "b a"], { query: "a", regex: false, caseSensitive: false });
    expect(matchesByLine(matches).get(0)).toHaveLength(2);
    expect(stepMatch(matches, -1, 1)).toBe(0);
    expect(stepMatch(matches, 2, 1)).toBe(0);
    expect(stepMatch(matches, 0, -1)).toBe(2);
    expect(stepMatch([], 0, 1)).toBe(-1);
  });
  it("finds the first error line", () => {
    const lines = ["INFO ok", "WARN hmm", "ERROR bad", "ERROR worse"];
    expect(firstErrorLine(lines)).toBe(2);
    expect(firstErrorLine(["INFO a", "DEBUG b"])).toBeNull();
    expect(firstErrorLine(lines, "WARN")).toBe(1);
  });
  it("scans asynchronously in batches and can be cancelled", async () => {
    const lines = Array.from({ length: 60_000 }, (_, i) => (i % 1000 === 0 ? "hit" : "miss"));
    const progress: number[] = [];
    const scan = scanMatchesAsync(
      lines,
      { query: "hit", regex: false, caseSensitive: false },
      {
        batch: 10_000,
        onProgress: (_found, scanned) => progress.push(scanned),
      },
    );
    const out = await scan.promise;
    expect(out).toHaveLength(60);
    expect(progress.length).toBeGreaterThan(1);
    const cancelled = scanMatchesAsync(lines, { query: "hit", regex: false, caseSensitive: false }, { batch: 10_000 });
    cancelled.cancel();
    await expect(cancelled.promise).resolves.toHaveLength(0);
  });

  it("stops at its async cap and reports the final partial batch", async () => {
    const progress: Array<[number, number]> = [];
    const scan = scanMatchesAsync(["xx", "x", "x"], { query: "x", regex: false, caseSensitive: false }, {
      cap: 2,
      batch: 10,
      onProgress: (found, scanned) => progress.push([found, scanned]),
    });
    await expect(scan.promise).resolves.toHaveLength(2);
    expect(progress).toEqual([[2, 1]]);
    await expect(scanMatchesAsync(["x"], { query: "", regex: false, caseSensitive: false }).promise).resolves.toEqual([]);
  });
});

describe("LineBuffer offset math", () => {
  it("records consecutive starts/ends and the resume offset", () => {
    const b = new LineBuffer();
    b.setWindow("aa\nbbb\ncc\n", 0);
    expect(b.length).toBe(3);
    expect([b.start(0), b.end(0)]).toEqual([0, 2]);
    expect([b.start(1), b.end(1)]).toEqual([3, 6]);
    expect([b.start(2), b.end(2)]).toEqual([7, 9]);
    expect(b.totalBytes).toBe(10);
    expect(b.resumeOffset).toBe(10);
    expect(b.headPartial).toBe(false);
  });

  it("counts bytes, not characters, for multi-byte text", () => {
    const b = new LineBuffer();
    b.setWindow("é\n😀x\n", 0);
    expect(b.length).toBe(2);
    expect(b.end(0)).toBe(2); // "é" = 2 bytes
    expect(b.start(1)).toBe(3); // + newline
    expect(b.end(1)).toBe(8); // "😀x" = 5 bytes
    expect(b.totalBytes).toBe(9);
  });

  it("marks the first line partial when the window starts mid-line", () => {
    const b = new LineBuffer();
    b.setWindow("tail-of-line\nnext\n", 100);
    expect(b.headPartial).toBe(true);
    expect(b.start(0)).toBe(100);
  });

  it("holds a trailing partial line until the newline arrives", () => {
    const b = new LineBuffer();
    b.setWindow("done\npart", 0);
    expect(b.length).toBe(1);
    expect(b.resumeOffset).toBe(9); // 5 + 4
    b.append("ial\n", 9);
    expect(b.length).toBe(2);
    expect(b.line(1)).toBe("partial");
    expect(b.totalBytes).toBe(13); // "done\n" (5) + "partial\n" (8)
  });

  it("strips a CR from CRLF and counts both bytes", () => {
    const b = new LineBuffer();
    b.setWindow("a\r\nb\r\n", 0);
    expect(b.line(0)).toBe("a");
    expect(b.line(1)).toBe("b");
    expect(b.totalBytes).toBe(6);
  });

  it("dedupes an overlap after a reconnect", () => {
    const b = new LineBuffer();
    b.setWindow("alpha\nbeta\n", 0);
    const resume = b.resumeOffset; // 11
    // the stream reconnects 5 bytes earlier than our watermark
    b.append("beta\ngamma\n", resume - 5);
    expect(b.length).toBe(3);
    expect(b.line(2)).toBe("gamma");
    expect(b.gaps).toHaveLength(0);
    expect(b.totalBytes).toBe(resume + "gamma\n".length);
  });

  it("records a gap when the stream resumes past what we hold", () => {
    const b = new LineBuffer();
    b.setWindow("one\n", 0);
    b.append("two\n", 10); // bytes 4..9 never arrived
    expect(b.gaps).toEqual([{ from: 4, to: 10 }]);
    expect(b.line(1)).toBe("two");
  });

  it("flushes the pending line at EOF", () => {
    const b = new LineBuffer();
    b.setWindow("complete\ncut", 0);
    b.markEnded();
    expect(b.length).toBe(2);
    expect(b.line(1)).toBe("cut");
    expect(b.ended).toBe(true);
    // late chunks after EOF are ignored
    b.append("more\n", b.resumeOffset);
    expect(b.length).toBe(2);
    b.markEnded(); // EOF is idempotent
  });

  it("replaces its window when a head-aligned chunk arrives", () => {
    const b = new LineBuffer();
    b.setWindow("old\n", 0);
    const generation = b.generation;
    b.append("new\n", 100, { headAligned: true });
    expect(b.generation).toBe(generation + 1);
    expect(b.toLines()).toEqual(["new"]);
    expect(b.firstByte).toBe(100);
  });

  it("flushes a partial line before a gap and ignores a fully overlapped chunk", () => {
    const b = new LineBuffer();
    b.setWindow("one\npart", 0);
    const before = b.version;
    b.append("old", 0); // all bytes are older than the current watermark
    expect(b.version).toBeGreaterThan(before);
    expect(b.line(0)).toBe("one");
    b.append("next\n", 20);
    expect(b.line(1)).toBe("part");
    expect(b.line(2)).toBe("next");
    expect(b.gaps).toEqual([{ from: 8, to: 20 }]);
  });

  it("drops the synthetic empty prefix when a byte window begins at a line-ending newline", () => {
    const b = new LineBuffer();
    b.setWindow("\nreal\n\n", 10);
    expect(b.toLines()).toEqual(["real", ""]);
    expect(b.headPartial).toBe(true);
  });

  it("trims to the ring-buffer cap and keeps accessors relative", () => {
    const b = new LineBuffer(100);
    for (let i = 0; i < 250; i++) b.append(`line-${i}\n`, b.resumeOffset);
    expect(b.length).toBeLessThanOrEqual(100);
    expect(b.dropped).toBeGreaterThan(0);
    // the newest line is always the last one
    expect(b.line(b.length - 1)).toBe("line-249");
    // retained starts remain monotonic and consistent
    for (let i = 1; i < b.length; i++) expect(b.start(i)).toBeGreaterThan(b.start(i - 1));
    expect(b.totalBytes).toBe(b.end(b.length - 1) + 1);
  });

  it("compacts old ring-buffer storage and copies text within a byte budget", () => {
    const b = new LineBuffer(10);
    for (let i = 0; i < 120; i++) b.append(`line-${i}\n`, b.resumeOffset);
    expect(b.length).toBeLessThanOrEqual(10);
    expect(b.toLines()).toEqual(Array.from({ length: b.length }, (_, i) => `line-${110 + i}`));
    expect(b.fullText(8)).toContain("line-");

    const bytes = new LineBuffer();
    bytes.setWindow("é\nb\nc\n", 0);
    expect(bytes.fullText()).toBe("é\nb\nc");
    expect(bytes.fullText(2)).toBe("é");
  });

  it("bumps the version on every mutation", () => {
    const b = new LineBuffer();
    const v0 = b.version;
    b.setWindow("a\n", 0);
    const v1 = b.version;
    expect(v1).toBeGreaterThan(v0);
    b.append("b\n", b.resumeOffset);
    expect(b.version).toBeGreaterThan(v1);
  });

  it("resets cleanly", () => {
    const b = new LineBuffer();
    b.setWindow("a\nb\n", 0);
    b.reset();
    expect(b.length).toBe(0);
    expect(b.totalBytes).toBe(0);
    expect(b.dropped).toBe(0);
    expect(b.gaps).toHaveLength(0);
  });
});

describe("window headers and labels", () => {
  it("reads x-burrow-log-* and falls back to the requested range", () => {
    const h = new Headers({
      "x-burrow-log-size": "1000",
      "x-burrow-log-start": "100",
      "x-burrow-log-end": "200",
      "x-burrow-log-source": "nm",
    });
    expect(parseWindowHeaders(h, { offset: 0, length: 50 }, 0)).toEqual({ size: 1000, start: 100, end: 200, source: "nm" });
    const bare = new Headers();
    expect(parseWindowHeaders(bare, { offset: 10, length: 40 }, 99)).toEqual({ size: 99, start: 10, end: 50, source: null });
    const invalid = new Headers({ "x-burrow-log-size": "NaN", "x-burrow-log-start": "Infinity" });
    expect(parseWindowHeaders(invalid, { offset: 4, length: 8 }, 100)).toEqual({ size: 100, start: 4, end: 12, source: null });
  });
  it("labels the source", () => {
    expect(sourceLabel("nm")).toBe("NodeManager");
    expect(sourceLabel("jhs")).toBe("JobHistory");
    expect(sourceLabel("ats")).toBe("ATS");
    expect(sourceLabel(null)).toBe("unknown");
  });
  it("prints an inclusive byte range", () => {
    expect(byteRangeLabel(0, 131072, 222179)).toContain("bytes 0–131,071 of 222,179");
    expect(byteRangeLabel(4, 4, 4)).toContain("bytes 4–4 of 4 · 0 B");
    expect(byteRangeLabel(0, 1_572_864, 2_000_000)).toContain("1.5 MiB");
  });
});
