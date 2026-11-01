import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { apiGetWithMeta, apiText } = await import("./client");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.__BURROW_SCHEMA_ISSUES__;
});

describe("API response handling", () => {
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
      expect(result.data).toEqual({ wrong: true });
      expect(window.__BURROW_SCHEMA_ISSUES__).toEqual([
        {
          path: "example",
          issues: expect.arrayContaining([expect.objectContaining({ path: "value", code: "invalid_type" })]),
        },
      ]);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      window.__BURROW_STRICT_SCHEMAS__ = originalStrict;
      vi.resetModules();
    }
  });
});
