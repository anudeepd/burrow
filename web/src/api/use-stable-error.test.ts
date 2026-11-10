import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStableError } from "./use-stable-error";

describe("useStableError", () => {
  it("keeps the last error through a no-data refetch and clears it on success", () => {
    const loadError = new Error("no Spark source");
    type QueryState = { error: unknown; status: "pending" | "error" | "success" };
    const initial: QueryState = { error: null, status: "pending" };
    const { result, rerender } = renderHook((props: QueryState) => useStableError(props, "app-1"), {
      initialProps: initial,
    });
    expect(result.current).toBeNull();

    rerender({ error: loadError, status: "error" });
    expect(result.current).toBe(loadError);

    // React Query resets error -> null while the next attempt is in flight.
    rerender({ error: null, status: "pending" });
    expect(result.current).toBe(loadError);

    rerender({ error: null, status: "success" });
    expect(result.current).toBeNull();
  });

  it("drops the stored error when the identity changes", () => {
    const loadError = new Error("old app");
    const { result, rerender } = renderHook(
      ({ id, error }: { id: string; error: unknown }) => {
        const status: "error" | "pending" = error == null ? "pending" : "error";
        return useStableError({ error, status }, id);
      },
      { initialProps: { id: "app-1", error: loadError as unknown } },
    );
    expect(result.current).toBe(loadError);

    rerender({ id: "app-2", error: null });
    expect(result.current).toBeNull();
  });
});
