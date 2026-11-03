import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLocalTableState } from "./table-state";

describe("useLocalTableState", () => {
  it("keeps local sort and visibility state while exposing the defaults", () => {
    const defaults = { containerId: true, nodeHttpAddress: false };
    const { result } = renderHook(() => useLocalTableState(defaults));
    expect(result.current.sorting).toEqual([]);
    expect(result.current.visibility).toBe(defaults);
    expect(result.current.defaults).toBe(defaults);

    act(() => {
      result.current.setSorting([{ id: "containerId", desc: true }]);
      result.current.setVisibility({ containerId: false, nodeHttpAddress: true });
    });
    expect(result.current.sorting).toEqual([{ id: "containerId", desc: true }]);
    expect(result.current.visibility).toEqual({ containerId: false, nodeHttpAddress: true });
  });
});
