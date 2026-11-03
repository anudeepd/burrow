import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeSegments, ProgressBar } from "./progress-bar";

afterEach(() => cleanup());

describe("progress bars", () => {
  it("clamps determinate progress and markers to the track", () => {
    render(
      <ProgressBar
        label="Memory"
        percent={140}
        tone="warn"
        valueText="over capacity"
        markers={[
          { percent: -4, className: "low" },
          { percent: Number.NaN, className: "unknown" },
          { percent: 120, className: "high" },
        ]}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Memory" });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.getAttribute("aria-valuetext")).toBe("over capacity");
    expect(bar.querySelector(".burrow-thread-fill")?.getAttribute("style")).toContain("width: 100%");
    const markers = [...bar.querySelectorAll(".burrow-progress-marker")];
    expect(markers).toHaveLength(3);
    expect(markers.map((marker) => marker.classList.contains("low"))).toEqual([true, false, false]);
    expect(markers.map((marker) => marker.classList.contains("unknown"))).toEqual([false, true, false]);
    expect(markers.map((marker) => marker.classList.contains("high"))).toEqual([false, false, true]);
  });

  it("renders non-finite progress as zero", () => {
    render(<ProgressBar label="Unknown progress" percent={Number.NaN} />);
    expect(screen.getByRole("progressbar", { name: "Unknown progress" }).getAttribute("aria-valuenow")).toBe("0");
  });

  it("normalizes segmented progress whether the sum is finite or overflows", () => {
    expect(
      normalizeSegments([
        { percent: 80, tone: "ok", label: "done" },
        { percent: 40, tone: "wait", label: "pending" },
        { percent: Number.NaN, tone: "fail", label: "invalid" },
        { percent: -10, tone: "idle", label: "negative" },
      ]).map((segment) => segment.percent),
    ).toEqual([200 / 3, 100 / 3, 0, 0]);

    const overflow = normalizeSegments([
      { percent: Number.MAX_VALUE, tone: "ok", label: "left" },
      { percent: Number.MAX_VALUE, tone: "fail", label: "right" },
    ]);
    expect(overflow.map((segment) => segment.percent)).toEqual([50, 50]);
  });

  it("renders segment values and accessibility text", () => {
    render(
      <ProgressBar
        label="Tasks"
        percent={0}
        live
        segments={[
          { percent: 2, tone: "ok", label: "done" },
          { percent: 1, tone: "wait", label: "pending" },
        ]}
        datum={{ "data-yf": "tasks.total", "data-yv": "3" }}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Tasks" });
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(bar.getAttribute("aria-valuetext")).toBe("done 2%, pending 1%");
    expect(bar.getAttribute("data-segments")).toBe("true");
    expect(bar.getAttribute("data-yv")).toBe("3");
    expect(bar.querySelectorAll(".burrow-tone-ok, .burrow-tone-wait")).toHaveLength(2);
  });
});
