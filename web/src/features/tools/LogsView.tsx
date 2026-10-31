/**
 * `/tools/logs` — the daemon's own log files (legacy "Tools → Local logs").
 *
 * The directory listing drives a byte-addressed viewer: one window of `LOG_PAGE_BYTES` at a time, prev/next/jump-to-end,
 * an optional tail that follows a growing file, and an in-window search that marks matches in the ANSI-rendered text.
 * `file`, `offset`, `len`, `tail` and `q` live in the URL; the sort of the file list is local (it is two rows, and the
 * schema has no `sort` param for it).
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  Download,
  FileText,
  Folder,
  Radio,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LOG_PAGE_BYTES, tq } from "~/api/queries/tools";
import { fmtBytes, fmtEpoch } from "~/lib/format";
import { useParity } from "~/state/parity";
import { usePref } from "~/state/prefs";
import { ACTION_LINK_CLASS, Button } from "~/ui/button";
import { Datum, Entity } from "~/ui/datum";
import { CenteredPageState, EmptyState, ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { SearchField, Section, Unavailable } from "~/features/nodes/page";
import { useLogSearchHotkey } from "~/features/logs/use-log-search-hotkey";
import { Select } from "~/ui/select";
import { StatusDot } from "~/ui/status";
import { Toggle } from "~/ui/toggles";
import { Tooltip, OptionalTooltip } from "~/ui/tooltip";
import { Ansi, segmentAnsi, parseAnsi } from "./Ansi";
import {
  byteRangeLabel,
  fetchLogChunk,
  isEndpointMissing,
  lastPageOffset,
  logFileHref,
  logPage,
  type LogSortKey,
  sortLogFiles,
} from "./logs";

const route = getRouteApi("/tools/logs");

const PAGE_SIZES = [32, 128, 256, 512] as const;

function SplitDateTime({ value }: { value: string }) {
  const comma = value.lastIndexOf(", ");
  const split = comma >= 0 ? comma : value.lastIndexOf(" ");
  if (split < 0) return value;
  const date = value.slice(0, split + (comma >= 0 ? 1 : 0));
  const time = value.slice(split + (comma >= 0 ? 2 : 1));
  return (
    <>
      <span className="block">{date}</span> <span className="block">{time}</span>
    </>
  );
}

function SortHeader({
  label,
  k,
  sortKey,
  sortDesc,
  onSort,
  className,
}: {
  label: string;
  k: LogSortKey;
  sortKey: LogSortKey;
  sortDesc: boolean;
  onSort: (k: LogSortKey) => void;
  className?: string;
}) {
  const active = sortKey === k;
  return (
    <th
      scope="col"
      aria-sort={active ? (sortDesc ? "descending" : "ascending") : "none"}
      className={`px-3 py-1 font-medium text-ink-4 ${className ?? "text-left"}`}
    >
      <OptionalTooltip label={`Sort by ${label}`}>
        <button type="button" onClick={() => onSort(k)} className="inline-flex items-center gap-1 hover:text-ink">
          {label}
          {active &&
            (sortDesc ? (
              <ChevronDown className="size-3 text-live" aria-hidden="true" />
            ) : (
              <ChevronUp className="size-3 text-live" aria-hidden="true" />
            ))}
        </button>
      </OptionalTooltip>
    </th>
  );
}

export function LogsView() {
  useLogSearchHotkey();

  const search = route.useSearch();
  const navigate = route.useNavigate();
  const parity = useParity();
  const paused = usePref("livePaused");
  const liveIntervalMs = usePref("liveIntervalMs");
  const tz = usePref("tz");

  const tail = !!search.tail;
  const pageBytes = search.len ?? LOG_PAGE_BYTES;

  const [sortKey, setSortKey] = useState<LogSortKey>("lastModified");
  const [sortDesc, setSortDesc] = useState(true);

  const setSearch = (patch: Partial<typeof search>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  };

  // The listing is the file table; in tail mode it must refresh at the live cadence too, because it is what makes the
  // window follow a growing file.
  const listingOpts = tq.logs();
  const listing = useQuery({
    ...listingOpts,
    refetchInterval: tail && !paused && !parity ? liveIntervalMs : listingOpts.refetchInterval,
  });
  const files = useMemo(() => (listing.data ? sortLogFiles(listing.data, sortKey, sortDesc) : []), [listing.data, sortKey, sortDesc]);

  const selected = files.find((f) => f.name === search.file && !f.isDir) ?? null;

  // No file in the URL: land on the most recent one (replace, so Back does not bounce through an empty view).
  useEffect(() => {
    if (search.file || files.length === 0) return;
    const first = files.find((f) => !f.isDir) ?? files[0];
    if (first) void navigate({ search: (prev) => ({ ...prev, file: first.name, offset: undefined }), replace: true });
  }, [search.file, files, navigate]);

  const size = selected?.size ?? 0;
  const requestedOffset = tail ? lastPageOffset(size, pageBytes) : (search.offset ?? 0);
  const page = useMemo(() => logPage(size, requestedOffset, pageBytes), [size, requestedOffset, pageBytes]);

  const chunk = useQuery({
    queryKey: ["tools", "logs", "chunk", selected?.name ?? "", page.offset, page.length],
    queryFn: ({ signal }) => fetchLogChunk(selected?.name ?? "", { offset: page.offset, length: page.length, size }, signal),
    meta: { refetchKind: "live" },
    enabled: !!selected,
    retry: false,
    refetchInterval: tail && !paused && !parity ? liveIntervalMs : false,
    // Keep the previous window while the next one loads, so paging does not flash an empty viewer.
    placeholderData: (prev) => prev,
  });

  const text = chunk.data?.text ?? "";
  const { segments, hits } = useMemo(() => segmentAnsi(parseAnsi(text), search.q ?? ""), [text, search.q]);

  const [activeHit, setActiveHit] = useState(0);
  // A new search starts at its first match; a tail refresh must not yank the user back to the top.
  useEffect(() => setActiveHit(0), [search.q]);
  const hitIndex = hits > 0 ? Math.min(activeHit, hits - 1) : 0;

  const scrollRef = useRef<HTMLPreElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Tail: stay pinned to the end. Never in parity mode (the DOM must be identical on every screenshot), and never while
  // the user is stepping through matches.
  useEffect(() => {
    if (!tail || parity || paused || search.q) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail, parity, paused, search.q, text]);

  // Stepping to a match scrolls it into view inside the window.
  useEffect(() => {
    if (!search.q || hits === 0) return;
    const mark = bodyRef.current?.querySelector<HTMLElement>(`[data-ansi-mark="${hitIndex}"]`);
    if (mark && typeof mark.scrollIntoView === "function") mark.scrollIntoView({ block: "center", inline: "nearest" });
  }, [search.q, hitIndex, hits, segments]);

  const step = useCallback(
    (delta: number) => {
      if (hits === 0) return;
      setActiveHit((i) => (Math.min(i, hits - 1) + delta + hits) % hits);
    },
    [hits],
  );

  const toggleSort = (k: LogSortKey) => {
    if (k === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(k);
      setSortDesc(k !== "name");
    }
  };

  const error = listing.error;
  const missing = isEndpointMissing(error);

  return (
    <div className="burrow-scroll burrow-page-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-6 lg:overflow-hidden">
      <PageHeadFor
        tail={tail}
        paused={paused}
        onTail={(v) => setSearch(v ? { tail: true, offset: undefined } : { tail: undefined })}
        onReload={() => void listing.refetch()}
      />

      {missing && listing.data === undefined ? (
        <CenteredPageState>
          <Unavailable
            title="This Burrow backend does not expose local logs"
            reason={
              <>
                <code>GET /api/rm/logs</code> answered <code>404</code>, so this backend cannot list the ResourceManager's local log files.
                Use a Burrow build that includes the ResourceManager log routes.
              </>
            }
            hint="If this is unexpected, check the Burrow server version and retry after restarting it."
          />
        </CenteredPageState>
      ) : error && listing.data === undefined ? (
        <CenteredPageState>
          <ErrorState
            title="Cannot read the daemon's log directory"
            message={error instanceof Error ? error.message : String(error)}
            hint="Burrow requests the ResourceManager directory at /api/rm/logs. Check that the configured ResourceManager is reachable and serves its /logs/ directory."
            onRetry={() => void listing.refetch()}
          />
        </CenteredPageState>
      ) : (
        <>
          {error && (
            <StaleErrorBanner title="Could not refresh the daemon log directory" error={error} onRetry={() => void listing.refetch()} />
          )}
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[24rem_minmax(0,1fr)]">
            <section aria-labelledby="log-files-heading" className="flex min-w-0 flex-col lg:min-h-0">
              <div className="flex flex-col overflow-hidden rounded-lg border border-seam bg-fabric lg:min-h-0 lg:flex-1">
                <h2
                  id="log-files-heading"
                  className="shrink-0 border-b border-seam bg-fabric-2 px-3 py-1.5 text-small font-medium text-ink-2"
                >
                  Files
                </h2>
                <div className="burrow-scroll burrow-table-scroll max-h-52 overflow-auto lg:max-h-none lg:min-h-0 lg:flex-1">
                  {listing.isPending ? (
                    <div className="flex flex-col gap-2 p-2">
                      {["a", "b", "c"].map((k) => (
                        <Skeleton key={k} className="h-4" />
                      ))}
                    </div>
                  ) : files.length === 0 ? (
                    <EmptyState title="No log files">The daemon's log directory is empty.</EmptyState>
                  ) : (
                    <table className="w-full table-fixed border-collapse text-body">
                      <caption className="sr-only">Log files in the daemon's log directory</caption>
                      <thead className="sticky top-0 z-sticky border-b border-seam text-micro text-ink-4">
                        <tr>
                          <SortHeader
                            label="Name"
                            k="name"
                            sortKey={sortKey}
                            sortDesc={sortDesc}
                            onSort={toggleSort}
                            className="w-[54%] text-left"
                          />
                          <SortHeader
                            label="Size"
                            k="size"
                            sortKey={sortKey}
                            sortDesc={sortDesc}
                            onSort={toggleSort}
                            className="w-[18%] text-right"
                          />
                          <SortHeader
                            label="Modified"
                            k="lastModified"
                            sortKey={sortKey}
                            sortDesc={sortDesc}
                            onSort={toggleSort}
                            className="w-[28%] text-left"
                          />
                        </tr>
                      </thead>
                      <tbody>
                        {files.map((f) => (
                          <Entity
                            key={f.name}
                            id={f.name}
                            as="tr"
                            data-selected={f.name === search.file || undefined}
                            className="burrow-row cursor-pointer border-b border-seam-soft last:border-0"
                            onClick={() => !f.isDir && setSearch({ file: f.name, offset: undefined })}
                          >
                            <td className="max-w-0 px-3 py-1.5">
                              <span className="flex min-w-0 items-center gap-1.5">
                                {f.isDir ? (
                                  <Folder className="size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
                                ) : (
                                  <FileText className="size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
                                )}
                                <Tooltip label={f.name}>
                                  <Datum
                                    field="log.name"
                                    raw={f.name}
                                    fmt="text"
                                    className="min-w-0 flex-1 truncate font-mono text-caption text-ink"
                                  >
                                    {f.isDir ? (
                                      f.name
                                    ) : (
                                      <button
                                        type="button"
                                        className="block w-full min-w-0 truncate text-left hover:text-live"
                                        onClick={() => setSearch({ file: f.name, offset: undefined })}
                                      >
                                        {f.name}
                                      </button>
                                    )}
                                  </Datum>
                                </Tooltip>
                                <Datum field="log.isDir" raw={f.isDir} fmt="text" className="sr-only" />
                              </span>
                            </td>
                            <td className="w-[18%] whitespace-nowrap px-3 py-1.5 text-right">
                              <Datum field="log.size" raw={f.size} fmt="bytes" className="tnum text-caption text-ink-2" />
                            </td>
                            <td className="w-[28%] px-3 py-1.5">
                              {/* An epoch is preferred; when the listing only carries the daemon's own date string, that string is
                              shown verbatim (parsed epochs and printed dates are different kinds of fact). */}
                              {f.lastModified !== null ? (
                                <Datum field="log.lastModified" raw={f.lastModified} fmt="epoch" className="tnum text-caption text-ink-2">
                                  <SplitDateTime value={fmtEpoch(f.lastModified, tz)} />
                                </Datum>
                              ) : f.modifiedText ? (
                                <Datum field="log.modified" raw={f.modifiedText} fmt="text" className="text-caption text-ink-2">
                                  <SplitDateTime value={f.modifiedText} />
                                </Datum>
                              ) : (
                                <Datum field="log.lastModified" raw={null} fmt="epoch" className="text-caption text-ink-4" />
                              )}
                            </td>
                          </Entity>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </section>

            <Section
              className="min-w-0 lg:min-h-0"
              title={<h2 className="min-w-0 truncate font-mono text-small font-medium text-ink">{selected?.name ?? "No file selected"}</h2>}
              actions={
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Previous page"
                    title="Previous page"
                    disabled={page.prev === null || tail}
                    onClick={() => setSearch({ offset: page.prev ?? 0 })}
                  >
                    <ChevronLeft className="size-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Next page"
                    title="Next page"
                    disabled={page.next === null || tail}
                    onClick={() => setSearch({ offset: page.next ?? 0 })}
                  >
                    <ChevronRight className="size-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Jump to the start of the file"
                    title="Jump to the start"
                    onClick={() => setSearch({ offset: 0, tail: undefined })}
                  >
                    <ChevronsLeft className="size-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Jump to the end of the file"
                    title="Jump to the end"
                    onClick={() => setSearch({ offset: page.last, tail: undefined })}
                  >
                    <ChevronsRight className="size-3.5" aria-hidden="true" />
                  </Button>
                  {selected && (
                    <OptionalTooltip label={`Download ${selected.name}`}>
                      <a href={logFileHref(selected.name)} download={selected.name} className={ACTION_LINK_CLASS}>
                        <Download className="size-3.5" aria-hidden="true" />
                        Download
                      </a>
                    </OptionalTooltip>
                  )}
                </div>
              }
            >
              {chunk.data && (
                <div className="flex min-w-0 items-center gap-1.5 text-small text-ink-3">
                  <span className="truncate tnum">{byteRangeLabel(chunk.data)}</span>
                  {chunk.data.derived && (
                    <Tooltip label="This endpoint sent no x-burrow-log-* headers, so the range is exactly what Burrow asked for.">
                      <span className="shrink-0 rounded-full border border-seam-strong px-1.5 text-micro text-ink-4">derived range</span>
                    </Tooltip>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {tail && (
                  <span className="flex items-center gap-1.5 text-micro text-ink-3">
                    <StatusDot domain="service" state={paused ? "unconfigured" : "reachable"} label={false} />
                    {parity
                      ? "parity: not following"
                      : paused
                        ? "live paused — not following"
                        : `following every ${Math.round(liveIntervalMs / 1000)}s`}
                  </span>
                )}
                <Select
                  label="Bytes per page"
                  value={String(Math.round(pageBytes / 1024))}
                  onValueChange={(v) => setSearch({ len: v ? Number(v) * 1024 : undefined, offset: undefined })}
                  options={PAGE_SIZES.map((kib) => ({ value: String(kib), label: `${kib} KiB per page` }))}
                  className="w-40"
                />
                <div className="flex min-w-0 flex-1 items-center gap-2" data-burrow-log-search>
                  <SearchField
                    value={search.q ?? ""}
                    onChange={(q) => setSearch({ q: q || undefined })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
                      event.preventDefault();
                      step(event.shiftKey ? -1 : 1);
                    }}
                    label="Search inside this window"
                    placeholder="search this window… (Enter = next)"
                    className="w-full sm:w-64"
                  />
                  {search.q && (
                    <span className="flex items-center gap-1" aria-live="polite">
                      <span className="text-small text-ink-3 tnum">{hits === 0 ? "no match" : `${hitIndex + 1} / ${hits}`}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Previous match"
                        title="Previous match (Shift+Enter)"
                        disabled={hits === 0}
                        onClick={() => step(-1)}
                      >
                        <ChevronUp className="size-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Next match"
                        title="Next match (Enter)"
                        disabled={hits === 0}
                        onClick={() => step(1)}
                      >
                        <ChevronDown className="size-3.5" aria-hidden="true" />
                      </Button>
                    </span>
                  )}
                </div>
                {hits === 0 && search.q && (
                  <span className="text-micro text-ink-4">searches only the {fmtBytes(text.length)} window that is loaded</span>
                )}
              </div>

              {chunk.error && (!chunk.data || chunk.isPlaceholderData) ? (
                <ErrorState
                  title={`Cannot read ${selected?.name ?? "that file"}`}
                  message={chunk.error instanceof Error ? chunk.error.message : String(chunk.error)}
                  hint="Burrow streams a byte range from the daemon's own log directory."
                  onRetry={() => void chunk.refetch()}
                />
              ) : listing.isPending || (chunk.isPending && !!selected) ? (
                <div className="flex min-h-[18rem] flex-col gap-2 rounded-lg border border-seam bg-well p-3">
                  {["1", "2", "3", "4", "5", "6"].map((k) => (
                    <Skeleton key={k} className="h-3 w-4/5" />
                  ))}
                </div>
              ) : !selected ? (
                <EmptyState title="No file selected">Pick a log file on the left to page through it by byte range.</EmptyState>
              ) : (
                <>
                  {chunk.error && (
                    <StaleErrorBanner
                      title={`Could not refresh ${selected.name}`}
                      error={chunk.error}
                      onRetry={() => void chunk.refetch()}
                    />
                  )}
                  {/* Reading path for keyboard users is the byte-range pager and match stepper; the pane is a log region. */}
                  <pre
                    ref={scrollRef}
                    role="log"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: the pane scrolls, so keyboard users need it focusable (axe scrollable-region-focusable).
                    tabIndex={0} //NOSONAR -- required for keyboard scrolling in Safari
                    aria-live="off"
                    aria-label={`${selected.name}, ${chunk.data ? byteRangeLabel(chunk.data) : "loading"}`}
                    aria-busy={chunk.isFetching || undefined}
                    className="burrow-scroll h-[min(34dvh,18rem)] min-h-56 shrink-0 overflow-auto rounded-lg border border-seam bg-well p-2 font-mono text-small break-words whitespace-pre-wrap text-ink lg:h-auto lg:min-h-[18rem] lg:flex-1 lg:shrink"
                  >
                    <div ref={bodyRef}>
                      <Ansi segments={segments} activeHit={search.q ? hitIndex : undefined} />
                    </div>
                  </pre>
                </>
              )}

              {!search.q && !tail && page.next !== null && (
                <p className="flex items-center gap-1.5 text-micro text-ink-4">
                  <ArrowDownToLine className="size-3" aria-hidden="true" />
                  Only the loaded window is searched. {fmtBytes(Math.max(0, size - page.end))} more bytes are below.
                </p>
              )}
            </Section>
          </div>
        </>
      )}
    </div>
  );
}

/** Page head is split out only to keep the JSX above readable; it owns the tail switch. */
function PageHeadFor({
  tail,
  paused,
  onTail,
  onReload,
}: {
  tail: boolean;
  paused: boolean;
  onTail: (v: boolean) => void;
  onReload: () => void;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-seam pb-3">
      <div className="min-w-0">
        <h1 className="text-h1 font-semibold text-ink text-balance">Local logs</h1>
        <p className="mt-1 max-w-3xl text-pretty text-body text-ink-3">Browse and follow log files written by the ResourceManager.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Toggle pressed={tail} onPressedChange={onTail} label="Follow new bytes to the end of the file">
          <Radio className="size-3" aria-hidden="true" />
          {paused && tail ? "tail (paused)" : "tail"}
        </Toggle>
        <Button variant="quiet" size="sm" onClick={onReload}>
          <RotateCw className="size-3.5" aria-hidden="true" />
          Reload
        </Button>
      </div>
    </header>
  );
}
