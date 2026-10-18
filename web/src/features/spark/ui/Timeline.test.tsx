/**
 * Structural guard for the timeline's SVG paint.
 *
 * The bars paint with `fill="var(--tone)"` / `stroke="var(--tone)"`, so the row's tone class has to be in scope inside
 * the chart cell — without it the paint falls back to the SVG initial value (black) in both themes, which is exactly
 * what shipped once.
 *
 * Parity mode is on (`window.__BURROW_PARITY__`) so the chart renders every row instead of a virtual window (jsdom has no
 * layout, so the virtualizer would otherwise render nothing).
 */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineBar, TimelineRow } from "./Timeline";

window.__BURROW_PARITY__ = true;

const { TimelineChart } = await import("./Timeline");

/** A job bar with the defaults filled in; `over` picks the tone and which branch of `Bar` is exercised. */
const bar = (over: Partial<TimelineBar> & { key: string }): TimelineBar => ({
  kind: "bar",
  group: "jobs",
  entity: over.key,
  label: `Job ${over.key}`,
  name: `Job ${over.key}`,
  tone: "ok",
  start: 1_000,
  end: 2_000,
  startField: "spark.job.submissionTime",
  endField: "spark.job.completionTime",
  durationField: "spark.job.durationMs",
  durationMs: 1_000,
  ...over,
});

const ROWS: TimelineRow[] = [
  { kind: "header", key: "h", group: "jobs", label: "Jobs (4)" },
  bar({ key: "succeeded", tone: "ok" }), // the plain rect
  bar({ key: "running", tone: "live", end: null, open: true }), // the zero-width tick (no end reported)
  bar({ key: "open", tone: "wait", open: true }), // the rect plus its dashed "still running" tail
  bar({ key: "skipped", tone: "idle", ghost: true, start: null, end: null }), // the dashed skipped marker
];

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TimelineChart", () => {
  it("keeps the row tone in scope for every element that paints with var(--tone)", () => {
    const { container } = render(
      <TimelineChart
        rows={ROWS}
        bounds={[0, 4_000]}
        window={[0, 4_000]}
        zoom={1}
        tz="local"
        onZoom={() => undefined}
        onPan={() => undefined}
        onSelectRange={() => undefined}
        onFit={() => undefined}
        label="Timeline"
      />,
    );

    const painted = [...container.querySelectorAll('svg [fill="var(--tone)"], svg [stroke="var(--tone)"]')];
    expect(painted.length).toBeGreaterThan(0);
    for (const el of painted) {
      expect(
        el.closest('[class*="burrow-tone-"]'),
        `${el.tagName} paints var(--tone) with no tone class in scope (renders black in both themes)`,
      ).not.toBeNull();
    }
  });
});
