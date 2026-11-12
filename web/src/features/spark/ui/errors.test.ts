import { describe, expect, it } from "vitest";
import { ApiError } from "~/api/client";
import { classifySparkError, sourceUnavailableReason } from "./errors";

describe("Spark error classification", () => {
  it("distinguishes unsupported endpoints, unavailable sources, and missing entities", () => {
    expect(classifySparkError(new ApiError("unknown API group '/api/spark'", "http", 404, "not_found"), "the job").kind).toBe(
      "backend-missing",
    );
    const unavailable = classifySparkError(new ApiError("", "http", 503, "unavailable", { url: "http://history" }), "the job");
    expect(unavailable).toMatchObject({ kind: "unavailable", message: "The backend could not resolve a Spark REST source for the job." });
    expect(unavailable.detail).toContain("http://history");
    const unavailableWithStatus = classifySparkError(
      new ApiError("history failed", "http", 503, "unavailable", { url: "http://history", status: 502 }),
      "the job",
    );
    expect(unavailableWithStatus.detail).toContain("http://history → 502");
    expect(classifySparkError(new ApiError("", "http", 404, "gone"), "job 4")).toMatchObject({
      kind: "not-found",
      message: "Spark reports no job 4.",
    });
    expect(classifySparkError(new ApiError("missing", "http", 404), "job 5")).toMatchObject({
      kind: "not-found",
      message: "missing",
    });
  });

  it("explains unreachable, schema, generic, and non-API failures", () => {
    expect(classifySparkError(new ApiError("timed out", "timeout", null), "the job")).toMatchObject({
      kind: "unreachable",
      hint: "Check the ResourceManager web proxy / Spark History Server and retry.",
    });
    expect(classifySparkError(new ApiError("bad shape", "schema", 200, null, null, "check the payload"), "the job")).toMatchObject({
      kind: "schema",
      title: "Unexpected Spark payload shape",
      hint: "check the payload",
    });
    expect(classifySparkError(new ApiError("server error", "http", 500), "the job")).toMatchObject({
      kind: "other",
      title: "Spark request failed",
      status: 500,
    });
    expect(classifySparkError(new ApiError("java.lang.IllegalStateException: broken", "http", 500), "the job")).toMatchObject({
      kind: "other",
      message: "The Spark request failed.",
    });
    expect(classifySparkError(new ApiError("java.lang.IllegalStateException: broken", "schema", 200), "the job")).toMatchObject({
      kind: "schema",
      message: "The upstream response did not match the expected shape.",
    });
    expect(classifySparkError(new ApiError("at Object.<anonymous> (file.js:1:2)", "timeout", null), "the job")).toMatchObject({
      kind: "unreachable",
      message: "The Spark source is unreachable.",
    });
    expect(classifySparkError("unexpected value", "the job")).toMatchObject({ kind: "other", message: "unexpected value", status: null });
  });

  it("reports the source-unavailable reasons and leaves healthy or absent sources alone", () => {
    expect(sourceUnavailableReason(null)).toBeNull();
    expect(sourceUnavailableReason({ available: true })).toBeNull();
    expect(sourceUnavailableReason({ available: false, reason: "history server is not configured" })).toBe(
      "history server is not configured",
    );
    expect(sourceUnavailableReason({ available: false })).toContain("no Spark REST base");
    expect(sourceUnavailableReason({ mode: "none" })).toBe("No Spark REST base is available for this application.");
    expect(sourceUnavailableReason({ mode: "none", reason: "source disabled" })).toBeNull();
  });
});
