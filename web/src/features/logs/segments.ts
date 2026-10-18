/**
 * One rendered log line, cut into styled runs: ANSI SGR styling and search highlights are merged into a single
 * segment list so a match inside a coloured span keeps both its colour and its `<mark>`.
 *
 * The ANSI parser is the one the daemon-log viewer already ships (`~/features/tools/Ansi`) — a second SGR parser in the
 * product would be a second set of bugs. This module adds only the *merge*: it maps match ranges (which live in the
 * visible, ANSI-stripped text the user actually searched) onto the styled runs.
 */
import { ansiClass, parseAnsi } from "~/features/tools/Ansi";

export interface LineMatch {
  start: number;
  end: number;
  /** index into the global match list, so the active match can be outlined */
  global: number;
}

export interface LogSegment {
  text: string;
  /** Tailwind classes for the ANSI style (empty string when plain) */
  cls: string;
  /** global match index when this run is inside a match, else null */
  hit: number | null;
}

/**
 * Split `text` into styled runs, interleaving search matches. Assumes `matches` are sorted, non-overlapping and within
 * the visible text (the search layer guarantees this). Concatenating the result's `text` fields always reproduces the
 * visible line — nothing is dropped, so the DOM is a faithful rendering of the log.
 */
export function splitSegments(text: string, matches: readonly LineMatch[]): LogSegment[] {
  const spans = parseAnsi(text);
  const out: LogSegment[] = [];
  let cursor = 0; // position in the visible text
  let mi = 0;
  for (const span of spans) {
    const spanStart = cursor;
    const spanEnd = cursor + span.text.length;
    let local = 0; // position within span.text
    // Skip matches that ended before this span.
    while (mi < matches.length && matches[mi]!.end <= spanStart) mi++;
    let k = mi;
    while (k < matches.length && matches[k]!.start < spanEnd) {
      const m = matches[k]!;
      const from = Math.max(m.start, spanStart) - spanStart;
      const to = Math.min(m.end, spanEnd) - spanStart;
      if (from > local) out.push({ text: span.text.slice(local, from), cls: ansiClass(span), hit: null });
      out.push({ text: span.text.slice(from, to), cls: ansiClass(span), hit: m.global });
      local = to;
      if (m.end > spanEnd) break; // match continues into the next span
      k++;
    }
    if (local < span.text.length) out.push({ text: span.text.slice(local), cls: ansiClass(span), hit: null });
    cursor = spanEnd;
  }
  if (out.length === 0 && text.length === 0) return [];
  return out;
}
