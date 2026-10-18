/**
 * Pure parser for the daemon thread dump (`GET /api/rm/stacks`, text/plain).
 *
 * Format (Hadoop `StacksServlet` -> `Thread.print`):
 *
 *   Process Thread Dump: <what>
 *   230 active threads
 *   Thread 2 (Reference Handler):
 *     State: RUNNABLE
 *     Blocked count: 3
 *     Waited count: 0
 *     Waiting on <lock>                     (optional)
 *     Stack:
 *       java.base@17.0.20.1/java.lang.ref.Reference.waitForReferencePendingList(Native Method)
 *       …4-space (or tab) indented frames
 *     Locked ownable synchronizers:          (optional)
 *       - None | - <lock>
 *
 * The parser is tolerant by design: unknown lines are skipped, a missing `Stack:` section yields zero frames, extra
 * whitespace is trimmed, and a truncated dump still returns the threads it could read. Everything is pure so the real
 * 167 KB / 230-thread capture is asserted in `stacks.test.ts`.
 */

import type { Tone } from "~/design/status";

export interface StackFrame {
  /** fully qualified class (module prefix stripped into `module`) */
  className: string;
  method: string;
  /** `Reference.java`, `Unknown Source`, … (absent for native frames) */
  file?: string;
  line?: number;
  /** `(Native Method)` */
  native: boolean;
  /** JPMS/jar prefix the JVM prints before the class: `java.base@17.0.20.1`, `app` */
  module?: string;
  /** the original line, trimmed — shown when a frame is not recognised as class.method(file:line) */
  raw: string;
}

export interface DumpThread {
  id: number;
  name: string;
  state: string;
  blocked: number;
  waited: number;
  /** the lock the thread is parked on (`Waiting on <lock>`), when the JVM printed one */
  waitingOn?: string;
  frames: StackFrame[];
  /** `Locked ownable synchronizers` entries, `- None` dropped */
  locks: string[];
}

export interface ThreadDump {
  /** `Process Thread Dump: <x>` — often empty on the RM */
  process: string;
  /** the daemon's own "N active threads" header (null when it is missing/not numeric) */
  active: number | null;
  threads: DumpThread[];
}

const THREAD_RE = /^Thread\s+(\d+)\s*\((.*)\):\s*$/;
const INDENTED_RE = /^(?:\t| {4})/;

/** Split a frame line into its parts. `java.base@17.0.20.1/java.lang.Thread.run(Thread.java:840)` -> class+method+file. */
export function parseStackFrame(line: string): StackFrame {
  const raw = line.trim();
  let module: string | undefined;
  let body = raw;
  const slash = raw.indexOf("/");
  if (slash > 0) {
    module = raw.slice(0, slash);
    body = raw.slice(slash + 1).replace(/^\/+/, "");
  }
  const open = body.lastIndexOf("(");
  const close = body.endsWith(")") ? body.length - 1 : -1;
  const target = open > 0 && close > open ? body.slice(0, open) : body;
  const info = open > 0 && close > open ? body.slice(open + 1, close) : "";
  const dot = target.lastIndexOf(".");
  const className = dot > 0 ? target.slice(0, dot) : target;
  const method = dot > 0 ? target.slice(dot + 1) : "";
  const frame: StackFrame = { className, method, native: false, raw };
  if (module) frame.module = module;
  if (info === "Native Method") {
    frame.native = true;
  } else if (info) {
    const colon = info.lastIndexOf(":");
    const maybeLine = colon > 0 ? Number(info.slice(colon + 1)) : Number.NaN;
    if (colon > 0 && Number.isFinite(maybeLine)) {
      frame.file = info.slice(0, colon);
      frame.line = maybeLine;
    } else {
      frame.file = info;
    }
  }
  return frame;
}

/** Parse a whole dump. Never throws. */
export function parseThreadDump(text: string): ThreadDump {
  const lines = text.split(/\r?\n/);
  let i = 0;
  let process = "";
  let active: number | null = null;

  // header (tolerant: either line may be missing, and the RM's `Process Thread Dump:` value is empty)
  while (i < lines.length) {
    const line = (lines[i] ?? "").trim();
    if (!line) {
      i++;
      continue;
    }
    const dump = /^Process Thread Dump:\s*(.*)$/.exec(line);
    if (dump && active === null) {
      process = (dump[1] ?? "").trim();
      i++;
      continue;
    }
    const at = /^(\d+)\s+active threads?\b/.exec(line);
    if (at && active === null) {
      active = Number(at[1]);
      i++;
      continue;
    }
    break;
  }

  const threads: DumpThread[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const head = THREAD_RE.exec(line.trim());
    if (!head) {
      i++;
      continue;
    }
    const thread: DumpThread = {
      id: Number(head[1]),
      name: head[2] ?? "",
      state: "",
      blocked: 0,
      waited: 0,
      frames: [],
      locks: [],
    };
    i++;
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      if (THREAD_RE.test(cur.trim())) break;
      const trimmed = cur.trim();
      if (!trimmed) {
        i++;
        continue;
      }
      const state = /^State:\s*(.+)$/.exec(trimmed);
      if (state) {
        thread.state = (state[1] ?? "").trim();
        i++;
        continue;
      }
      const blocked = /^Blocked count:\s*(-?\d+)/.exec(trimmed);
      if (blocked) {
        thread.blocked = Number(blocked[1]);
        i++;
        continue;
      }
      const waited = /^Waited count:\s*(-?\d+)/.exec(trimmed);
      if (waited) {
        thread.waited = Number(waited[1]);
        i++;
        continue;
      }
      const waitingOn = /^Waiting on\s+(.+)$/.exec(trimmed);
      if (waitingOn) {
        thread.waitingOn = (waitingOn[1] ?? "").trim();
        i++;
        continue;
      }
      if (/^Stack:\s*$/.test(trimmed)) {
        i++;
        while (i < lines.length) {
          const frame = lines[i] ?? "";
          if (THREAD_RE.test(frame.trim())) break;
          if (!frame.trim()) {
            i++;
            continue;
          }
          if (!INDENTED_RE.test(frame)) break;
          thread.frames.push(parseStackFrame(frame));
          i++;
        }
        continue;
      }
      if (/^Locked ownable synchronizers:\s*$/.test(trimmed)) {
        i++;
        while (i < lines.length) {
          const entry = lines[i] ?? "";
          if (THREAD_RE.test(entry.trim())) break;
          const et = entry.trim();
          if (!et) {
            i++;
            continue;
          }
          const item = /^-\s*(.*)$/.exec(et);
          if (!item) break;
          const value = (item[1] ?? "").trim();
          if (value && value.toLowerCase() !== "none") thread.locks.push(value);
          i++;
        }
        continue;
      }
      if (INDENTED_RE.test(cur)) {
        // an indented line outside a known section: keep it as a frame rather than losing information
        thread.frames.push(parseStackFrame(cur));
        i++;
        continue;
      }
      break;
    }
    threads.push(thread);
  }

  return { process, active, threads };
}

export interface ThreadStateCount {
  state: string;
  count: number;
}

/** Counts per state, ordered by count desc then name — the summary chips. */
export function stateHistogram(threads: readonly DumpThread[]): ThreadStateCount[] {
  const counts = new Map<string, number>();
  for (const t of threads) {
    const key = t.state || "UNKNOWN";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));
}

export function frameText(frame: StackFrame): string {
  const target = frame.className && frame.method ? `${frame.className}.${frame.method}` : frame.className || frame.method || frame.raw;
  const where = frame.native ? "Native Method" : frame.line != null ? `${frame.file}:${frame.line}` : (frame.file ?? "");
  const prefix = frame.module ? `${frame.module}/` : "";
  return where ? `${prefix}${target}(${where})` : `${prefix}${target}`;
}

/** `Thread <id> (<name>):` + metadata + frames — the canonical block, for "copy this thread dump". */
export function threadToText(thread: DumpThread): string {
  const out: string[] = [`Thread ${thread.id} (${thread.name}):`];
  if (thread.state) out.push(`  State: ${thread.state}`);
  out.push(`  Blocked count: ${thread.blocked}`, `  Waited count: ${thread.waited}`);
  if (thread.waitingOn) out.push(`  Waiting on ${thread.waitingOn}`);
  out.push("  Stack:");
  for (const frame of thread.frames) out.push(`    ${frameText(frame)}`);
  if (thread.locks.length > 0) {
    out.push("  Locked ownable synchronizers:");
    for (const lock of thread.locks) out.push(`    - ${lock}`);
  }
  return out.join("\n");
}

export function dumpToText(dump: ThreadDump): string {
  const head = [`Process Thread Dump: ${dump.process}`.trimEnd(), `${dump.active ?? dump.threads.length} active threads`];
  return [...head, ...dump.threads.map(threadToText)].join("\n");
}

export interface ThreadSearchHit {
  thread: DumpThread;
  /** frame indices that matched the query (empty when only the name matched) */
  frames: number[];
}

/** Case-insensitive search over thread name and frames; the result keeps the frame indices for highlighting. */
export function searchThreads(threads: readonly DumpThread[], query: string): ThreadSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return threads.map((thread) => ({ thread, frames: [] }));
  const hits: ThreadSearchHit[] = [];
  for (const thread of threads) {
    if (thread.name.toLowerCase().includes(needle) || String(thread.id) === needle) {
      hits.push({ thread, frames: [] });
      continue;
    }
    const frames: number[] = [];
    thread.frames.forEach((frame, i) => {
      if (frameText(frame).toLowerCase().includes(needle)) frames.push(i);
    });
    if (frames.length > 0) hits.push({ thread, frames });
  }
  return hits;
}

/** Tone per state: work states are live/ok, parked ones wait/idle, blocked is a red flag. Never colour-only (the chip
 *  always prints the state name and its count). */
export const THREAD_STATE_TONE: Record<string, Tone> = {
  RUNNABLE: "live",
  TIMED_WAITING: "wait",
  WAITING: "idle",
  BLOCKED: "warn",
  NEW: "fresh",
  TERMINATED: "idle",
  UNKNOWN: "idle",
};
