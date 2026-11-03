import { describe, expect, it } from "vitest";
import { failQuery } from "./app-route-coverage.setup";

describe("route test query failures", () => {
  it("reports when the requested query has not been created", () => {
    const queryKey = ["coverage", "missing-route-query"];
    expect(() => failQuery(queryKey, "failure")).toThrow(`Missing query ${JSON.stringify(queryKey)}`);
  });
});
