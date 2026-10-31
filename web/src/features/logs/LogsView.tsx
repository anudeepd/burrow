/**
 * `/apps/$appId/logs` — the container-log viewer.
 *
 * Composes: URL state → the file list and the initial byte window → a `LineBuffer` (byte-exact, resumable) → the
 * virtualized renderer, with live follow on top. Every source failure is rendered as an explicit "unavailable + why"
 * state; nothing is ever fabricated.
 *
 * Data flow note: the initial window is fetched with TanStack Query (so loading/error/retry come for free) and then
 * pushed into an imperative `LineBuffer`. The buffer, not the query cache, is the source of truth for the viewer,
 * because follow mutates it byte-by-byte from SSE — the query cache has no way to express "these 4 KB arrived".
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LOG_MAX_BYTES,
  LOG_WINDOW_BYTES,
  type LogHints,
  downloadLogFile,
  fetchLogWindow,
  isLogEndpointMissing,
  lq,
  orderLogFiles,
} from "~/api/queries/logs";
import { Entity } from "~/ui/datum";
import { ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { Unavailable } from "~/features/nodes/page";
import { useParity } from "~/state/parity";
import { usePref } from "~/state/prefs";
import { ContainerPicker } from "./ContainerPicker";
import { LineViewer } from "./LineViewer";
import { LogStatusBar } from "./LogStatusBar";
import { LogToolbar } from "./LogToolbar";
import {
  LineBuffer,
  type LogLevel,
  type Match,
  type SearchSpec,
  firstErrorLine,
  isBadRegex,
  parseLevelFilter,
  scanMatchesAsync,
  stepMatch,
} from "./model";
import { followEnabled, tailBytes, timestampMode } from "./search";
import { useFilteredIndex } from "./use-filtered";
import { useFollow } from "./use-follow";

const route = getRouteApi("/apps/$appId/logs");

export function LogsView() {
  const { appId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const parity = useParity();
  const paused = usePref("livePaused");
  const liveIntervalMs = usePref("liveIntervalMs");

  const containerId = search.container ?? null;
  const file = search.file ?? null;
  const hints = useMemo<LogHints>(
    () => ({ node: search.node ?? null, user: search.user ?? null, app: search.app ?? appId }),
    [search.node, search.user, search.app, appId],
  );

  const setSearch = useCallback(
    (patch: Record<string, unknown>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
    },
    [navigate],
  );

  // ── buffer + render signal ──────────────────────────────────────────────────────────────────────────────────────
  const bufferRef = useRef<LineBuffer | null>(null);
  if (bufferRef.current === null) bufferRef.current = new LineBuffer();
  const buffer = bufferRef.current;
  const bufferTargetRef = useRef({ containerId, file });
  const hasDisplayedWindow =
    bufferTargetRef.current.containerId === containerId && bufferTargetRef.current.file === file && buffer.length > 0;
  const [version, setVersion] = useState(0);
  const rafPending = useRef(false);
  // Streaming can deliver many chunks per frame; coalesce them into one render.
  const bump = useCallback(() => {
    if (rafPending.current) return;
    rafPending.current = true;
    const run = () => {
      rafPending.current = false;
      setVersion((v) => v + 1);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }, []);

  // ── file list ───────────────────────────────────────────────────────────────────────────────────────────────────
  const filesQuery = useQuery({ ...lq.files(containerId ?? "", hints), enabled: !!containerId });
  const files = useMemo(() => (filesQuery.data ? orderLogFiles(filesQuery.data.files) : []), [filesQuery.data]);

  // Land on the most interesting file (stdout, then stderr) unless the URL names one.
  useEffect(() => {
    if (!containerId || file || files.length === 0) return;
    setSearch({ file: files[0]!.name });
  }, [containerId, file, files, setSearch]);

  // ── initial window ──────────────────────────────────────────────────────────────────────────────────────────────
  const tail = tailBytes(search.tail);
  const initial = useQuery({
    queryKey: ["logs", "window", containerId, file, tail ?? 0, search.node ?? "", search.user ?? "", search.app ?? ""],
    queryFn: async ({ signal }) => {
      if (tail == null) return fetchLogWindow(containerId!, file!, { offset: 0, length: LOG_WINDOW_BYTES, hints }, signal);
      try {
        return await fetchLogWindow(containerId!, file!, { tail, hints }, signal);
      } catch (error) {
        // Some log gateways reject `tail=` even though ordinary ranged reads work. The file listing gives us the
        // end offset needed to fetch the same window without hiding the already loaded lines.
        const size = files.find((entry) => entry.name === file)?.size;
        if (size == null || signal.aborted) throw error;
        const length = Math.min(tail, LOG_MAX_BYTES);
        return fetchLogWindow(containerId!, file!, { offset: Math.max(0, size - length), length, hints }, signal);
      }
    },
    enabled: !!containerId && !!file && filesQuery.isSuccess,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: 0,
  });

  const [meta, setMeta] = useState<{ size: number; source: string | null; start: number; end: number } | null>(null);

  // A new container/file starts a new buffer (the old file's bytes must never linger).
  useEffect(() => {
    buffer.reset();
    bufferTargetRef.current = { containerId, file };
    setMeta(null);
    bump();
  }, [containerId, file, buffer, bump]);

  useEffect(() => {
    if (!initial.data) return;
    buffer.setWindow(initial.data.text, initial.data.start);
    setMeta({ size: initial.data.size, source: initial.data.source, start: initial.data.start, end: initial.data.end });
    bump();
  }, [initial.data, buffer, bump]);

  // ── follow ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const follow = followEnabled(search) && !parity;
  const { status: followStatus, retry } = useFollow({
    enabled: follow && hasDisplayedWindow && !initial.isPending && !!file && !!containerId,
    paused,
    intervalMs: liveIntervalMs,
    containerId,
    name: file,
    hints,
    buffer,
    onAppend: bump,
    onEnded: bump,
  });

  // ── search ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const searchSpec = useMemo<SearchSpec>(
    () => ({ query: search.q ?? "", regex: search.re ?? false, caseSensitive: search.cs ?? false }),
    [search.q, search.re, search.cs],
  );
  const live = followStatus.mode === "streaming" || followStatus.mode === "polling";
  const { matches, scanning } = useSearchScan(buffer, searchSpec, live, initial.dataUpdatedAt, version);

  const [activeMatch, setActiveMatch] = useState(0);
  useEffect(() => setActiveMatch(0), [searchSpec]);
  const hitIndex = matches.length > 0 ? Math.min(activeMatch, matches.length - 1) : 0;

  const [jumpLine, setJumpLine] = useState<{ line: number; n: number } | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const onFirstError = useCallback(() => {
    const line = firstErrorLine(buffer.toLines());
    if (line == null) {
      setErrorNotice("No ERROR/FATAL line in the loaded window");
      setJumpLine(null);
      return;
    }
    setErrorNotice(null);
    setJumpLine((prev) => ({ line, n: (prev?.n ?? 0) + 1 }));
  }, [buffer]);

  // ── display state ──────────────────────────────────────────────────────────────────────────────────────────────
  const filter = useMemo<LogLevel | null>(() => parseLevelFilter(search.filter), [search.filter]);
  /* A phone screen shows a fraction of a long line, so wrapping starts on there and the toggle can still turn it off
     (`?wrap=0`); on a wide screen the default stays off. */
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const wrap = search.wrap ?? narrow;
  const tsMode = timestampMode(search);
  const visibleIdx = useFilteredIndex(buffer, filter);
  const shown = filter ? visibleIdx.length : buffer.length;

  // ── download ───────────────────────────────────────────────────────────────────────────────────────────────────
  const [downloading, setDownloading] = useState(false);
  const onDownload = useCallback(async () => {
    if (!containerId || !file) return;
    setDownloading(true);
    setErrorNotice(null);
    try {
      const blob = await downloadLogFile(containerId, file, meta?.size ?? 0, hints);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setErrorNotice(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDownloading(false);
    }
  }, [containerId, file, meta?.size, hints]);

  // ── states ─────────────────────────────────────────────────────────────────────────────────────────────────────
  if (!containerId) {
    return (
      <ContainerPicker
        appId={appId}
        onPick={(id, node, user) => setSearch({ container: id, node: node ?? undefined, user: user ?? undefined, file: undefined })}
      />
    );
  }

  const listError = filesQuery.error;
  if (filesQuery.isError && filesQuery.data === undefined && isLogEndpointMissing(listError)) {
    return (
      <Unavailable
        title="GET /api/logs/containers/{id} is not served by this backend"
        reason={
          <>
            The container-log routes answered <code>404</code>. They are synthesized by Burrow (contract §5) from the NodeManager's
            container-log directory or the JobHistory/ATS aggregated log; a backend built before that handler landed cannot list the files.
          </>
        }
        hint="The routes are /api/logs/containers/{containerId}[?node&user&app] and …/files/{name}[?offset&length&tail]. The dev mock (bun run dev:mock) replays a real captured log; use a build that includes the logs routes to read the live cluster."
      />
    );
  }
  if (filesQuery.isError && filesQuery.data === undefined) {
    return (
      <ErrorState
        title="Cannot list this container's log files"
        message={listError instanceof Error ? listError.message : String(listError)}
        hint="The file list is read from the NodeManager that ran the container, or from JobHistory once the logs are aggregated."
        onRetry={() => void filesQuery.refetch()}
      />
    );
  }

  const windowError = initial.error;
  const windowMissing = isLogEndpointMissing(windowError);
  const windowNotice =
    hasDisplayedWindow && windowError
      ? `The latest log window could not be loaded; showing the existing lines. ${windowError instanceof Error ? windowError.message : String(windowError)}`
      : null;

  return (
    // Larger screens keep application navigation fixed; narrow screens retain page scrolling so the log pane stays usable.
    <Entity
      id={containerId}
      data-burrow-log-panel="1"
      className="flex h-[64dvh] min-h-112 shrink-0 flex-col overflow-hidden rounded-lg border border-seam bg-fabric"
    >
      <LogToolbar
        containerId={containerId}
        file={file}
        files={files}
        onFile={(name) => setSearch({ file: name })}
        size={meta?.size ?? 0}
        source={meta?.source ?? null}
        node={search.node ?? filesQuery.data?.node ?? null}
        start={meta?.start ?? 0}
        end={meta?.end ?? 0}
        onRefresh={() => void initial.refetch()}
        follow={follow}
        onFollow={(v) => setSearch({ follow: v, tail: v && search.tail == null ? 1 : search.tail })}
        followDisabled={parity}
        onDownload={() => void onDownload()}
        downloading={downloading}
        copyValue={buffer.fullText(LOG_MAX_BYTES)}
        q={search.q ?? ""}
        onQ={(v) => setSearch({ q: v || undefined })}
        regex={search.re ?? false}
        onRegex={(v) => setSearch({ re: v ? true : undefined })}
        caseSensitive={search.cs ?? false}
        onCase={(v) => setSearch({ cs: v ? true : undefined })}
        hits={matches.length}
        onPrev={() => setActiveMatch((i) => stepMatch(matches, i, -1))}
        onNext={() => setActiveMatch((i) => stepMatch(matches, i, 1))}
        onFirstError={onFirstError}
        badRegex={isBadRegex(searchSpec)}
        scanning={scanning}
        filter={filter}
        onFilter={(level) => setSearch({ filter: level ?? undefined })}
        wrap={wrap}
        onWrap={(v) => setSearch({ wrap: v })}
        timestamp={tsMode}
        onTimestamp={(v) => setSearch({ ts: v === "absolute" ? undefined : v })}
      />

      {filesQuery.error && (
        <StaleErrorBanner
          title="Could not refresh this container's log files"
          error={filesQuery.error}
          onRetry={() => void filesQuery.refetch()}
        />
      )}

      {filesQuery.isPending || (initial.isPending && !hasDisplayedWindow) ? (
        <div className="flex min-h-0 flex-1 flex-col gap-1 p-3" aria-busy="true">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} className="h-4" style={{ width: `${40 + ((i * 17) % 50)}%` }} />
          ))}
        </div>
      ) : windowMissing && !hasDisplayedWindow ? (
        <Unavailable
          title="The file bytes are not served by this backend"
          reason={<>The read endpoint answered 404 for this file. It reads a byte range (or `tail`) from the container log source.</>}
          hint="GET /api/logs/containers/{id}/files/{name}?offset=&length= | ?tail= — text/plain with x-burrow-log-* headers."
        />
      ) : windowError && !hasDisplayedWindow ? (
        <ErrorState
          title="Cannot read this log file"
          message={windowError instanceof Error ? windowError.message : String(windowError)}
          hint="A running container's log comes from its NodeManager; a finished one from the aggregated JobHistory/ATS copy."
          onRetry={() => void initial.refetch()}
        />
      ) : (
        <LineViewer
          buffer={buffer}
          version={version}
          matches={matches}
          activeMatch={hitIndex}
          visibleIdx={filter ? visibleIdx : null}
          jumpLine={jumpLine}
          search={searchSpec}
          wrap={wrap}
          timestamp={tsMode}
          follow={follow}
          paused={paused}
          parity={parity}
        />
      )}

      <LogStatusBar
        shown={shown}
        total={buffer.length}
        dropped={buffer.dropped}
        hits={matches.length}
        activeMatch={hitIndex}
        filter={filter}
        followMode={followStatus.mode}
        followDetail={followStatus.detail}
        behind={meta ? Math.max(0, meta.size - buffer.resumeOffset) : null}
        size={meta?.size ?? 0}
        heldBytes={buffer.heldBytes}
        ended={buffer.ended}
        gaps={buffer.gaps.length}
        notice={errorNotice ?? windowNotice}
        onRetry={retry}
      />
    </Entity>
  );
}

/**
 * Search over the buffer, kept off the streaming hot path: a full 1M-line scan runs on spec changes, on a 1.5 s
 * cadence while the log is live, and when the initial window lands — never once per SSE chunk. Scans are chunked
 * (`scanMatchesAsync`) so they never block a frame, and a new spec cancels the previous scan.
 */
function useSearchScan(
  buffer: LineBuffer,
  spec: SearchSpec,
  live: boolean,
  revision: number,
  version: number,
): { matches: Match[]; scanning: boolean } {
  const [matches, setMatches] = useState<Match[]>([]);
  const [scanning, setScanning] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setNonce((n) => n + 1);
  }, [spec, revision]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNonce((n) => n + 1), 1_500);
    return () => clearInterval(t);
  }, [live]);

  // When the stream stops, refresh the search once more so it covers the final bytes.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) setNonce((n) => n + 1);
    wasLive.current = live;
  }, [live]);

  // Non-live appends (e.g. a manual refresh) still need to be searchable.
  useEffect(() => {
    if (!live) setNonce((n) => n + 1);
  }, [version, live]);

  useEffect(() => {
    if (!spec.query) {
      setMatches([]);
      setScanning(false);
      return;
    }
    setScanning(true);
    const scan = scanMatchesAsync(buffer.toLines(), spec, {});
    let alive = true;
    void scan.promise.then((m) => {
      if (!alive) return;
      setMatches(m);
      setScanning(false);
    });
    return () => {
      alive = false;
      scan.cancel();
    };
    // `nonce` is the deliberate trigger; `buffer`/`spec` are read at scan time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  return { matches, scanning };
}
