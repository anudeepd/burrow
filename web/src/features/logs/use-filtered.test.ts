import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LineBuffer } from "./model";
import { useFilteredIndex } from "./use-filtered";

describe("log level index", () => {
  it("rebuilds after refreshing a window with the same number of lines", () => {
    const buffer = new LineBuffer();
    buffer.setWindow("INFO one\nERROR two\n", 0);
    const { result, rerender } = renderHook(() => useFilteredIndex(buffer, "WARN"));
    expect(result.current).toEqual([1]);
    buffer.setWindow("ERROR one\nINFO two\n", 0);
    rerender();
    expect(result.current).toEqual([0]);
  });

  it("extends the index while following and preserves unstamped stack traces", () => {
    const buffer = new LineBuffer();
    buffer.setWindow("INFO one\nERROR two\n", 0);
    const { result, rerender } = renderHook(() => useFilteredIndex(buffer, "WARN"));
    buffer.append("  at task.run\nWARN three\nINFO four\n", buffer.resumeOffset);
    rerender();
    expect(result.current).toEqual([1, 2, 3]);
  });
});
