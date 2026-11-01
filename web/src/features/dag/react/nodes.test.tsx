import { describe, expect, it, vi } from "vitest";
import type { NodeVisual } from "../render/scene";
import { DagNode, type NodeProps } from "./nodes";

describe("DAG node memo comparison", () => {
  it("compares badge fields and rerenders when a badge changes", () => {
    const visual = {
      node: { id: "rdd-1", label: "RDD 1", kind: "rdd" },
      rect: { x: 0, y: 0, width: 120, height: 84 },
      tone: "idle",
      status: "COMPLETE",
      statusShape: "circle",
      statusLabel: "Complete",
      running: false,
      skipped: false,
      selected: false,
      hovered: false,
      dimmed: false,
      flash: null,
      percent: 0,
      tweenMs: 0,
      segments: [],
      taskSummary: null,
      badges: [{ key: "cached", text: "cached", tone: "fresh" }],
      subText: null,
      depth: 1,
      ariaLabel: "RDD 1",
      labels: [],
      related: false,
    } as unknown as NodeVisual;
    const props: NodeProps = {
      visual,
      labels: [],
      tabbable: true,
      onActivate: vi.fn(),
      onHover: vi.fn(),
      onFocus: vi.fn(),
    };
    const compare = (DagNode as unknown as { compare: (prev: NodeProps, next: NodeProps) => boolean }).compare;

    expect(compare(props, { ...props, visual: { ...visual, badges: [...visual.badges] } })).toBe(true);
    expect(
      compare(props, {
        ...props,
        visual: { ...visual, badges: [{ key: "det", text: "unordered", tone: "warn" }] },
      }),
    ).toBe(false);
  });
});
