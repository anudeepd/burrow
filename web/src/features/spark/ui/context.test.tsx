import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkApplication } from "../data/schemas";
import { sparkVersionForSelection } from "./context";

const { cleanup, renderHook } = await import("@testing-library/react");
const { useSpark } = await import("./context");

const application = {
  id: "application-1",
  attempts: [{ attemptId: "attempt-a", appSparkVersion: "3.5.1" }, { appSparkVersion: "3.4.2" }],
} as SparkApplication;

afterEach(cleanup);

describe("sparkVersionForSelection", () => {
  it("prefers the requested attempt, then source attempt, then first available attempt", () => {
    expect(sparkVersionForSelection(application, "attempt-a", "1")).toBe("3.5.1");
    expect(sparkVersionForSelection(application, "missing", "1")).toBe("3.4.2");
    expect(sparkVersionForSelection(application, "missing", "also-missing")).toBe("3.5.1");
  });

  it("uses the attempt index when ids are absent and handles missing versions", () => {
    expect(sparkVersionForSelection(application, "1", null)).toBe("3.4.2");
    expect(sparkVersionForSelection({ id: "empty", attempts: [] }, null, null)).toBeNull();
    expect(sparkVersionForSelection(null, null, null)).toBeNull();
  });

  it("throws when a Spark consumer is rendered outside its provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useSpark())).toThrow(
      "useSpark() used outside the Spark layout route (routes/apps/$appId/spark/route.tsx)",
    );
  });
});
