/**
 * The container-log line model (pure, DOM-free, worker-safe).
 *
 * Everything the viewer does that can be *wrong* lives here so it can be unit-tested without a browser: UTF-8 byte
 * arithmetic over ranged reads and streamed chunks, line splitting with a resumable tail, dedupe/gap handling when a
 * follow reconnects at an offset, a bounded ring buffer, ANSI stripping, log-level detection, timestamp detection and
 * search (literal + regex, case toggle).
 *
 * Byte offsets are the wire currency (`x-burrow-log-start`, SSE `chunk.start`) and must be exact: the viewer pages and
 * resumes by byte, so a wrong offset re-reads or skips log text. The SPA only ever sees decoded strings, so every
 * offset is derived by counting the UTF-8 length of the text it has consumed — never by `String.length`.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────── byte arithmetic

/**
 * UTF-8 byte length of a JS string. Fast path for ASCII (the overwhelming majority of log text), correct for
 * surrogate pairs. `TextEncoder` would allocate a Uint8Array per line; at 1M lines that is the difference between a
 * scan and a stall.
 */
export function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // high surrogate: the pair encodes one code point in 4 bytes
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Drop the first `fromByte` bytes of `s` and (optionally) keep only up to `toByte`. Char-accurate: never splits a
 * surrogate pair, and a byte budget that lands mid-code-point rounds *down* (drops the whole character) so the result
 * is always valid UTF-8. Used to remove the overlap when a stream resumes inside bytes we already hold.
 */
export function sliceBytes(s: string, fromByte: number, toByte = Number.POSITIVE_INFINITY): string {
  if (fromByte <= 0 && toByte === Number.POSITIVE_INFINITY) return s;
  let start = 0;
  let consumed = 0;
  while (start < s.length && consumed < fromByte) {
    const c = s.charCodeAt(start);
    const size = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : 3;
    consumed += size;
    start += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  if (toByte === Number.POSITIVE_INFINITY) return s.slice(start);
  let end = start;
  let seen = 0;
  while (end < s.length && seen + charByteSize(s, end) <= toByte) {
    seen += charByteSize(s, end);
    end += s.charCodeAt(end) >= 0xd800 && s.charCodeAt(end) <= 0xdbff ? 2 : 1;
  }
  return s.slice(start, end);
}

function charByteSize(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  return c >= 0xd800 && c <= 0xdbff ? 4 : 3;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────── ANSI stripping

const ESC = "\u001b";
// SGR is `ESC [ … m`; everything else (cursor moves, OSC) is left alone so nothing is silently dropped.
const SGR_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** True when the text contains any escape; the fast path lets the hot loops skip regex work entirely. */
export function hasAnsi(s: string): boolean {
  return s.indexOf(ESC) !== -1;
}

/**
 * The text a human sees: SGR sequences removed. This is the coordinate space search matches live in, because the user
 * searches what is rendered, not the escape-laden raw bytes.
 */
export function stripAnsi(s: string): string {
  return hasAnsi(s) ? s.replace(SGR_RE, "") : s;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────── log levels

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/** Severity order, least to most severe. */
export const LEVEL_ORDER: readonly LogLevel[] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];

export const LEVEL_RANK: Record<LogLevel, number> = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, FATAL: 5 };

/** log4j / log4j2 / java.util.logging spellings collapse onto the six canonical levels. */
const LEVEL_ALIAS: Record<string, LogLevel> = {
  TRACE: "TRACE",
  DEBUG: "DEBUG",
  FINE: "DEBUG",
  INFO: "INFO",
  NOTICE: "INFO",
  WARN: "WARN",
  WARNING: "WARN",
  ERROR: "ERROR",
  SEVERE: "ERROR",
  FATAL: "FATAL",
  CRITICAL: "FATAL",
};

// Only the head of the line is considered: a level token buried in a payload must not recolour the line. This mirrors
// the fixed fields of the default log4j pattern (`%d %p [%t] %c - %m`).
const LEVEL_RE = /\b(TRACE|DEBUG|FINE|INFO|NOTICE|WARN|WARNING|ERROR|SEVERE|FATAL|CRITICAL)\b/;
const LEVEL_HEAD = 120;

/**
 * The line's level, or null when the line does not declare one. Only the first `LEVEL_HEAD` characters are examined so
 * a message that mentions "ERROR" is not mis-levelled.
 */
export function detectLevel(line: string): LogLevel | null {
  const head = line.length > LEVEL_HEAD ? line.slice(0, LEVEL_HEAD) : line;
  const m = LEVEL_RE.exec(head);
  return m ? (LEVEL_ALIAS[m[1]!] ?? null) : null;
}

/** URL level filter: `all`/absent → no filter; `WARN` → WARN and above; `WARN+` is accepted as the same thing. */
export function parseLevelFilter(value: string | undefined | null): LogLevel | null {
  if (!value || value === "all") return null;
  const key = value.replace(/\+$/, "").toUpperCase();
  return (LEVEL_ORDER as readonly string[]).includes(key) ? (key as LogLevel) : null;
}

/** True when the line's level passes the minimum-level filter. Lines with no detectable level always pass (they are
 * stack traces, continuations and raw output — filtering them out would hide the reason for the error). */
export function levelPasses(level: LogLevel | null, min: LogLevel | null): boolean {
  if (!min) return true;
  if (!level) return true;
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────── timestamps

export interface LineTime {
  /** epoch ms when the line carries a full date; null when it only carries a wall-clock time */
  epoch: number | null;
  /** true when only `HH:MM:SS[,mmm]` was present — a relative view can still use it, an absolute one cannot */
  timeOnly: boolean;
  /** the matched timestamp text, verbatim */
  text: string;
  /** ms since midnight for time-only stamps, else null — the relative view's raw material */
  msOfDay: number | null;
}

export type TimestampReference = `epoch:${number}` | `clock:${number}`;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/;
// Hadoop's default log4j pattern `%d{yy/MM/dd HH:mm:ss}` — `26/10/03 13:39:14`
const HADOOP_RE = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/;
// log4j default: `12:00:00,123`
const CLOCK_RE = /^(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/;

/**
 * The timestamp a line starts with, if any. Only the head is examined (20 chars) and the match must be at the very
 * start: an embedded time is payload, not a record stamp. `timeOnly` stamps get no `epoch` because inventing a date
 * would be a lie; the relative view derives deltas from `msOfDay` instead.
 */
export function detectTimestamp(line: string): LineTime | null {
  const head = line.length > 40 ? line.slice(0, 40) : line;
  const iso = ISO_RE.exec(head);
  if (iso) {
    const [, y, mo, d, h, mi, s, ms] = iso;
    const frac = ms ? Number(ms.padEnd(3, "0")) : 0;
    // Date.UTC (not local) so the value is a stable instant regardless of the browser zone; the display layer decides
    // how to render it.
    const epoch = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), frac);
    return { epoch, timeOnly: false, text: iso[0], msOfDay: null };
  }
  const hadoop = HADOOP_RE.exec(head);
  if (hadoop) {
    const [, yy, mo, d, h, mi, s, ms] = hadoop;
    const frac = ms ? Number(ms.padEnd(3, "0")) : 0;
    const epoch = Date.UTC(2000 + Number(yy), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), frac);
    return { epoch, timeOnly: false, text: hadoop[0], msOfDay: null };
  }
  const clock = CLOCK_RE.exec(head);
  if (clock) {
    const [, h, mi, s, ms] = clock;
    const frac = ms ? Number(ms.padEnd(3, "0")) : 0;
    return { epoch: null, timeOnly: true, text: clock[0], msOfDay: ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + frac };
  }
  return null;
}

/**
 * Relative stamp for a time-only line: milliseconds after the previous stamped line, unwrapping the midnight
 * rollover. Returns null for the first line (there is nothing to be relative to).
 */
export function relativeMs(currentMsOfDay: number, previousMsOfDay: number | null): number | null {
  if (previousMsOfDay == null) return null;
  let delta = currentMsOfDay - previousMsOfDay;
  if (delta < -12 * 3600 * 1000) delta += 24 * 3600 * 1000; // crossed midnight forward
  if (delta > 12 * 3600 * 1000) delta -= 24 * 3600 * 1000; // crossed midnight backward (clock skew)
  return delta;
}

/** Elapsed milliseconds from a stable `epoch:<ms>` or `clock:<ms-of-day>` reference. */
export function relativeTimestampMs(current: LineTime, previous: TimestampReference | null): number | null {
  if (!previous) return null;
  const [kind, raw] = previous.split(":", 2);
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (current.epoch != null && kind === "epoch") return current.epoch - value;
  if (current.msOfDay != null && kind === "clock") return relativeMs(current.msOfDay, value);
  return null;
}

/** `+1 234 ms` / `-12 ms` — signed, tabular-friendly. */
export function formatDelta(ms: number): string {
  return `${ms >= 0 ? "+" : "−"}${Math.abs(ms).toLocaleString("en-US")} ms`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────── search

export interface SearchSpec {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
}

export interface Match {
  /** buffer index of the matching line */
  line: number;
  /** character offsets within the line's VISIBLE text (ANSI stripped) */
  start: number;
  end: number;
}

export const EMPTY_SEARCH: SearchSpec = { query: "", regex: false, caseSensitive: false };

/** `a.b` → literal; `a.b` with regex → a pattern. Returns null for an empty query or an invalid regex. */
export function compileSearch(spec: SearchSpec): RegExp | null {
  if (!spec.query) return null;
  const source = spec.regex ? spec.query : spec.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, spec.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/** True when a regex is syntactically invalid — the UI shows the error instead of a silent zero-match. */
export function isBadRegex(spec: SearchSpec): boolean {
  if (!spec.regex || !spec.query) return false;
  try {
    new RegExp(spec.query);
    return false;
  } catch {
    return true;
  }
}

/** Zero-length matches (e.g. `^`) are advanced past so the scan cannot spin. */
function execAll(re: RegExp, text: string, out: { start: number; end: number }[], limit: number): void {
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(text);
    if (m === null) return;
    out.push({ start: m.index, end: m.index + m[0].length });
    if (out.length >= limit) return;
    if (m[0].length === 0) re.lastIndex++;
  }
}

/**
 * Scan lines for matches, capped at `cap` (a 1M-line file with a common substring must not build a million-entry
 * array). Matches are reported against the VISIBLE text, so the viewer can highlight them directly.
 */
export function findMatches(lines: readonly string[], spec: SearchSpec, cap = 20_000): Match[] {
  const re = compileSearch(spec);
  if (!re) return [];
  const out: Match[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const visible = hasAnsi(raw) ? stripAnsi(raw) : raw;
    if (!visible) continue;
    const local: { start: number; end: number }[] = [];
    execAll(re, visible, local, cap - out.length);
    for (const r of local) out.push({ line: i, start: r.start, end: r.end });
    if (out.length >= cap) break;
  }
  return out;
}

export interface AsyncScan {
  cancel: () => void;
  promise: Promise<Match[]>;
}

/**
 * Chunked search for the live viewer: yields to the event loop every `batch` lines so a scan over a multi-MB buffer
 * never blocks a frame, and reports progress so the status bar can say "searching…". Cancellation is cooperative —
 * callers start a new scan on every keystroke.
 */
export function scanMatchesAsync(
  lines: readonly string[],
  spec: SearchSpec,
  opts: { cap?: number; batch?: number; onProgress?: (found: number, scanned: number) => void } = {},
): AsyncScan {
  const cap = opts.cap ?? 20_000;
  const batch = opts.batch ?? 25_000;
  let cancelled = false;
  const promise = (async (): Promise<Match[]> => {
    const re = compileSearch(spec);
    if (!re) return [];
    // Yield before the first batch so a caller that cancels synchronously (effect cleanup) never pays for a scan.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const out: Match[] = [];
    for (let i = 0; i < lines.length; i += batch) {
      if (cancelled) return out;
      const end = Math.min(lines.length, i + batch);
      for (let j = i; j < end; j++) {
        const raw = lines[j]!;
        const visible = hasAnsi(raw) ? stripAnsi(raw) : raw;
        if (!visible) continue;
        const local: { start: number; end: number }[] = [];
        execAll(re, visible, local, cap - out.length);
        for (const r of local) out.push({ line: j, start: r.start, end: r.end });
        if (out.length >= cap) {
          opts.onProgress?.(out.length, j + 1);
          return out;
        }
      }
      opts.onProgress?.(out.length, end);
      // Yield: `setTimeout(0)` rather than microtask so paint/layout can actually happen between batches.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return out;
  })();
  return { cancel: () => (cancelled = true), promise };
}

/** A match plus its position in the global match list (what the renderer highlights as "active"). */
export interface IndexedMatch extends Match {
  global: number;
}

/** Matches grouped by line index, each carrying its global index — what the renderer needs per visible row. */
export function matchesByLine(matches: readonly Match[]): Map<number, IndexedMatch[]> {
  const map = new Map<number, IndexedMatch[]>();
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const indexed: IndexedMatch = { line: m.line, start: m.start, end: m.end, global: i };
    const list = map.get(m.line);
    if (list) list.push(indexed);
    else map.set(m.line, [indexed]);
  }
  return map;
}

/** Index into the global match list of the next/previous match relative to `from` (wrapping). */
export function stepMatch(matches: readonly Match[], from: number, delta: number): number {
  if (matches.length === 0) return -1;
  const base = from < 0 ? (delta > 0 ? -1 : 0) : Math.min(from, matches.length - 1);
  return (base + delta + matches.length) % matches.length;
}

/**
 * Buffer index of the first line whose level is at least `min` — the "jump to first error" anchor. Independent of any
 * search query (the button must work on a fresh log), so it scans the buffer once per click.
 */
export function firstErrorLine(lines: readonly string[], min: LogLevel = "ERROR"): number | null {
  const rank = LEVEL_RANK[min];
  for (let i = 0; i < lines.length; i++) {
    const level = detectLevel(lines[i]!);
    if (level && LEVEL_RANK[level] >= rank) return i;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────── line buffer

export interface Gap {
  from: number;
  to: number;
}

export interface AppendOptions {
  /** The text begins at a line boundary (a fresh window read) rather than continuing a line. */
  headAligned?: boolean;
}

const DEFAULT_MAX_LINES = 1_000_000;
/** When the cap is hit, drop in one go and keep the remaining work amortised O(1) per line. */
const DROP_FRACTION = 0.1;

/**
 * A bounded, resumable, byte-addressed line store.
 *
 * `lines`/`starts`/`ends` are parallel arrays with a movable `head` cursor so the ring-buffer trim is O(1) amortised
 * (splicing a million-element array on every dropped line would be quadratic). Public accessors are index-based and
 * always relative to the *retained* window.
 *
 * Invariants:
 *  - `start(i) < end(i)` and `start(i+1) === end(i) + 1` for consecutive complete lines (the +1 is the `\n`).
 *  - `totalBytes` is the byte offset just past everything consumed, i.e. where the next `append` expects to resume.
 *  - `headPartial` says the first retained line was cut by the window start (no `\n` before it).
 */
export class LineBuffer {
  private _lines: string[] = [];
  private _starts: number[] = [];
  private _ends: number[] = [];
  private head = 0;
  /** text of the last, not-yet-newline-terminated line */
  private pending = "";
  private pendingStart = 0;
  /** true when `pending` itself was cut by the window start */
  private pendingPartial = false;

  /** monotonic counter bumped on every mutation — the renderer's change signal */
  version = 0;
  /** Whole-window replacements invalidate indexes even when the new window has the same line count. */
  generation = 0;
  /** number of lines dropped from the front by the ring buffer */
  dropped = 0;
  /** byte offset just past all consumed text */
  totalBytes = 0;
  /** the first retained line was cut by the window start */
  headPartial = false;
  /** bytes skipped because a reconnect resumed past what we hold */
  gaps: Gap[] = [];
  /** set once a follow has seen `eof` */
  ended = false;

  constructor(readonly maxLines: number = DEFAULT_MAX_LINES) {}

  get length(): number {
    return this._lines.length - this.head;
  }

  line(i: number): string {
    return this._lines[this.head + i]!;
  }

  start(i: number): number {
    return this._starts[this.head + i]!;
  }

  end(i: number): number {
    return this._ends[this.head + i]!;
  }

  /** Byte offset where the next append resumes. When a partial line is held, this is inside it. */
  get resumeOffset(): number {
    return this.totalBytes;
  }

  /** Byte offset of the first retained byte. */
  get firstByte(): number {
    return this.length > 0 ? this.start(0) : this.totalBytes;
  }

  /** Bytes currently held (excluding the gap bytes). */
  get heldBytes(): number {
    return Math.max(0, this.totalBytes - this.firstByte);
  }

  reset(): void {
    this._lines = [];
    this._starts = [];
    this._ends = [];
    this.head = 0;
    this.pending = "";
    this.pendingStart = 0;
    this.pendingPartial = false;
    this.version++;
    this.generation++;
    this.dropped = 0;
    this.totalBytes = 0;
    this.headPartial = false;
    this.gaps = [];
    this.ended = false;
  }

  /** Replace the whole store with a fresh window read at `startByte`. */
  setWindow(text: string, startByte: number): void {
    this.reset();
    this.headPartial = startByte > 0;
    this.pendingStart = startByte;
    this.pendingPartial = this.headPartial;
    this.pending = "";
    this.totalBytes = startByte;
    this.consume(text);
    this.version++;
  }

  /**
   * Append a streamed chunk that begins at `startByte`. Handles three cases the wire produces:
   *  - `startByte < totalBytes` — overlap after a reconnect: the overlapping bytes are trimmed (dedupe).
   *  - `startByte > totalBytes` — a gap: recorded so the viewer can show an honest divider instead of pretending the
   *    log is contiguous.
   *  - `startByte === totalBytes` — the normal continuation.
   */
  append(text: string, startByte: number, opts: AppendOptions = {}): void {
    if (this.ended) return;
    if (opts.headAligned) {
      // A fresh window (e.g. the initial load landing after the stream opened): restart cleanly.
      this.setWindow(text, startByte);
      return;
    }
    let chunk = text;
    if (startByte < this.totalBytes) {
      chunk = sliceBytes(chunk, this.totalBytes - startByte);
    } else if (startByte > this.totalBytes) {
      if (this.pending) this.flushPending();
      this.gaps.push({ from: this.totalBytes, to: startByte });
      this.pendingStart = startByte;
      this.pendingPartial = true;
    }
    if (!chunk) {
      this.version++;
      return;
    }
    this.consume(chunk);
    this.version++;
  }

  /** Mark the stream finished (container exited / aggregation complete). Idempotent. */
  markEnded(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.pending) this.flushPending();
    this.version++;
  }

  /**
   * The retained lines as a plain array — the input the search layer scans. O(1) while nothing has been dropped
   * (returns the backing array); a copy after a ring-buffer trim, which is rare and only on a search recompute.
   */
  toLines(): readonly string[] {
    return this.head === 0 ? this._lines : this._lines.slice(this.head);
  }

  /** Concatenate the retained lines (up to `maxBytes`) — used by copy. */
  fullText(maxBytes = Number.POSITIVE_INFINITY): string {
    const parts: string[] = [];
    let bytes = 0;
    for (let i = 0; i < this.length; i++) {
      const line = this.line(i);
      parts.push(line);
      bytes += utf8Len(line) + 1;
      if (bytes >= maxBytes) break;
    }
    return parts.join("\n");
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Split `pending + text` into complete lines, keeping the tail. */
  private consume(text: string): void {
    const combined = this.pending + text;
    const cursorBase = this.pendingStart;
    let cursor = cursorBase;
    let from = 0;
    let searchFrom = 0;
    for (;;) {
      const nl = combined.indexOf("\n", searchFrom);
      if (nl === -1) break;
      const raw = combined.slice(from, nl);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const partialPrefix = this.pendingPartial && from === 0 && cursorBase > 0;
      // A byte-tail window can start on the newline that ends a line whose content was outside the window.
      // That empty prefix is not a real log row. Keep empty lines after it; those are present in the captured bytes.
      if (!(partialPrefix && line === "")) {
        this.push(line, cursor, cursor + utf8Len(raw), partialPrefix);
      }
      cursor += utf8Len(raw) + 1; // the `\n`
      from = nl + 1;
      searchFrom = nl + 1;
    }
    this.pending = combined.slice(from);
    this.pendingStart = cursor;
    this.pendingPartial = this.pendingPartial && from === 0;
    this.totalBytes = cursor + utf8Len(this.pending);
  }

  /** Emit the held tail as a line (used before a gap or at EOF). */
  private flushPending(): void {
    if (!this.pending) return;
    const raw = this.pending;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    this.push(line, this.pendingStart, this.pendingStart + utf8Len(raw), this.pendingPartial);
    this.pending = "";
    this.pendingPartial = false;
  }

  private push(text: string, start: number, end: number, partialStart: boolean): void {
    // The very first line of a window at offset 0 is not partial even if `headPartial` was set defensively.
    const isPartial = partialStart && !(this.length === 0 && start === 0);
    this._lines.push(text);
    this._starts.push(start);
    this._ends.push(end);
    if (isPartial && this.length === 1) this.headPartial = true;
    this.trim();
  }

  private trim(): void {
    const size = this._lines.length - this.head;
    if (size <= this.maxLines) return;
    const drop = Math.max(1, Math.floor(this.maxLines * DROP_FRACTION));
    this.head += drop;
    this.dropped += drop;
    if (this.head > 2 * this.maxLines) {
      this._lines = this._lines.slice(this.head);
      this._starts = this._starts.slice(this.head);
      this._ends = this._ends.slice(this.head);
      this.head = 0;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────── window reads

export interface LogWindowHeaders {
  size: number;
  start: number;
  end: number;
  source: string | null;
}

/**
 * Read the `x-burrow-log-*` window the server served. These headers are the truth: the server may clamp the requested
 * range, and a `tail` read lands at an offset the client cannot predict. Missing headers degrade to the requested
 * range (a mock or an older backend), never to a guess that would corrupt offsets.
 */
export function parseWindowHeaders(
  headers: Headers,
  requested: { offset: number; length: number },
  fallbackSize: number,
): LogWindowHeaders {
  const num = (name: string, dflt: number): number => {
    const v = headers.get(name);
    if (v == null) return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  return {
    size: num("x-burrow-log-size", fallbackSize),
    start: num("x-burrow-log-start", requested.offset),
    end: num("x-burrow-log-end", requested.offset + requested.length),
    source: headers.get("x-burrow-log-source"),
  };
}

/** `bytes 0–131,071 of 222,179 · 128 KiB` — inclusive ends, matching how a hex dump is read. */
export function byteRangeLabel(start: number, end: number, size: number): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const shown = Math.max(0, end - start);
  return `bytes ${fmt(start)}–${fmt(Math.max(start, end - 1))} of ${fmt(size)} · ${fmtBytesShort(shown)}`;
}

function fmtBytesShort(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/** Source badge text: which upstream answered (contract §5 `x-burrow-log-source`). */
export function sourceLabel(source: string | null): string {
  switch (source) {
    case "nm":
      return "NodeManager";
    case "jhs":
      return "JobHistory";
    case "ats":
      return "ATS";
    default:
      return "unknown";
  }
}
