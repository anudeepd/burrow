import type { Shape } from "~/design/status";

/** Shared SVG geometry for status dots and the DAG's status glyphs. */
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
  triangle: <path d="M5 1.4 9.1 8.6H.9z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth=".6" />,
  check: <path d="m2 5.3 2 2 4-4.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
};
