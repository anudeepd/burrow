import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../client";
import {
  LOG_MAX_BYTES,
  LogFilesResponseSchema,
  downloadLogFile,
  fetchLogWindow,
  hintQuery,
  isLogEndpointMissing,
  logFileHref,
  logFilePath,
  logFilesPath,
  logStreamPath,
  logStreamUrl,
  orderLogFiles,
} from "./logs";

afterEach(() => vi.unstubAllGlobals());

describe("isLogEndpointMissing", () => {
  it("recognizes a backend 404 without upstream provenance", () => {
    expect(isLogEndpointMissing(new ApiError("route not found", "http", 404))).toBe(true);
  });

  it("does not treat an upstream 404 as a missing Burrow route", () => {
    expect(isLogEndpointMissing(new ApiError("file not found", "http", 404, null, { url: "http://nm/logs", status: 404 }))).toBe(false);
    expect(
      isLogEndpointMissing(
        new ApiError("upstream returned 404", "http", 404, null, null, null, {
          api: null,
          cache: null,
          upstream: "http://nm/logs",
          ageMs: null,
          etag: null,
        }),
      ),
    ).toBe(false);
  });

  it("does not classify other failures as a missing route", () => {
    expect(isLogEndpointMissing(new ApiError("bad gateway", "http", 502))).toBe(false);
    expect(isLogEndpointMissing(new Error("network error"))).toBe(false);
  });
});

describe("container log wire helpers", () => {
  it("normalizes log-file metadata and orders stdout/stderr before other files", () => {
    const parsed = LogFilesResponseSchema.parse({
      files: [
        { name: "zeta", size: "1,024", lastModified: "not a date" },
        { name: "stderr", size: null, lastModified: null },
        { name: "stdout", size: 10, lastModified: "1791010000000" },
      ],
    });
    expect(parsed.source).toBe("nm");
    expect(parsed.files.map((f) => [f.name, f.size, f.lastModified])).toEqual([
      ["zeta", 1024, null],
      ["stderr", 0, null],
      ["stdout", 10, 1791010000000],
    ]);
    expect(orderLogFiles(parsed.files).map((f) => f.name)).toEqual(["stdout", "stderr", "zeta"]);
    expect(
      orderLogFiles([
        { name: "z", size: 1, lastModified: null },
        { name: "a", size: 1, lastModified: null },
      ]).map((f) => f.name),
    ).toEqual(["a", "z"]);
    expect(LogFilesResponseSchema.parse({}).files).toEqual([]);
  });

  it("only sends non-empty hints and builds encoded file, directory, and stream URLs", () => {
    expect(hintQuery(undefined)).toBeUndefined();
    expect(hintQuery({ node: "", user: null, app: "" })).toBeUndefined();
    expect(hintQuery({ node: "nm:8042", user: "alice", app: "application_1" })).toEqual({
      node: "nm:8042",
      user: "alice",
      app: "application_1",
    });
    expect(logFilesPath("container/a")).toBe("logs/containers/container%2Fa");
    expect(logFilePath("container/a", "stderr.1")).toBe("logs/containers/container%2Fa/files/stderr.1");
    expect(logStreamPath("container/a", "stdout")).toBe("logs/containers/container%2Fa/files/stdout/stream");
    expect(logFileHref("container/a", "stdout", { node: "nm:8042", user: "" })).toContain("node=nm%3A8042");
    expect(logStreamUrl("container/a", "stdout", { app: "application_1" }, 12)).toContain("offset=12");
    expect(logStreamUrl("c", "f", undefined, 0)).toContain("offset=0");
  });

  it("reads a byte window with server headers, or falls back to the requested offset and text length", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response("hello", {
          headers: {
            "x-burrow-log-start": "8",
            "x-burrow-log-end": "not-a-number",
            "x-burrow-log-size": "90",
            "x-burrow-log-source": "jhs",
            "x-burrow-upstream": "http://jhs",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchLogWindow("container", "stdout", {
      offset: 4,
      length: 10,
      hints: { node: "nm:8042", user: "alice" },
    });
    expect(result).toMatchObject({ text: "hello", size: 90, start: 8, end: 13, source: "jhs" });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("offset=4");
    expect(url).toContain("length=10");
    expect(url).toContain("node=nm%3A8042");

    fetchMock.mockImplementationOnce(async () => new Response("abc"));
    const fallback = await fetchLogWindow("container", "stderr", { offset: 7 });
    expect(fallback).toMatchObject({ text: "abc", start: 7, end: 10, size: 10, source: null });
  });

  it("gives tail reads priority over ranges and reports HTTP failures with the response body", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response("bad gateway", { status: 502, headers: { "content-type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchLogWindow("container", "stdout", { offset: 10, length: 20, tail: 5 })).rejects.toMatchObject({
      kind: "http",
      status: 502,
      message: expect.stringContaining("HTTP 502"),
      body: "bad gateway",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("tail=5");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("offset=");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("length=");
    expect(LOG_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it("distinguishes cancelled, timed out, and unavailable log reads", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      throw new Error("connection refused");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchLogWindow("c", "f", {}, AbortSignal.abort())).rejects.toMatchObject({ kind: "abort" });

    fetchMock.mockImplementationOnce(async () => {
      throw new DOMException("too slow", "TimeoutError");
    });
    await expect(fetchLogWindow("c", "f", {})).rejects.toMatchObject({ kind: "timeout", status: null });

    fetchMock.mockImplementationOnce(async () => {
      throw new Error("connection refused");
    });
    await expect(fetchLogWindow("c", "f", {})).rejects.toMatchObject({ kind: "network", status: null });
  });

  it("downloads a multi-window file, reports progress, and stops when the server makes no progress", async () => {
    const responses = [
      new Response("one", { headers: { "x-burrow-log-start": "0", "x-burrow-log-end": "3", "x-burrow-log-size": "6" } }),
      new Response("two", { headers: { "x-burrow-log-start": "3", "x-burrow-log-end": "6", "x-burrow-log-size": "6" } }),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => responses.shift() ?? new Response(""));
    vi.stubGlobal("fetch", fetchMock);
    const progress: [number, number][] = [];
    const blob = await downloadLogFile("container", "stdout", 6, { user: "alice" }, (loaded, total) => progress.push([loaded, total]));
    expect(await blob.text()).toBe("onetwo");
    expect(progress).toEqual([
      [3, 6],
      [6, 6],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("offset=3");

    fetchMock.mockImplementationOnce(async () => new Response("", { headers: { "x-burrow-log-size": "20" } }));
    const empty = await downloadLogFile("container", "empty", 20);
    expect(await empty.text()).toBe("");
  });
});
