import { describe, expect, it } from "vitest";

interface HeadResult {
  meta?: { title?: string }[];
}

function titleOf(head: unknown, params: Record<string, string> = {}): string | undefined {
  const result = (head as (context: { params: Record<string, string> }) => HeadResult)({ params });
  return result.meta?.find((entry) => entry.title)?.title;
}

describe("dynamic route titles", () => {
  it("names a node detail page by its node ID", async () => {
    const { Route } = await import("./nodes/$nodeId");
    expect(titleOf(Route.options.head, { nodeId: "worker-1:8041" })).toBe("Node worker-1:8041 · Burrow");
  });

  it("names the daemon log page", async () => {
    const { Route } = await import("./tools/logs");
    expect(titleOf(Route.options.head)).toBe("Daemon logs · Burrow");
  });
});
