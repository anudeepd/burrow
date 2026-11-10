import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ result: null as Record<string, unknown> | null, results: [] as Record<string, unknown>[] }));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => mock.result,
  useQueries: () => mock.results,
}));

const { renderHook } = await import("@testing-library/react");
const { useQueries } = await import("@tanstack/react-query");
const { useStableQueries, useStableQuery } = await import("./use-stable-query");

type Snapshot = {
  data?: unknown;
  error: unknown;
  status: "pending" | "error" | "success";
  isError: boolean;
  isPending: boolean;
  isLoading: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
};

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    data: undefined,
    error: null,
    status: "pending",
    isError: false,
    isPending: true,
    isLoading: true,
    isLoadingError: false,
    isRefetchError: false,
    ...overrides,
  };
}

function renderStable(initial: Snapshot, queryKey: unknown[] = ["test"]) {
  mock.result = initial as Record<string, unknown>;
  return renderHook(
    ({ result, key }: { result: Snapshot; key: unknown[] }) => {
      mock.result = result as Record<string, unknown>;
      return useStableQuery({ queryKey: key, queryFn: async () => null });
    },
    { initialProps: { result: initial, key: queryKey } },
  );
}

function renderStableQueries(initial: Snapshot[], keys: unknown[][]) {
  mock.results = initial as unknown as Record<string, unknown>[];
  return renderHook(
    ({ results, queryKeys }: { results: Snapshot[]; queryKeys: unknown[][] }) => {
      mock.results = results as unknown as Record<string, unknown>[];
      return useStableQueries(useQueries({ queries: queryKeys.map((queryKey) => ({ queryKey, queryFn: async () => null })) }), queryKeys);
    },
    { initialProps: { results: initial, queryKeys: keys } },
  );
}

describe("useStableQueries", () => {
  it("keeps each failure through a no-data refetch and clears it on success", () => {
    const first = new Error("attempt one failed");
    const { result, rerender } = renderStableQueries(
      [
        snapshot({ error: first, status: "error", isError: true, isPending: false, isLoading: false }),
        snapshot({ data: { containers: [] } }),
      ],
      [
        ["attempt", 1],
        ["attempt", 2],
      ],
    );
    expect(result.current[0]!.error).toBe(first);

    rerender({
      results: [snapshot(), snapshot({ data: { containers: [] } })],
      queryKeys: [
        ["attempt", 1],
        ["attempt", 2],
      ],
    });
    expect(result.current[0]!.error).toBe(first);
    expect(result.current[0]!.isError).toBe(true);
    expect(result.current[0]!.isPending).toBe(false);
    expect(result.current[1]!.error).toBeNull();

    rerender({
      results: [
        snapshot({ error: null, status: "success", isError: false, isPending: false, isLoading: false }),
        snapshot({ data: { containers: [] } }),
      ],
      queryKeys: [
        ["attempt", 1],
        ["attempt", 2],
      ],
    });
    expect(result.current[0]!.error).toBeNull();
  });

  it("starts clean when a key changes", () => {
    const first = new Error("old attempt");
    const { result, rerender } = renderStableQueries(
      [snapshot({ error: first, status: "error", isError: true, isPending: false, isLoading: false })],
      [["attempt", 1]],
    );
    rerender({ results: [snapshot()], queryKeys: [["attempt", 1]] });
    expect(result.current[0]!.error).toBe(first);

    rerender({ results: [snapshot()], queryKeys: [["attempt", 2]] });
    expect(result.current[0]!.error).toBeNull();
  });
});

describe("useStableQuery", () => {
  it("returns the query result untouched while there is no failure", () => {
    const pending = snapshot();
    const { result } = renderStable(pending);
    expect(result.current).toBe(pending);

    const failed = snapshot({ error: new Error("boom"), status: "error", isError: true, isPending: false, isLoading: false });
    mock.result = failed as Record<string, unknown>;
    const { result: second } = renderStable(failed);
    expect(second.current).toBe(failed);
  });

  it("keeps the failure while a no-data retry is in flight", () => {
    const loadError = new Error("no Spark source");
    const { result, rerender } = renderStable(
      snapshot({ error: loadError, status: "error", isError: true, isPending: false, isLoading: false }),
    );

    rerender({ result: snapshot(), key: ["test"] });

    expect(result.current.error).toBe(loadError);
    expect(result.current.status).toBe("error");
    expect(result.current.isError).toBe(true);
    expect(result.current.isPending).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isLoadingError).toBe(true);
    expect(result.current.isRefetchError).toBe(false);
  });

  it("reports a refresh failure when cached data is still shown", () => {
    const loadError = new Error("refresh failed");
    const { result, rerender } = renderStable(
      snapshot({ error: loadError, status: "error", isError: true, isPending: false, isLoading: false }),
    );

    rerender({ result: snapshot({ data: { rows: 1 } }), key: ["test"] });

    expect(result.current.isLoadingError).toBe(false);
    expect(result.current.isRefetchError).toBe(true);
  });

  it("starts clean when the query key changes, even if the array is rebuilt every render", () => {
    const loadError = new Error("old app");
    const { result, rerender } = renderStable(
      snapshot({ error: loadError, status: "error", isError: true, isPending: false, isLoading: false }),
      ["app", "one"],
    );
    expect(result.current.error).toBe(loadError);

    rerender({ result: snapshot(), key: ["app", "one"] });
    expect(result.current.error).toBe(loadError);

    rerender({ result: snapshot(), key: ["app", "two"] });
    expect(result.current.error).toBeNull();
  });
});
