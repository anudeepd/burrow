import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AreaChart } from "./charts";

describe("AreaChart sample inspection", () => {
  it("keeps the plotted trace close to its axis labels", () => {
    const { container } = render(
      <AreaChart
        points={[
          { t: 0, v: 10 },
          { t: 10, v: 20 },
          { t: 20, v: 30 },
        ]}
        width={320}
        height={72}
        domain={[0, 100]}
        label="Memory history"
      />,
    );
    const linePath = container.querySelectorAll("path")[1]?.getAttribute("d") ?? "";
    const endpointX = linePath.match(/([\d.]+),([\d.]+)$/)?.[1];

    expect(endpointX).toBe("288");
    expect(container.querySelectorAll("path")[1]?.getAttribute("stroke-linecap")).toBe("round");
  });

  it("tracks the pointer between samples instead of snapping to a recorded point", () => {
    const points = [
      { t: 0, v: 10 },
      { t: 10, v: 20 },
      { t: 20, v: 30 },
    ];
    const { container } = render(
      <AreaChart
        points={points}
        width={320}
        height={72}
        domain={[0, 100]}
        label="Memory history"
        sampleAriaLabel="Memory samples"
        sampleTooltip={(point) => `${point.t.toFixed(1)}:${point.v.toFixed(1)}`}
      />,
    );
    const svg = screen.getByRole("group", { name: "Memory history" });
    const slider = screen.getByRole("slider", { name: "Memory samples" });
    Object.defineProperty(svg, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 72,
        width: 320,
        height: 72,
        toJSON: () => ({}),
      }),
    });

    // x=75 in the 320-unit viewBox maps to t=5, halfway between the first two samples.
    fireEvent.pointerMove(slider, { clientX: 75, clientY: 36, pointerId: 1 });

    expect(slider.getAttribute("aria-valuetext")).toBe("5.0:15.0");
    expect(container.querySelector("circle")?.getAttribute("cx")).toBe("75");
  });

  it("labels both ends of the time axis when a formatter is provided", () => {
    const { container } = render(
      <AreaChart
        points={[
          { t: 1000, v: 10 },
          { t: 2000, v: 20 },
        ]}
        width={320}
        height={72}
        domain={[0, 100]}
        label="Memory history"
        timeLabel={(t) => (t === 1000 ? "start" : "end")}
      />,
    );
    const svg = container.querySelector("svg");
    const labels = Array.from(container.querySelectorAll("text"), (text) => text.textContent);

    expect(svg?.getAttribute("viewBox")).toBe("0 0 320 84");
    expect(labels).toContain("start");
    expect(labels).toContain("end");
  });
});
