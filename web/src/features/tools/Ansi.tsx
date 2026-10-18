/**
 * ANSI SGR rendering for the log viewer (`/tools/logs`).
 *
 * Daemons colour their console logs (`rm.out`, container stdout) with SGR escape sequences. Burrow shows the *text*,
 * never the escapes, but it must not silently drop anything it does not understand:
 *
 *  - `30–37` / `90–97` foreground, `1` bold, `2` dim, `0` reset, `22`/`39` back to default → styled spans;
 *  - `38;5;n` (256-colour) and `38;2;r;g;b` (truecolour) are consumed and ignored: we render the text in the default ink
 *    rather than inventing a colour, so a 24-bit colour theme degrades to plain readable text;
 *  - background codes (`40–47`, `100–107`, `48;…`) and every other SGR attribute are consumed and ignored;
 *  - anything else — a truncated escape at a chunk boundary (`"\u001b[3"`), a non-SGR CSI (`"\u001b[2J"`), an OSC title —
 *    does not match the SGR grammar and is kept verbatim in the text run, so it is never dropped.
 *
 * Match highlighting also happens here because it must slice styled runs without breaking them.
 */
import { cn } from "~/lib/cn";

export interface AnsiSpan {
  text: string;
  /** SGR foreground code, 30–37 or 90–97 */
  fg?: number;
  bold?: boolean;
  dim?: boolean;
}

export interface AnsiSegment extends AnsiSpan {
  /** 0-based index of the search hit this segment is part of, or null when it is not a match */
  hit: number | null;
}

/** Only SGR (`…m`) is an escape as far as this renderer is concerned; everything else stays literal text. */
const ESC = "\u001b";
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

/** Colour classes per SGR code, in both themes: the dark ground needs lighter inks than the light one. */
const ANSI_FG: Record<number, string> = {
  30: "text-ink-3",
  31: "text-[oklch(0.72_0.175_22)] light:text-[oklch(0.51_0.18_25)]",
  32: "text-[oklch(0.74_0.15_152)] light:text-[oklch(0.47_0.125_150)]",
  33: "text-[oklch(0.83_0.14_88)] light:text-[oklch(0.55_0.12_75)]",
  34: "text-[oklch(0.76_0.12_262)] light:text-[oklch(0.5_0.14_262)]",
  35: "text-[oklch(0.75_0.15_330)] light:text-[oklch(0.5_0.18_330)]",
  36: "text-[oklch(0.82_0.125_195)] light:text-[oklch(0.5_0.105_200)]",
  37: "text-ink",
  90: "text-ink-4",
  91: "text-[oklch(0.79_0.16_22)] light:text-[oklch(0.55_0.2_25)]",
  92: "text-[oklch(0.82_0.16_152)] light:text-[oklch(0.52_0.14_150)]",
  93: "text-[oklch(0.9_0.15_95)] light:text-[oklch(0.6_0.13_80)]",
  94: "text-[oklch(0.83_0.12_262)] light:text-[oklch(0.55_0.16_262)]",
  95: "text-[oklch(0.82_0.15_330)] light:text-[oklch(0.55_0.2_330)]",
  96: "text-[oklch(0.88_0.13_195)] light:text-[oklch(0.55_0.12_200)]",
  97: "text-ink",
};

export const ANSI_HIT = "rounded-[2px] bg-[color-mix(in_oklch,var(--warn)_38%,transparent)] text-ink";
export const ANSI_HIT_ACTIVE = "rounded-[2px] bg-[color-mix(in_oklch,var(--live)_45%,transparent)] text-ink ring-1 ring-live";

interface Style {
  fg?: number;
  bold?: boolean;
  dim?: boolean;
}

function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && !!a.bold === !!b.bold && !!a.dim === !!b.dim;
}

function applySgr(style: Style, code: number): Style {
  if (code === 0) return {};
  if (code === 1) return { ...style, bold: true };
  if (code === 2) return { ...style, dim: true };
  if (code === 22) return { ...style, bold: undefined, dim: undefined };
  if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) return { ...style, fg: code };
  if (code === 39) return { ...style, fg: undefined };
  return style;
}

/**
 * Split `input` into runs of one style. Consecutive text with the same style is merged, unparseable escapes stay verbatim,
 * and the concatenation of every span's text is always the input minus its SGR sequences (nothing is dropped).
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: Style = {};
  let cursor = 0;
  const push = (text: string) => {
    if (!text) return;
    const last = spans[spans.length - 1];
    if (last && sameStyle(last, style)) {
      last.text += text;
      return;
    }
    spans.push({ text, ...style });
  };
  const re = new RegExp(SGR.source, "g");
  let m = re.exec(input);
  while (m) {
    push(input.slice(cursor, m.index));
    cursor = re.lastIndex;
    const params = (m[1] ?? "").split(";").map((p) => (p === "" ? 0 : Number(p)));
    for (let i = 0; i < params.length; i++) {
      const code = params[i];
      if (code === undefined || Number.isNaN(code)) continue;
      if (code === 38 || code === 48) {
        // extended colour: 38;5;n / 38;2;r;g;b — skip the operands and keep the default ink (never guess a colour)
        const mode = params[i + 1];
        i += mode === 5 ? 2 : mode === 2 ? 4 : 1;
        continue;
      }
      style = applySgr(style, code);
    }
    m = re.exec(input);
  }
  push(input.slice(cursor));
  return spans;
}

/** Class string for one run (exported so the log viewer can style the `<mark>`-free path identically). */
export function ansiClass(span: Style): string {
  return cn(span.dim && "opacity-70", span.bold && "font-semibold", span.fg != null && ANSI_FG[span.fg]);
}

/**
 * Split styled runs at `query` matches (case-insensitive) and number them, so the viewer can mark, count and step
 * through them. `hits` is the number of matches found in this window.
 */
export function segmentAnsi(spans: readonly AnsiSpan[], query: string): { segments: AnsiSegment[]; hits: number } {
  const needle = query.trim().toLowerCase();
  const segments: AnsiSegment[] = [];
  let hits = 0;
  const emit = (text: string, span: AnsiSpan, hit: number | null) => {
    if (text) segments.push({ ...span, text, hit });
  };
  for (const span of spans) {
    if (!needle) {
      emit(span.text, span, null);
      continue;
    }
    const hay = span.text.toLowerCase();
    let from = 0;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, from)) {
      emit(span.text.slice(from, at), span, null);
      emit(span.text.slice(at, at + needle.length), span, hits++);
      from = at + needle.length;
    }
    emit(span.text.slice(from), span, null);
  }
  return { segments, hits };
}

/** Renders parsed runs; `activeHit` outlines the match the viewer has stepped to. */
export function Ansi({ segments, activeHit, className }: { segments: readonly AnsiSegment[]; activeHit?: number; className?: string }) {
  return (
    <span className={className}>
      {segments.map((s, i) => (
        <span key={i} className={ansiClass(s)} data-ansi-hit={s.hit ?? undefined}>
          {s.hit === null ? (
            s.text
          ) : (
            <mark
              data-ansi-mark={s.hit}
              data-active={activeHit === s.hit || undefined}
              className={cn(ANSI_HIT, activeHit === s.hit && ANSI_HIT_ACTIVE)}
            >
              {s.text}
            </mark>
          )}
        </span>
      ))}
    </span>
  );
}
