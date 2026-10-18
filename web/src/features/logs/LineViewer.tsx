/**
 * The virtualized log line renderer (TanStack Virtual).
 *
 * Renders only the ~40 rows on screen, so a 1M-line buffer scrolls at the cost of a 40-line one. Rows are memoized on
 * their own text/matches, so a streaming append re-renders only the tail rows, never the whole window.
 *
 * It also owns the follow ergonomics the user feels: auto-scroll pinned to the tail while following, released the moment
 * the user scrolls up (with a "jump to tail" affordance), and re-armed when they return to the bottom. In parity mode
 * virtualization is disabled (the contract wants every row in the DOM) for buffers small enough to render whole.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { fmtClock, type TzMode } from "~/lib/format";
import { usePref } from "~/state/prefs";
import type { IndexedMatch, LineBuffer, LogLevel, Match, SearchSpec, TimestampReference } from "./model";
import { detectLevel, detectTimestamp, formatDelta, matchesByLine, relativeTimestampMs } from "./model";
import { splitSegments } from "./segments";

/** Non-wrap rows are a fixed height, which is what makes the 1M-line scroll cheap. */
const LINE_HEIGHT = 20;
/** Beyond this a parity render of "all rows" would hang; the harness crawls small fixtures. */
const PARITY_MAX_ROWS = 20_000;
const EMPTY_MATCHES: IndexedMatch[] = [];
/** A last-resort lookback so an unstamped stack-trace line still gets a delta from its record header. */
const STAMP_LOOKBACK = 500;

const LEVEL_TEXT: Record<LogLevel, string> = {
  TRACE: "text-ink-4",
  DEBUG: "text-ink-3",
  INFO: "text-ink-2",
  WARN: "text-warn",
  ERROR: "text-fail",
  FATAL: "text-fail",
};
const LEVEL_ROW: Record<LogLevel, string> = {
  TRACE: "",
  DEBUG: "",
  INFO: "",
  WARN: "bg-[color-mix(in_oklch,var(--warn)_7%,transparent)]",
  ERROR: "bg-[color-mix(in_oklch,var(--fail)_8%,transparent)]",
  FATAL: "bg-[color-mix(in_oklch,var(--fail)_12%,transparent)]",
};

const HIT = "rounded-[2px] bg-[color-mix(in_oklch,var(--warn)_38%,transparent)] text-ink";
const HIT_ACTIVE = "rounded-[2px] bg-[color-mix(in_oklch,var(--live)_45%,transparent)] text-ink ring-1 ring-live";

export interface LineViewerProps {
  buffer: LineBuffer;
  /** bumped whenever the buffer mutates; the render signal */
  version: number;
  matches: Match[];
  activeMatch: number;
  /** buffer-index list of visible lines, or null when no level filter is active */
  visibleIdx: number[] | null;
  /** scroll to this buffer line whenever `n` changes (the "jump to first error" anchor) */
  jumpLine: { line: number; n: number } | null;
  search: SearchSpec;
  wrap: boolean;
  timestamp: "absolute" | "relative";
  follow: boolean;
  paused: boolean;
  parity: boolean;
}

export function LineViewer(props: LineViewerProps) {
  const { buffer, version, matches, activeMatch, visibleIdx, jumpLine, search, wrap, timestamp, follow, paused, parity } = props;
  const tz = usePref("tz");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const filtered = visibleIdx != null;
  const count = filtered ? visibleIdx.length : buffer.length;

  const itemKey = useCallback((i: number) => (filtered ? visibleIdx[i]! : i), [filtered, visibleIdx]);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (wrap ? 44 : LINE_HEIGHT),
    overscan: 14,
    // Fixed-height rows are never measured; wrapped rows are.
    measureElement: wrap ? (el) => el.getBoundingClientRect().height : undefined,
    getItemKey: itemKey,
  });

  const bufferIndexOf = useCallback((visible: number) => (filtered ? visibleIdx[visible]! : visible), [filtered, visibleIdx]);
  const visibleIndexOf = useCallback(
    (bufferIndex: number): number => {
      if (!filtered) return bufferIndex;
      // Binary search: visibleIdx is strictly increasing.
      let lo = 0;
      let hi = visibleIdx.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = visibleIdx[mid]!;
        if (v === bufferIndex) return mid;
        if (v < bufferIndex) lo = mid + 1;
        else hi = mid - 1;
      }
      return Math.min(lo, Math.max(0, visibleIdx.length - 1));
    },
    [filtered, visibleIdx],
  );

  const byLine = useMemo(() => matchesByLine(matches), [matches]);

  // ── auto-scroll ────────────────────────────────────────────────────────────────────────────────────────────────
  // Follow pins to the tail only while the user is at the bottom and no search is being navigated; scrolling up
  // releases it (the "jump to tail" chip re-arms it).
  const searching = search.query.length > 0;
  useLayoutEffect(() => {
    if (parity || !follow || paused || searching || !atBottom || count === 0) return;
    virtualizer.scrollToIndex(count - 1, { align: "end" });
    // version is the append signal; count covers filter changes.
  }, [version, count, follow, paused, parity, searching, atBottom, virtualizer]);

  // Stepping to a match scrolls that line into view.
  useEffect(() => {
    if (activeMatch < 0 || activeMatch >= matches.length) return;
    const visible = visibleIndexOf(matches[activeMatch]!.line);
    if (visible >= 0 && visible < count) virtualizer.scrollToIndex(visible, { align: "center" });
  }, [activeMatch, matches, count, virtualizer, visibleIndexOf]);

  // "Jump to first error": scroll to the anchor line (re-fired by `n` so a second click re-centres).
  useEffect(() => {
    if (!jumpLine) return;
    const visible = visibleIndexOf(jumpLine.line);
    if (visible >= 0 && visible < count) {
      setAtBottom(false);
      virtualizer.scrollToIndex(visible, { align: "center" });
    }
  }, [jumpLine, count, virtualizer, visibleIndexOf]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAtBottom((prev) => (prev === near ? prev : near));
  }, []);

  const jumpToTail = useCallback(() => {
    setAtBottom(true);
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
  }, [count, virtualizer]);

  const renderAll = parity && count <= PARITY_MAX_ROWS;
  const total = virtualizer.getTotalSize();
  const items = renderAll ? Array.from({ length: count }, (_, i) => ({ index: i, start: i * LINE_HEIGHT })) : virtualizer.getVirtualItems();

  const showJump = follow && !atBottom && !renderAll;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the pane scrolls, so keyboard users need it focusable (axe scrollable-region-focusable).
        tabIndex={0}
        aria-label="Container log"
        data-yf="log.content"
        className="burrow-scroll h-full overflow-auto bg-well font-mono text-small leading-5"
      >
        <div style={{ height: renderAll ? count * LINE_HEIGHT : total, position: "relative" }}>
          {items.map((vi) => {
            const bufferIndex = bufferIndexOf(vi.index);
            const line = buffer.line(bufferIndex);
            return (
              <LineRow
                key={vi.index}
                index={vi.index}
                lineNo={buffer.dropped + bufferIndex + 1}
                line={line}
                level={detectLevel(line)}
                matches={byLine.get(bufferIndex) ?? EMPTY_MATCHES}
                activeMatch={activeMatch}
                wrap={wrap}
                timestamp={timestamp}
                tz={tz}
                previousStamp={timestamp === "relative" ? previousStamp(buffer, bufferIndex) : null}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: wrap ? "100%" : "max-content",
                  minWidth: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
                measureRef={wrap && !renderAll ? virtualizer.measureElement : undefined}
              />
            );
          })}
        </div>
      </div>

      {showJump && (
        <button
          type="button"
          onClick={jumpToTail}
          className="burrow-enter-pop absolute bottom-3 left-1/2 z-sticky inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-seam-strong bg-fabric-2 px-3 py-1 text-caption text-ink shadow-(--shadow-overlay) hover:bg-fabric-3"
        >
          <ArrowDownToLine className="size-3.5 text-live" aria-hidden="true" />
          Jump to tail
        </button>
      )}
    </div>
  );
}

function previousStamp(buffer: LineBuffer, index: number): TimestampReference | null {
  for (let i = index - 1, n = 0; i >= 0 && n < STAMP_LOOKBACK; i--, n++) {
    const t = detectTimestamp(buffer.line(i));
    if (t?.epoch != null) return `epoch:${t.epoch}`;
    if (t?.msOfDay != null) return `clock:${t.msOfDay}`;
  }
  return null;
}

interface RowProps {
  index: number;
  lineNo: number;
  line: string;
  level: LogLevel | null;
  matches: IndexedMatch[];
  activeMatch: number;
  wrap: boolean;
  timestamp: "absolute" | "relative";
  tz: TzMode;
  previousStamp: TimestampReference | null;
  style: React.CSSProperties;
  measureRef?: (el: Element | null) => void;
}

const LineRow = memo(function LineRow({
  index,
  line,
  lineNo,
  level,
  matches,
  activeMatch,
  wrap,
  timestamp,
  tz,
  previousStamp,
  style,
  measureRef,
}: RowProps) {
  const segments = useMemo(() => splitSegments(line, matches), [line, matches]);
  const stamp = useMemo(() => detectTimestamp(line), [line]);

  const stampLabel = useMemo(() => {
    if (!stamp) return "";
    if (timestamp === "absolute") {
      if (stamp.epoch == null) return stamp.text;
      const hms = fmtClock(stamp.epoch, tz);
      return `${hms}.${String(new Date(stamp.epoch).getUTCMilliseconds()).padStart(3, "0")}`;
    }
    const delta = relativeTimestampMs(stamp, previousStamp);
    return delta == null ? "—" : formatDelta(delta);
  }, [stamp, timestamp, previousStamp, tz]);

  return (
    <div
      data-index={index}
      ref={measureRef}
      style={style}
      data-line={lineNo}
      className={cn(
        "relative flex items-start gap-2 px-2",
        !wrap && "h-5 overflow-hidden whitespace-pre",
        wrap && "break-words whitespace-pre-wrap",
        level ? LEVEL_ROW[level] : "",
      )}
    >
      <span aria-hidden="true" className="w-[7ch] shrink-0 select-none text-right text-ink-4 tnum">
        {lineNo}
      </span>
      <span aria-hidden="true" className="hidden w-[13ch] shrink-0 select-none text-ink-4 tnum sm:inline">
        {stampLabel}
      </span>
      {level ? (
        <span aria-label={level} className={cn("w-[5ch] shrink-0 select-none font-semibold", LEVEL_TEXT[level])}>
          {level}
        </span>
      ) : (
        <span aria-hidden="true" className="w-[5ch] shrink-0 select-none" />
      )}
      <span className={cn(wrap ? "min-w-0 flex-1" : "min-w-max flex-none", level ? LEVEL_TEXT[level] : "text-ink-2")}>
        {segments.map((seg, i) =>
          seg.hit != null ? (
            <mark
              key={i}
              data-ansi-mark={seg.hit}
              data-active={seg.hit === activeMatch || undefined}
              className={seg.hit === activeMatch ? HIT_ACTIVE : HIT}
            >
              {seg.text}
            </mark>
          ) : (
            <span key={i} className={seg.cls}>
              {seg.text}
            </span>
          ),
        )}
      </span>
    </div>
  );
});
