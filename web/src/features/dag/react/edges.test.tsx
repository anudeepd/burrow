import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CANVAS_THRESHOLD, HARD_LIMIT } from "../dag-model";
import type { EdgeVisual } from "../render/scene";
import { CanvasEdgeLayer, EdgeLayer, dashPhase, renderStrategy } from "./edges";

const point = (x: number, y: number) => ({ x, y });
function edge(id: string, overrides: Partial<EdgeVisual> = {}): EdgeVisual {
  return {
    edge: { id, from: `${id}-a`, to: `${id}-b`, kind: "flow", fromStage: 1, toStage: 2 },
    points: [point(10, 20), point(40, 50)],
    path: "M 10 20 L 40 50",
    arrow: { d: "M 40 50 L 35 45" } as EdgeVisual["arrow"],
    flowing: true,
    intensity: 0.5,
    opacity: 0.8,
    dashArray: "5 3",
    animationSeconds: 1,
    travel: 24,
    selected: false,
    hovered: false,
    dimmed: false,
    shuffleLabel: null,
    labels: [{ id: `label-${id}`, text: `label ${id}`, x: 20, y: 30, width: 36, height: 14, priority: 1 }],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DAG edge layers", () => {
  it("selects the SVG, canvas, and hard-limit strategies and wraps dash phase", () => {
    expect(renderStrategy(CANVAS_THRESHOLD).edges).toBe("svg");
    expect(renderStrategy(CANVAS_THRESHOLD + 1).edges).toBe("canvas");
    expect(renderStrategy(CANVAS_THRESHOLD + 1).plainNodes).toBe(false);
    expect(renderStrategy(HARD_LIMIT + 1).plainNodes).toBe(true);
    expect(dashPhase(0, 12, 20)).toBe(-0);
    expect(dashPhase(1000, 12, 20)).toBe(-8);
    expect(dashPhase(10, 0, 20)).toBe(0);
  });

  it("renders and activates SVG edges with optional flow, arrow, labels, and stage batches", () => {
    const onHover = vi.fn();
    const onActivate = vi.fn();
    const edges = [
      edge("flowing"),
      edge("static", {
        edge: { id: "static", from: "s-a", to: "s-b", kind: "rdd", fromStage: 2 },
        flowing: false,
        arrow: null,
        labels: [],
      }),
    ];
    const { container } = render(
      <svg aria-label="DAG edges">
        <EdgeLayer edges={edges} showLabels interactive onHover={onHover} onActivate={onActivate} />
      </svg>,
    );
    expect(container.querySelectorAll(".burrow-dag-edge")).toHaveLength(2);
    expect(container.querySelectorAll(".burrow-dag-edge-flow")).toHaveLength(1);
    expect(container.querySelectorAll(".burrow-dag-arrow")).toHaveLength(1);
    expect(screen.getByText("label flowing")).toBeTruthy();
    const hit = container.querySelector(".burrow-dag-edge-hit")!;
    fireEvent.pointerEnter(hit);
    fireEvent.pointerLeave(hit);
    fireEvent.click(hit);
    expect(onHover).toHaveBeenNthCalledWith(1, "flowing");
    expect(onHover).toHaveBeenNthCalledWith(2, null);
    expect(onActivate).toHaveBeenCalledWith(edges[0]);
  });

  it("draws static and flowing canvas segments, then stops the animation loop when unmounted", () => {
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      globalAlpha: 1,
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineDashOffset: 0,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    let frame: FrameRequestCallback | undefined;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 9;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const flowing = edge("canvas-flow", { dimmed: true });
    const staticEdge = edge("canvas-static", { flowing: false, dimmed: false, points: [point(1, 1)] });
    const view = render(
      <CanvasEdgeLayer
        edges={[flowing, staticEdge]}
        viewport={{ x: 0, y: 0, scale: 1 }}
        size={{ width: 300, height: 200 }}
        reducedMotion={false}
        now={1000}
      />,
    );
    expect(ctx.stroke).toHaveBeenCalledOnce();
    expect(ctx.globalAlpha).toBe(1);
    expect(raf).toHaveBeenCalledOnce();
    frame?.(500);
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(cancel).toHaveBeenCalledWith(9);
  });

  it("keeps reduced-motion and offscreen canvas drawings static", () => {
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      globalAlpha: 1,
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineDashOffset: 0,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const view = render(
      <CanvasEdgeLayer
        edges={[edge("static-motion", { flowing: true })]}
        viewport={{ x: 0, y: 0, scale: 0.5 }}
        size={{ width: 10, height: 10 }}
        reducedMotion
        inView={false}
        now={0}
      />,
    );
    expect(ctx.stroke).toHaveBeenCalledOnce();
    expect(ctx.lineDashOffset).toBe(0);
    expect(raf).not.toHaveBeenCalled();
    view.unmount();
  });
});
