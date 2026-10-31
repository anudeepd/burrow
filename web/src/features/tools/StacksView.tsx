/**
 * Server stacks — `/tools/stacks`. The modern replacement for the RM's legacy "Stack Trace" page.
 *
 * The payload is text/plain: the daemon's thread dump (167 KB, 230 threads on the reference cluster). It is not YARN JSON,
 * so no `Datum`/entity stamping applies (the parity contract covers structured YARN/Spark data; a thread dump is
 * daemon text). The page parses it with the pure parser in `./stacks`, summarises the state histogram, and renders a
 * virtualized monospace viewer: one collapsing row per thread, one row per frame.
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Layers, Minus, PanelRight, RotateCw } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tq } from "~/api/queries/tools";
import { CopyButton, PageHead, SearchField, Section, Stat } from "~/features/nodes/page";
import { cn } from "~/lib/cn";
import { fmtClock } from "~/lib/format";
import { revealDetail } from "~/lib/reveal";
import { useParity } from "~/state/parity";
import { usePref } from "~/state/prefs";
import { Button } from "~/ui/button";
import { ROW_HEIGHT } from "~/ui/data-table/data-table";
import { CenteredPageState, EmptyState, ErrorState, StaleErrorBanner, TableSkeleton } from "~/ui/feedback";
import { ScrollBottomFade, useHasMoreBelow } from "~/ui/scroll-bottom-fade";
import { HighlightedText } from "./highlighted-text";
import { handleTreeNavigationEvent } from "./tree-navigation";
import { type DumpThread, frameText, parseThreadDump, searchThreads, stateHistogram, THREAD_STATE_TONE, threadToText } from "./stacks";
import { OptionalTooltip } from "~/ui/tooltip";

const route = getRouteApi("/tools/stacks");

interface Row {
  kind: "thread" | "frame";
  thread: DumpThread;
  /** index into `thread.frames` for frame rows */
  frame?: number;
}

export function StacksView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const parity = useParity();
  const tz = usePref("tz");
  const rowH = ROW_HEIGHT;
  const frameH = Math.max(18, rowH - 6);

  const { data, error, isPending, isFetching, dataUpdatedAt, refetch } = useQuery(tq.stacks());
  const dump = useMemo(() => parseThreadDump(data ?? ""), [data]);

  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const stateFilter = search.state;
  const query = search.q ?? "";

  const byState = useMemo(() => {
    const threads = stateFilter ? dump.threads.filter((t) => (t.state || "UNKNOWN") === stateFilter) : dump.threads;
    return searchThreads(threads, query);
  }, [dump.threads, stateFilter, query]);

  const totals = useMemo(() => {
    let blocked = 0;
    let waited = 0;
    for (const t of byState) {
      blocked += t.thread.blocked;
      waited += t.thread.waited;
    }
    return { blocked, waited };
  }, [byState]);

  const histogram = useMemo(() => stateHistogram(dump.threads), [dump.threads]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const hit of byState) {
      const thread = hit.thread;
      out.push({ kind: "thread", thread });
      if (parity || expanded.has(thread.id) || hit.frames.length > 0) {
        for (let i = 0; i < thread.frames.length; i++) out.push({ kind: "frame", thread, frame: i });
      }
    }
    return out;
  }, [byState, expanded, parity]);

  // Deep link / selection expands the thread so its frames are visible.
  useEffect(() => {
    const id = search.thread === undefined ? null : Number(search.thread);
    if (id == null || !Number.isFinite(id)) return;
    setExpanded((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
  }, [search.thread]);

  const selected = useMemo(() => {
    if (search.thread === undefined) return null;
    const id = Number(search.thread);
    return dump.threads.find((t) => t.id === id) ?? null;
  }, [dump.threads, search.thread]);

  /* selecting a thread on a narrow screen should show the pane it opened, not leave it below the fold */
  useEffect(() => {
    if (selected) revealDetail();
  }, [selected]);

  const setSearch = useCallback(
    (patch: Record<string, string | undefined>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
    },
    [navigate],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const { visible: moreBelow, sync: syncScrollHint } = useHasMoreBelow(scrollRef, !isPending && !error);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "thread" ? rowH : frameH),
    overscan: 18,
    enabled: !parity,
  });
  useEffect(() => virt.measure(), [rowH, frameH, virt]);

  const [active, setActive] = useState(0);
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));
  const rowDomId = (i: number) => `stacks-row-${i}`;
  const [focusFrame, setFocusFrame] = useState<{ threadId: number; frame: number } | null>(null);

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const select = useCallback((thread: DumpThread) => setSearch({ thread: String(thread.id) }), [setSearch]);

  const move = useCallback(
    (next: number) => {
      const n = Math.max(0, Math.min(rows.length - 1, next));
      setActive(n);
      if (!parity) virt.scrollToIndex(n, { align: "auto" });
      else document.getElementById(rowDomId(n))?.scrollIntoView({ block: "nearest" });
    },
    [rows.length, parity, virt],
  );

  // A frame clicked in the details pane: open its thread, then scroll the viewer to it.
  useEffect(() => {
    if (!focusFrame) return;
    const at = rows.findIndex((r) => r.kind === "frame" && r.thread.id === focusFrame.threadId && r.frame === focusFrame.frame);
    if (at < 0) return;
    setFocusFrame(null);
    move(at);
  }, [focusFrame, rows, move]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (handleTreeNavigationEvent(e, scrollRef.current?.clientHeight ?? 400, rowH, activeIndex, rows.length, move)) return;
    if (e.target !== e.currentTarget) return;
    const row = rows[activeIndex];
    switch (e.key) {
      case "ArrowRight": {
        const open = row ? isThreadOpen(rows, activeIndex) : false;
        if (row && row.kind === "thread" && !open) toggle(row.thread.id);
        else move(activeIndex + 1);
        break;
      }
      case "ArrowLeft":
        if (row && isThreadOpen(rows, activeIndex) && !parity) toggle(row.thread.id);
        break;
      case " ":
        if (row?.kind === "thread") toggle(row.thread.id);
        break;
      case "Enter":
        if (row) select(row.thread);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const source = "ResourceManager";
  const activeThreads = dump.active ?? dump.threads.length;

  return (
    <div className="burrow-scroll burrow-page-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-6" data-burrow-stacks-root="1">
      <PageHead
        title="Server stacks"
        description="Inspect the ResourceManager thread dump to diagnose blocked or busy server threads."
        actions={
          <span className="flex items-center gap-2">
            <span className="text-small text-ink-3 tnum">
              {isFetching && dataUpdatedAt === 0 ? "reading…" : dataUpdatedAt > 0 ? `read ${fmtClock(dataUpdatedAt, tz)}` : ""}
            </span>
            <Button variant="quiet" size="sm" onClick={() => void refetch()}>
              <RotateCw className="size-3.5" aria-hidden="true" />
              Reload
            </Button>
          </span>
        }
      />

      {error && data !== undefined && (
        <StaleErrorBanner title="Could not refresh the thread dump" error={error} onRetry={() => void refetch()} />
      )}
      {error && data === undefined ? (
        <CenteredPageState>
          <ErrorState
            title="Cannot read the thread dump"
            message={error instanceof Error ? error.message : String(error)}
            hint="Burrow proxies /stacks from the active ResourceManager (text/plain, no pagination)."
            onRetry={() => void refetch()}
          />
        </CenteredPageState>
      ) : isPending ? (
        <TableSkeleton rows={16} cols={2} />
      ) : dump.threads.length === 0 ? (
        <EmptyState title="The daemon returned an empty dump">
          {source} answered {activeThreads} active threads but no parseable thread block. Reload in a moment — a JVM restart can produce a
          half-written dump.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            <Stat label="Active threads" value={activeThreads} sub={`${dump.threads.length} parsed`} />
            <Stat
              label="Thread states"
              value={histogram.length}
              sub={histogram.map((h) => `${h.state.toLowerCase()} ${h.count}`).join(" · ")}
            />
            <Stat
              label="Blocked total"
              value={totals.blocked}
              sub={stateFilter ? `within ${stateFilter}` : "sum of Blocked count"}
              tone={totals.blocked > 0 ? "warn" : undefined}
            />
            <Stat label="Waited total" value={totals.waited} sub={stateFilter ? `within ${stateFilter}` : "sum of Waited count"} />
          </div>

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Thread state filter">
            <button
              type="button"
              aria-pressed={!stateFilter}
              onClick={() => setSearch({ state: undefined })}
              className={cn(
                "inline-flex h-(--ctl-h) items-center gap-1.5 rounded-md border px-2.5 text-body",
                !stateFilter ? "border-seam-strong bg-fabric-3 text-ink" : "border-seam text-ink-3 hover:bg-fabric-3 hover:text-ink",
              )}
            >
              All states
              <span className="text-micro text-ink-4 tnum">{dump.threads.length}</span>
            </button>
            {histogram.map((h) => {
              const on = stateFilter === h.state;
              const tone = THREAD_STATE_TONE[h.state] ?? "idle";
              return (
                <button
                  key={h.state}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSearch({ state: on ? undefined : h.state })}
                  className={cn(
                    `burrow-tone-${tone}`,
                    "inline-flex h-(--ctl-h) items-center gap-1.5 rounded-md border px-2.5 text-body",
                    on ? "border-(--tone) bg-fabric-3 text-ink" : "border-seam text-ink-3 hover:bg-fabric-3 hover:text-ink",
                  )}
                >
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-(--tone)" />
                  <span className="font-mono text-small">{h.state}</span>
                  <span className="text-micro text-ink-4 tnum">{h.count}</span>
                </button>
              );
            })}
          </div>

          <div className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex shrink-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <SearchField
                  value={query}
                  onChange={(q) => setSearch({ q: q || undefined })}
                  label="Search threads and frames"
                  placeholder="thread name, class, method…"
                  className="w-full sm:w-80"
                />
                {query && (
                  <span className="text-small text-ink-3 tnum">
                    {byState.length} of {dump.threads.length} threads match
                  </span>
                )}
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => setExpanded(new Set(dump.threads.map((t) => t.id)))}
                  title="Show every frame"
                >
                  <Layers className="size-3.5" aria-hidden="true" /> Expand all
                </Button>
                <Button variant="quiet" size="sm" onClick={() => setExpanded(new Set())} title="Collapse every thread to one row">
                  <Minus className="size-3.5" aria-hidden="true" /> Contract
                </Button>
              </div>

              <div className="relative flex h-[min(32dvh,400px)] min-h-60 flex-col overflow-hidden rounded-lg border border-seam bg-fabric sm:h-[min(48dvh,640px)] sm:min-h-72 xl:h-[min(64dvh,calc(100dvh_-_22rem),640px)]">
                <div
                  ref={scrollRef}
                  role="tree"
                  tabIndex={0}
                  aria-label="Thread dump"
                  aria-activedescendant={rows.length > 0 ? rowDomId(activeIndex) : undefined}
                  onKeyDown={onKeyDown}
                  onScroll={syncScrollHint}
                  data-burrow-stacks-rows={rows.length}
                  className="burrow-scroll burrow-table-scroll relative min-h-0 flex-1 overflow-auto outline-none focus-visible:outline-offset-[-2px]"
                >
                  <div role="group" className="relative" style={parity ? undefined : { height: virt.getTotalSize() }}>
                    {(parity
                      ? rows.map((row, index) => ({ row, index, start: null as number | null }))
                      : virt
                          .getVirtualItems()
                          .map((v) => ({ row: rows[v.index] as Row | undefined, index: v.index, start: v.start as number | null }))
                    ).map(({ row, index, start }) =>
                      row ? (
                        <StackRow
                          key={row.kind === "thread" ? `t-${row.thread.id}` : `f-${row.thread.id}-${row.frame}`}
                          row={row}
                          index={index}
                          height={row.kind === "thread" ? rowH : frameH}
                          offset={start}
                          query={query}
                          open={isThreadOpen(rows, index)}
                          selected={selected?.id === row.thread.id}
                          active={index === activeIndex}
                          domId={rowDomId(index)}
                          onToggle={() => toggle(row.thread.id)}
                          onSelect={() => select(row.thread)}
                        />
                      ) : null,
                    )}
                  </div>
                  {rows.length === 0 && <p className="p-6 text-center text-body text-ink-3">No thread or frame matches this filter.</p>}
                </div>
                <ScrollBottomFade visible={moreBelow} />
                <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-seam bg-fabric-2 px-3 text-small text-ink-3">
                  <span className="tnum">
                    {byState.length} threads · {rows.length.toLocaleString("en-US")} rows
                    {stateFilter && ` · filtered to ${stateFilter}`}
                  </span>
                  <span className="hidden text-micro text-ink-4 md:inline">↑↓ move · →← expand/collapse · Enter select · Space toggle</span>
                </div>
              </div>
            </div>

            <StackDetails
              thread={selected}
              onSelectFrame={(index) => {
                if (!selected) return;
                setExpanded((prev) => new Set([...prev, selected.id]));
                setFocusFrame({ threadId: selected.id, frame: index });
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** In this row model a thread row is open exactly when the next row is one of its frames. */
function isThreadOpen(rows: Row[], index: number): boolean {
  const row = rows[index];
  const next = rows[index + 1];
  return !!row && row.kind === "thread" && !!next && next.kind === "frame" && next.thread.id === row.thread.id;
}

interface StackRowProps {
  row: Row;
  index: number;
  height: number;
  offset: number | null;
  query: string;
  open: boolean;
  selected: boolean;
  active: boolean;
  domId: string;
  onToggle: () => void;
  onSelect: () => void;
}

function StackRow({ row, index, height, offset, query, open, selected, active, domId, onToggle, onSelect }: StackRowProps) {
  const style: CSSProperties = { height, ...(offset == null ? {} : { transform: `translateY(${offset}px)` }) };
  return (
    <div
      role="treeitem"
      id={domId}
      tabIndex={-1}
      aria-level={row.kind === "thread" ? 1 : 2}
      aria-expanded={row.kind === "thread" ? open : undefined}
      aria-selected={selected}
      data-active={active}
      data-selected={selected}
      data-kind={row.kind}
      data-index={index}
      className={cn(
        "flex items-center gap-1.5 border-b border-seam-soft pr-2 text-cell hover:bg-fabric-3",
        selected && "bg-live/10",
        active && !selected && "bg-fabric-2",
        offset == null ? "relative" : "absolute left-0 right-0",
      )}
      style={style}
      onClick={onSelect}
      onDoubleClick={row.kind === "thread" ? onToggle : undefined}
    >
      {row.kind === "thread" ? (
        <ThreadRowBody row={row} query={query} open={open} onToggle={onToggle} />
      ) : (
        <FrameRowBody row={row} query={query} />
      )}
    </div>
  );
}

function ThreadRowBody({ row, query, open, onToggle }: { row: Row; query: string; open: boolean; onToggle: () => void }) {
  const tone = THREAD_STATE_TONE[row.thread.state] ?? "idle";
  return (
    <>
      <OptionalTooltip label={`${open ? "Collapse" : "Expand"} thread ${row.thread.name}`}>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="ml-1 grid size-4 shrink-0 place-items-center rounded-sm text-ink-3 hover:bg-fabric-2 hover:text-ink"
        >
          <ChevronRight className={cn("size-3.5 transition-transform duration-(--dur-fast) ease-(--ease-out)", open && "rotate-90")} />
        </button>
      </OptionalTooltip>
      <span className="shrink-0 text-micro text-ink-4 tnum">#{row.thread.id}</span>
      <OptionalTooltip label={row.thread.name}>
        <span className="min-w-0 flex-1 truncate font-medium text-ink">
          <HighlightedText text={row.thread.name} query={query} />
        </span>
      </OptionalTooltip>
      {row.thread.waitingOn && (
        <span className="hidden max-w-[16rem] shrink-0 truncate font-mono text-micro text-ink-4 lg:inline">
          waiting on {row.thread.waitingOn}
        </span>
      )}
      <span className={cn("burrow-pill shrink-0 rounded-full px-1.5 text-micro", `burrow-tone-${tone}`)}>
        {row.thread.state || "UNKNOWN"}
      </span>
      <span className="shrink-0 text-micro text-ink-4 tnum">{row.thread.frames.length} frames</span>
      <span className="hidden shrink-0 text-micro text-ink-4 tnum sm:inline">blocked {row.thread.blocked}</span>
      <span className="hidden shrink-0 text-micro text-ink-4 tnum sm:inline">waited {row.thread.waited}</span>
    </>
  );
}

function FrameRowBody({ row, query }: { row: Row; query: string }) {
  const frame = row.frame != null ? row.thread.frames[row.frame] : undefined;
  if (!frame) return null;
  return (
    <>
      <span className="w-4 shrink-0" />
      <span className="shrink-0 text-micro text-ink-4 tnum" style={{ width: 24 }}>
        {row.frame}
      </span>
      <OptionalTooltip label={frameText(frame)}>
        <span className="min-w-0 flex-1 truncate font-mono text-small text-ink-2">
          <HighlightedText text={frame.className} query={query} />
          <span className="text-ink-4">.</span>
          <HighlightedText text={frame.method} query={query} />
          <span className="text-ink-4">
            {frame.native ? "(Native Method)" : frame.line != null ? `(${frame.file}:${frame.line})` : frame.file ? `(${frame.file})` : ""}
          </span>
        </span>
      </OptionalTooltip>
      {frame.module && <span className="hidden shrink-0 font-mono text-micro text-ink-4 md:inline">{frame.module}</span>}
    </>
  );
}

function StackDetails({ thread, onSelectFrame }: { thread: DumpThread | null; onSelectFrame: (index: number) => void }) {
  if (!thread) {
    return (
      <aside className="flex flex-col gap-2 rounded-lg border border-dashed border-seam-strong bg-well p-3 text-body text-ink-3">
        <p className="flex items-center gap-2 font-medium text-ink-2">
          <PanelRight className="size-4" aria-hidden="true" /> Details
        </p>
        <p>Select a thread to read its frames, its lock and a copyable dump block.</p>
        <p className="text-micro text-ink-4">The selection is part of the URL (?thread=…), so it can be shared.</p>
      </aside>
    );
  }
  const tone = THREAD_STATE_TONE[thread.state] ?? "idle";
  return (
    <aside data-burrow-detail="1" className="flex flex-col gap-3 rounded-lg border border-seam bg-fabric p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-micro uppercase tracking-wide text-ink-4">Thread #{thread.id}</p>
          <h2 className="break-all font-mono text-small text-ink">{thread.name}</h2>
        </div>
        <CopyButton value={threadToText(thread)} label="Copy this thread dump" />
      </header>

      <Section title="Thread" className="gap-1.5">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-small">
          <dt className="text-micro uppercase tracking-wide text-ink-4">State</dt>
          <dd>
            <span className={cn("burrow-pill rounded-full px-1.5 text-micro", `burrow-tone-${tone}`)}>{thread.state || "UNKNOWN"}</span>
          </dd>
          <dt className="text-micro uppercase tracking-wide text-ink-4">Blocked</dt>
          <dd className="text-ink-2 tnum">{thread.blocked}</dd>
          <dt className="text-micro uppercase tracking-wide text-ink-4">Waited</dt>
          <dd className="text-ink-2 tnum">{thread.waited}</dd>
          <dt className="text-micro uppercase tracking-wide text-ink-4">Frames</dt>
          <dd className="text-ink-2 tnum">{thread.frames.length}</dd>
        </dl>
        {thread.waitingOn && <p className="break-all font-mono text-micro text-ink-3">waiting on {thread.waitingOn}</p>}
        {thread.locks.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-micro text-ink-3">
            {thread.locks.map((lock) => (
              <li key={lock} className="break-all font-mono">
                locked {lock}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={`Frames (${thread.frames.length})`}
        className="min-h-0 flex-1"
        actions={<CopyButton value={thread.frames.map(frameText).join("\n")} label="Copy frames" />}
      >
        <ol className="burrow-scroll min-h-0 flex-1 overflow-auto rounded-md border border-seam-soft">
          {thread.frames.map((frame, i) => (
            <li key={`${frame.raw}-${i}`}>
              <button
                type="button"
                onClick={() => onSelectFrame(i)}
                className="flex w-full items-start gap-2 border-b border-seam-soft px-2 py-1 text-left hover:bg-fabric-3"
              >
                <span className="shrink-0 text-micro text-ink-4 tnum">{i}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-micro text-ink-2">{frameText(frame)}</span>
              </button>
            </li>
          ))}
          {thread.frames.length === 0 && <li className="px-2 py-2 text-small text-ink-3">This thread has no stack frames.</li>}
        </ol>
      </Section>
    </aside>
  );
}
