import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parityStore } from "~/state/parity";

const { ApiError, apiGet, apiGetWithMeta, apiText, canonicalQuery, topicOf } = await import("./client");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.__BURROW_SCHEMA_ISSUES__;
  parityStore.setState(() => ({ enabled: false }));
});

describe("API response handling", () => {
  it("canonicalizes scalar, array, empty, and absent query parameters", () => {
    expect(canonicalQuery()).toBe("");
    expect(canonicalQuery({})).toBe("");
    expect(canonicalQuery({ empty: "", absent: null })).toBe("");
    expect(canonicalQuery({ tag: ["a", "b,c"], flag: false })).toBe("?flag=false&tag=a,b,c");
    expect(topicOf("yarn/apps", { states: ["RUNNING", "ACCEPTED"] })).toBe("yarn/apps?states=RUNNING,ACCEPTED");
  });

  it("classifies network failures, timeouts, aborts, and unreachable API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await expect(apiGetWithMeta("health")).rejects.toMatchObject({ kind: "network", hint: "Is the Burrow server still running?" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new DOMException("deadline", "TimeoutError"))),
    );
    await expect(apiGetWithMeta("health", { timeoutMs: 1500 })).rejects.toMatchObject({
      kind: "timeout",
      message: "No response from /api/health within 2s",
      hint: "Burrow or the ResourceManager is slow to answer.",
    });

    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("aborted"))),
    );
    await expect(apiGetWithMeta("health", { signal: controller.signal })).rejects.toMatchObject({
      kind: "abort",
      message: "Request cancelled",
    });

    expect(new ApiError("bad gateway", "http", 502).isUnreachable).toBe(true);
    expect(new ApiError("upstream down", "http", 500, "upstream_unreachable").isUnreachable).toBe(true);
    expect(new ApiError("offline", "network", null).isUnreachable).toBe(true);
    expect(new ApiError("slow", "timeout", null).isUnreachable).toBe(true);
    expect(new ApiError("bad request", "http", 400).isUnreachable).toBe(false);
  });

  it("uses HTTP fallbacks for empty and incomplete error envelopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 502 })),
    );
    await expect(apiGetWithMeta("missing-body")).rejects.toMatchObject({ message: "HTTP 502 from /api/missing-body", body: null });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: {} }), { status: 500 })),
    );
    await expect(apiGetWithMeta("missing-message")).rejects.toMatchObject({ message: "HTTP 500", code: null });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ RemoteException: {} }), { status: 500 })),
    );
    await expect(apiGetWithMeta("missing-remote-fields")).rejects.toMatchObject({ message: "HTTP 500", code: "RemoteException" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 500 })),
    );
    await expect(apiGetWithMeta("plain-error-body")).rejects.toMatchObject({ body: "not-json" });
  });

  it("validates good schemas without changing their parsed data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ value: "ok" }), { status: 200 })),
    );
    await expect(apiGetWithMeta("typed", { schema: z.object({ value: z.string() }) })).resolves.toMatchObject({
      data: { value: "ok" },
    });
  });

  it("loads untyped data, applies a schema, and sends an explicit no-cache header", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ value: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(apiGet<{ value: string }>("plain")).resolves.toEqual({ value: "ok" });
    await expect(apiGet("cached", { schema: z.object({ value: z.string() }), noCache: true })).resolves.toEqual({ value: "ok" });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ headers: { Accept: "application/json", "Cache-Control": "no-cache" } });
    parityStore.setState(() => ({ enabled: true }));
    await apiGet("parity");
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ headers: { Accept: "application/json", "Cache-Control": "no-cache" } });
  });

  it("falls back when reading an HTTP error body itself fails", async () => {
    const response = new Response("unreadable", { status: 500 });
    vi.spyOn(response, "text").mockRejectedValue(new Error("stream closed"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(apiGetWithMeta("broken-body")).rejects.toMatchObject({
      message: "HTTP 500 from /api/broken-body",
      body: null,
    });
  });

  it("maps Hadoop RemoteException responses to a structured API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ RemoteException: { exception: "IllegalArgumentException", message: "bad request" } }), {
            status: 500,
          }),
      ),
    );

    await expect(apiGetWithMeta("yarn/apps/missing")).rejects.toMatchObject({
      message: "bad request",
      kind: "http",
      status: 500,
      code: "IllegalArgumentException",
      upstream: { url: "/api/yarn/apps/missing", status: 500 },
    });
  });

  it("uses the exception name when a Hadoop error has no message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ RemoteException: { exception: "NotFoundException" } }), { status: 404 })),
    );

    await expect(apiGetWithMeta("yarn/apps/missing")).rejects.toMatchObject({ message: "NotFoundException", code: "NotFoundException" });
  });

  it("reports a successful response with invalid JSON as a schema error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not JSON", { status: 200 })),
    );

    await expect(apiGetWithMeta("yarn/info")).rejects.toMatchObject({
      message: "Response from yarn/info is not valid JSON",
      kind: "schema",
      code: "bad_json",
    });
  });

  it("requests text endpoints with text/plain and returns their body and response headers", async () => {
    const fetch = vi.fn(
      async () => new Response("thread dump", { status: 200, headers: { "Content-Type": "text/plain", "x-burrow-cache": "hit" } }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await apiText("rm/stacks");
    expect(result).toMatchObject({ data: "thread dump", responseMeta: { cache: "hit" } });
    expect(fetch).toHaveBeenCalledWith("/api/rm/stacks", expect.objectContaining({ headers: { Accept: "text/plain" } }));
  });

  it("keeps malformed schema data in loose mode while recording its issues", async () => {
    const originalStrict = window.__BURROW_STRICT_SCHEMAS__;
    window.__BURROW_STRICT_SCHEMAS__ = false;
    vi.resetModules();
    const looseClient = await import("./client");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ wrong: true }), { status: 200 })),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await looseClient.apiGetWithMeta("example", { schema: z.object({ value: z.string() }) });
      const nextResult = await looseClient.apiGetWithMeta("example-again", { schema: z.object({ value: z.string() }) });
      expect(result.data).toEqual({ wrong: true });
      expect(nextResult.data).toEqual({ wrong: true });
      expect(window.__BURROW_SCHEMA_ISSUES__).toEqual([
        {
          path: "example",
          issues: expect.arrayContaining([expect.objectContaining({ path: "value", code: "invalid_type" })]),
        },
        expect.objectContaining({ path: "example-again" }),
      ]);
      expect(warning).toHaveBeenCalledTimes(2);
    } finally {
      window.__BURROW_STRICT_SCHEMAS__ = originalStrict;
      vi.resetModules();
    }
  });

  it("throws a schema error in strict mode", async () => {
    const originalStrict = window.__BURROW_STRICT_SCHEMAS__;
    window.__BURROW_STRICT_SCHEMAS__ = true;
    vi.resetModules();
    const strictClient = await import("./client");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ wrong: true }), { status: 200 })),
    );

    try {
      await expect(strictClient.apiGetWithMeta("strict", { schema: z.object({ value: z.string() }) })).rejects.toMatchObject({
        kind: "schema",
        code: "schema_mismatch",
        message: "Response from strict does not match the schema",
      });
    } finally {
      window.__BURROW_STRICT_SCHEMAS__ = originalStrict;
      vi.resetModules();
    }
  });
});
