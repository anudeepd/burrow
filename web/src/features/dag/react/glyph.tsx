/**
 * The node's status glyph: the *shape* half of the status language, drawn inside the SVG canvas.
 *
 * `src/ui/status.tsx` renders the same shared glyph table as HTML (`<span><svg>`), which cannot be placed inside an SVG
 * `<g>` without a `foreignObject` — and a foreignObject per node is exactly the kind of per-node layout cost this
 * renderer avoids. The shared geometry is SVG-native on a 10×10 viewBox; colour comes from the node's `burrow-tone-*`.
 */
import type { Shape } from "~/design/status";
import { STATUS_GLYPH_SHAPES } from "~/ui/status-glyph";

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
