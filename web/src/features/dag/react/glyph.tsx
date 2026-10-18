/**
 * The node's status glyph: the *shape* half of the status language, drawn inside the SVG canvas.
 *
 * `src/ui/status.tsx` renders the same glyph table as HTML (`<span><svg>`), which cannot be placed inside an SVG `<g>`
 * without a `foreignObject` — and a foreignObject per node is exactly the kind of per-node layout cost this renderer
 * avoids. The geometry below therefore mirrors that table's `SHAPES` map 1:1 for an SVG-native 10×10 viewBox:
 * same shapes, same meaning, colour from the node's `burrow-tone-*` (`currentColor`).
 *
 * Keep in sync with `src/ui/status.tsx` when the shared table gains a shape.
 */
import type { Shape } from "~/design/status";

/** Glyph geometry on a 10×10 grid, matching `ui/status.tsx`'s `SHAPES`. */
export const STATUS_GLYPH_SHAPES: Record<Shape, React.ReactNode> = {
  disc: <circle cx="5" cy="5" r="3.6" fill="currentColor" />,
  ring: <circle cx="5" cy="5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.6" />,
  "ring-dash": <circle cx="5" cy="5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" />,
  half: (
    <>
      <circle cx="5" cy="5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 1.9a3.1 3.1 0 0 1 0 6.2z" fill="currentColor" />
    </>
  ),
  square: <rect x="1.8" y="1.8" width="6.4" height="6.4" rx="1.3" fill="currentColor" />,
  diamond: <path d="M5 .9 9.1 5 5 9.1.9 5z" fill="currentColor" />,
  cross: <path d="m2.4 2.4 5.2 5.2m0-5.2-5.2 5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  slash: (
    <>
      <circle cx="5" cy="5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.8 7.2 7.2 2.8" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  dash: <path d="M2 5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  triangle: <path d="M5 1.4 9.1 8.6H.9z" fill="currentColor" stroke="currentColor" strokeWidth=".6" strokeLinejoin="round" />,
  check: <path d="m2 5.3 2 2 4-4.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
};

export interface NodeStatusGlyphProps {
  shape: Shape;
  tone: string;
  /** top-left corner in the node's own coordinate space */
  x: number;
  y: number;
  size?: number;
  /** accessible description; the node's aria-label already carries the words, so this is a title only */
  title?: string;
}

/** A single status glyph. Colour comes from `--tone` via the `burrow-tone-*` class, so it survives forced-colors. */
export function NodeStatusGlyph({ shape, tone, x, y, size = 12, title }: NodeStatusGlyphProps) {
  return (
    <g
      className={`burrow-dag-glyph burrow-tone-${tone}`}
      data-glyph={shape}
      transform={`translate(${x} ${y}) scale(${(size / 10).toFixed(3)})`}
      pointerEvents="none"
    >
      {title ? <title>{title}</title> : null}
      {STATUS_GLYPH_SHAPES[shape]}
    </g>
  );
}

/** Glyph metrics live in `../render/scene` with the rest of the card geometry (`GLYPH_SIZE`, `GLYPH_GAP`). */
