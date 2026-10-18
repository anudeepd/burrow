import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sp } from "./queries";
import { compact, serializeColumns } from "./search";

const APP = "application_123_0001";
afterEach(() => vi.unstubAllGlobals());

describe("Spark task capture", () => {
  it("loads explicit pages past Spark's 20-row default and keeps the application attempt", async () => {
    const requests: URL[] = [];
    const tasks = Array.from({ length: 1005 }, (_, taskId) => ({ taskId, index: taskId, status: "SUCCESS", accumulatorUpdates: [] }));
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input, "http://localhost");
      requests.push(url);
      const offset = Number(url.searchParams.get("offset"));
      const length = Number(url.searchParams.get("length"));
      return new Response(JSON.stringify(tasks.slice(offset, offset + length)), { headers: { "content-type": "application/json" } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const captured = await client.fetchQuery(sp.allTasks(APP, 3, 1, "static", "2"));
    expect(captured).toHaveLength(1005);
    expect(captured.at(-1)?.taskId).toBe(1004);
    expect(requests.map((r) => r.searchParams.get("offset"))).toEqual(["0", "1000"]);
    expect(requests.every((r) => r.searchParams.get("length") === "1000" && r.searchParams.get("attempt") === "2")).toBe(true);
    client.clear();
  });

  it("clears explicit columns when the table resets to defaults", () => {
    expect(compact({ cols: "-host", ...serializeColumns({}) })).toEqual({});
  });
});
