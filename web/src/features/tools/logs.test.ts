/**
 * Unit tests for the log-viewer helpers, using the captured listing metadata from
 * `fixtures/rm/tools/logs.json`. The daemon log itself is local-only and is not needed for paging math.
 *
 * The paging tests are the ones that matter: a byte-addressed viewer that skips or double-reads a byte range is unusable for
 * reading a stack trace out of order, so coverage of `[0, size)` is asserted exactly.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "~/api/client";
import { RmLogsSchema } from "~/api/queries/tools";
import type { LogFileEntry } from "~/api/queries/tools";
import {
  LOG_PAGE_BYTES,
  byteRangeLabel,
  fetchLogChunk,
  isEndpointMissing,
  lastPageOffset,
  logFileHref,
  logFilePath,
  logPage,
  parseLogWindow,
  sortLogFiles,
} from "./logs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/rm/tools");
const readFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const RM_LOG_BYTES = 348_349;

const entry = (over: Partial<LogFileEntry> & { name: string }): LogFileEntry => ({
  size: 0,
  lastModified: null,
  modifiedText: null,
  modifiedSortKey: null,
  isDir: false,
  ...over,
});

describe("the captured log directory", () => {
  it("parses both files with their sizes and the daemon's verbatim date", () => {
    const files = RmLogsSchema.parse(readFixture("logs.json"));
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.name).sort()).toEqual(["resourcemanager.log", "rm.out"]);
    const rmlog = files.find((f) => f.name === "resourcemanager.log")!;
    expect(rmlog.size).toBe(RM_LOG_BYTES);
    expect(rmlog.size).toBe(348349);
    expect(rmlog.lastModified).toBe(1791901814000);
    expect(rmlog.modifiedText).toBe("Oct 13, 2026, 8:00:14 PM");
    expect(rmlog.isDir).toBe(false);
  });

  it("keeps a directory entry out of the readable set", () => {
    const files = RmLogsSchema.parse({ files: [{ name: "sub", size: "0 bytes", modified: null, isDir: true }] });
    expect(files).toEqual([entry({ name: "sub", isDir: true })]);
    // directories sort last and are never selected by the viewer
    expect(sortLogFiles([...files, entry({ name: "a.log", size: 1 })], "name", false).map((f) => f.name)).toEqual(["a.log", "sub"]);
  });
});

describe("paging through a byte-addressed file", () => {
  it("computes the last page so it always ends exactly at the end of the file", () => {
    expect(lastPageOffset(348349)).toBe(262144);
    expect(lastPageOffset(348349) + (348349 - lastPageOffset(348349))).toBe(348349);
    expect(lastPageOffset(1000)).toBe(0);
    expect(lastPageOffset(LOG_PAGE_BYTES)).toBe(0);
    expect(lastPageOffset(LOG_PAGE_BYTES + 1)).toBe(LOG_PAGE_BYTES);
    expect(lastPageOffset(0)).toBe(0);
  });

  it("walks every page from the start to the end without skipping a byte", () => {
    const size = RM_LOG_BYTES;
    const seen: [number, number][] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = logPage(size, offset);
      seen.push([page.offset, page.end]);
      offset = page.next;
    }
    expect(seen[0]).toEqual([0, LOG_PAGE_BYTES]);
    expect(seen[seen.length - 1]?.[1]).toBe(size);
    for (let i = 1; i < seen.length; i++) expect(seen[i]?.[0]).toBe(seen[i - 1]?.[1]);
    expect(seen.at(-1)?.[0]).toBe(lastPageOffset(size));
  });

  it("has no previous page at the start and no next page at the end", () => {
    const first = logPage(RM_LOG_BYTES, 0);
    expect(first.prev).toBeNull();
    expect(first.next).toBe(LOG_PAGE_BYTES);
    const last = logPage(RM_LOG_BYTES, lastPageOffset(RM_LOG_BYTES));
    expect(last.next).toBeNull();
    expect(last.prev).toBe(last.offset - LOG_PAGE_BYTES);
    expect(last.end).toBe(RM_LOG_BYTES);
    expect(last.last).toBe(last.offset);
  });

  it("clamps a hand-edited offset instead of asking for nothing", () => {
    const beyond = logPage(RM_LOG_BYTES, 99_999_999);
    expect(beyond.offset).toBe(RM_LOG_BYTES - 1);
    expect(beyond.end).toBe(RM_LOG_BYTES);
    const negative = logPage(RM_LOG_BYTES, -5);
    expect(negative.offset).toBe(0);
  });

  it("honours a custom page size", () => {
    const page = logPage(RM_LOG_BYTES, 0, 32 * 1024);
    expect(page.length).toBe(32 * 1024);
    expect(page.next).toBe(32 * 1024);
  });
});

describe("the window the server actually served", () => {
  it("prefers the x-burrow-log-* headers", () => {
    const headers = new Headers({
      "x-burrow-log-size": "222179",
      "x-burrow-log-start": "131072",
      "x-burrow-log-end": "222179",
      "x-burrow-log-source": "rm",
    });
    expect(parseLogWindow(headers, { offset: 131072, size: 222179, byteLength: 91107 })).toEqual({
      size: 222179,
      start: 131072,
      end: 222179,
      source: "rm",
      derived: false,
    });
  });

  it("falls back to content-range (Jetty's 206, inclusive end)", () => {
    const headers = new Headers({ "content-range": "bytes 131072-222178/222179" });
    expect(parseLogWindow(headers, { offset: 0, size: 0, byteLength: 91107 })).toEqual({
      size: 222179,
      start: 131072,
      end: 222179,
      source: null,
      derived: false,
    });
  });

  it("derives the window from the request and the bytes that arrived when the endpoint sends neither", () => {
    const info = parseLogWindow(new Headers(), { offset: 1024, size: 4096, byteLength: 3072 });
    expect(info).toEqual({ size: 4096, start: 1024, end: 4096, source: null, derived: true });
  });

  it("never reports a size smaller than what already arrived, and flags a partially derived window", () => {
    // the daemon said `/*` (unknown total): start/end come from the header, the size is derived from what arrived
    const info = parseLogWindow(new Headers({ "content-range": "bytes 0-1023/*" }), { offset: 0, size: 10, byteLength: 1024 });
    expect(info).toEqual({ size: 1024, start: 0, end: 1024, source: null, derived: true });
  });

  it("labels an inclusive byte range with a human size", () => {
    expect(byteRangeLabel({ size: 222179, start: 0, end: 131072, source: null, derived: false })).toBe(
      "bytes 0–131,071 of 222,179 · 128 KiB",
    );
    expect(byteRangeLabel({ size: 1712, start: 0, end: 1712, source: null, derived: false })).toBe("bytes 0–1,711 of 1,712 · 1.7 KiB");
  });
});

describe("fetchLogChunk", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the requested range and keeps the served window", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe("/api/rm/logs/rm%20log%2F1.out?length=1024&offset=2048");
      return new Response("hello", {
        status: 206,
        headers: {
          "content-type": "text/plain",
          "x-burrow-api": "1",
          "x-burrow-cache": "hit",
          "x-burrow-log-size": "4096",
          "x-burrow-log-start": "2048",
          "x-burrow-log-end": "2053",
          "x-burrow-log-source": "rm",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const chunk = await fetchLogChunk("rm log/1.out", { offset: 2048, length: 1024, size: 4096 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunk.text).toBe("hello");
    expect(chunk).toMatchObject({ size: 4096, start: 2048, end: 2053, source: "rm", derived: false });
  });

  it("treats a missing endpoint (404 envelope) as an ApiError the page can recognise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "not_found", message: "no such route", hint: "build the rm route" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const err = await fetchLogChunk("a.log", { offset: 0, length: 128, size: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe("no such route");
    expect((err as ApiError).hint).toBe("build the rm route");
    expect(isEndpointMissing(err)).toBe(true);
  });

  it("reports an upstream failure as a normal error, not as a missing endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 502 })),
    );
    const err = await fetchLogChunk("a.log", { offset: 0, length: 128, size: 0 }).catch((e: unknown) => e);
    expect(isEndpointMissing(err)).toBe(false);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).message).toContain("502");
  });

  it("does not mistake a ResourceManager 404 for a missing Burrow route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404, headers: { "x-burrow-upstream": "rm.example:8088" } })),
    );
    const err = await fetchLogChunk("a.log", { offset: 0, length: 128, size: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isEndpointMissing(err)).toBe(false);
  });

  it("wraps a network failure with the file it was reading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const err = await fetchLogChunk("resourcemanager.log", { offset: 0, length: 128, size: 0 }).catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("network");
    expect((err as ApiError).message).toBe("Cannot reach Burrow to read rm/logs/resourcemanager.log");
  });
});

describe("URLs and sorting", () => {
  it("builds one encoded path for both the viewer and the download link", () => {
    expect(logFilePath("resourcemanager.log")).toBe("rm/logs/resourcemanager.log");
    expect(logFilePath("a b/c.log")).toBe("rm/logs/a%20b%2Fc.log");
    expect(logFileHref("resourcemanager.log")).toBe("/api/rm/logs/resourcemanager.log");
  });

  it("sorts by name, size and time, always with directories last", () => {
    const files = [
      entry({ name: "b.log", size: 10, modifiedSortKey: 2 }),
      entry({ name: "a.log", size: 30, modifiedSortKey: 1 }),
      entry({ name: "sub", isDir: true, modifiedSortKey: 99 }),
    ];
    expect(sortLogFiles(files, "name", false).map((f) => f.name)).toEqual(["a.log", "b.log", "sub"]);
    // directories stay last whatever the direction: they are not readable here
    expect(sortLogFiles(files, "name", true).map((f) => f.name)).toEqual(["b.log", "a.log", "sub"]);
    expect(sortLogFiles(files, "size", false).map((f) => f.name)).toEqual(["b.log", "a.log", "sub"]);
    expect(sortLogFiles(files, "lastModified", true).map((f) => f.name)).toEqual(["b.log", "a.log", "sub"]);
    expect(sortLogFiles(files, "lastModified", false).map((f) => f.name)).toEqual(["a.log", "b.log", "sub"]);
  });

  it("falls back to the epoch when the listing reported one instead of a printed date", () => {
    const files = [entry({ name: "old.log", lastModified: 1_000 }), entry({ name: "new.log", lastModified: 2_000 })];
    expect(sortLogFiles(files, "lastModified", true).map((f) => f.name)).toEqual(["new.log", "old.log"]);
  });

  it("does not sort by display text: an unparsable date sorts last, not first", () => {
    const files = [entry({ name: "ok.log", modifiedSortKey: 5 }), entry({ name: "weird.log", modifiedText: "last Tuesday" })];
    expect(sortLogFiles(files, "lastModified", false).map((f) => f.name)).toEqual(["weird.log", "ok.log"]);
  });
});
