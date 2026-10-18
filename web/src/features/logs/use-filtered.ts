/**
 * The level filter's index: which buffer lines are visible, extended incrementally.
 *
 * During follow a filter over a 1M-line buffer must cost O(new lines), not O(all lines) per chunk, so the index lives in
 * a ref and only the newly appended range is scanned. A ring-buffer drop or a filter change rebuilds from scratch.
 * With no filter the identity mapping is used, so no million-entry array is ever built.
 */
import { useRef } from "react";
import { type LineBuffer, LEVEL_RANK, type LogLevel, detectLevel } from "./model";

export const NO_FILTER_IDX: number[] = [];

export function useFilteredIndex(buffer: LineBuffer, filter: LogLevel | null): number[] {
  const cache = useRef<{ filter: LogLevel | null; built: number; dropped: number; generation: number; idx: number[] }>({
    filter: null,
    built: 0,
    dropped: 0,
    generation: buffer.generation,
    idx: [],
  });
  if (filter == null) {
    cache.current = { filter: null, built: buffer.length, dropped: buffer.dropped, generation: buffer.generation, idx: NO_FILTER_IDX };
    return NO_FILTER_IDX;
  }
  const c = cache.current;
  if (c.filter !== filter || c.dropped !== buffer.dropped || c.generation !== buffer.generation || c.built > buffer.length) {
    c.filter = filter;
    c.dropped = buffer.dropped;
    c.generation = buffer.generation;
    c.built = 0;
    c.idx = [];
  }
  if (c.built < buffer.length) {
    for (let i = c.built; i < buffer.length; i++) {
      const level = detectLevel(buffer.line(i));
      if (level == null || LEVEL_RANK[level] >= LEVEL_RANK[filter]) c.idx.push(i);
    }
    c.built = buffer.length;
  }
  return c.idx;
}
