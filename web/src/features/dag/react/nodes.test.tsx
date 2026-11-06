import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { NodeVisual } from "../render/scene";
import { DagNode, ClusterFrame, type NodeProps } from "./nodes";

function makeVisual(overrides: Partial<NodeVisual> = {}): NodeVisual {
  return {
    node: { id: "n1", label: "RDD 1", kind: "rdd", detail: "Range (0, 100)", cached: true },
    rect: { x: 12, y: 18, width: 220, height: 158 },
    tone: "ok",
    status: "COMPLETE",
    statusShape: "disc",
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
    badges: [],
    subText: null,
    depth: 1,
    ariaLabel: "RDD 1, complete",
    labels: [],
    related: false,
    ...overrides,
  };
}

function props(visual = makeVisual(), overrides: Partial<NodeProps> = {}): NodeProps {
  return {
    visual,
    labels: [
      { id: "n1#title", text: "RDD 1", x: 40, y: 50, width: 150, height: 18, priority: 1 },
      { id: "n1#sub", text: "Source RDD", x: 40, y: 80, width: 150, height: 18, priority: 0 },
    ],
    tabbable: true,
    onActivate: vi.fn(),
    onHover: vi.fn(),
    onFocus: vi.fn(),
    ...overrides,
  };
}
function renderDagNode(node: ReactNode) {
  return render(
    <svg role="group" aria-label="DAG node test host">
      {node}
    </svg>,
  );
}

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

  it("compares node, label, segment, and badge fields before reusing the rendered card", () => {
    const compare = (DagNode as unknown as { compare: (prev: NodeProps, next: NodeProps) => boolean }).compare;
    const visual = makeVisual({
      segments: [{ percent: 25, tone: "ok", label: "complete" }],
      badges: [{ key: "cached", text: "cached", tone: "fresh" }],
    });
    const base = props(visual);
    expect(compare(base, base)).toBe(true);
    expect(compare(base, { ...base, visible: false })).toBe(false);
    expect(compare({ ...base, visible: false }, { ...base, visible: undefined })).toBe(false);
    expect(compare(base, { ...base, labels: [{ ...base.labels[0]!, x: 99 }, base.labels[1]!] })).toBe(false);
    expect(compare(base, { ...base, labels: [] })).toBe(false);
    expect(compare(base, { ...base, labels: base.labels.map((label) => ({ ...label })) })).toBe(true);
    expect(compare(base, { ...base, labels: base.labels.map((label, index) => (index ? label : { ...label, id: "changed" })) })).toBe(
      false,
    );
    expect(compare(base, { ...base, labels: base.labels.map((label, index) => (index ? label : { ...label, text: "changed" })) })).toBe(
      false,
    );
    expect(compare(base, { ...base, labels: base.labels.map((label, index) => (index ? label : { ...label, y: 99 })) })).toBe(false);
    expect(compare(base, { ...base, visual: { ...visual, segments: visual.segments.map((segment) => ({ ...segment })) } })).toBe(true);
    expect(compare(base, { ...base, visual: { ...visual, badges: visual.badges.map((badge) => ({ ...badge })) } })).toBe(true);
    expect(compare(base, { ...base, visual: { ...visual, badges: [] } })).toBe(false);

    const visualFields: Partial<NodeVisual>[] = [
      { tone: "live" },
      { status: "RUNNING" },
      { running: true },
      { skipped: true },
      { selected: true },
      { hovered: true },
      { dimmed: true },
      { flash: "fail" },
      { percent: 1 },
      { taskSummary: "1 / 2 tasks" },
      { subText: "different" },
      { ariaLabel: "different" },
      { rect: { ...visual.rect, x: 1 } },
      { rect: { ...visual.rect, y: 1 } },
      { rect: { ...visual.rect, width: 1 } },
      { rect: { ...visual.rect, height: 1 } },
    ];
    for (const change of visualFields) expect(compare(base, { ...base, visual: { ...visual, ...change } })).toBe(false);
    expect(compare(base, { ...base, visual: { ...visual, segments: [{ percent: 30, tone: "ok", label: "complete" }] } })).toBe(false);
    expect(compare(base, { ...base, visual: { ...visual, segments: [{ percent: 25, tone: "fail", label: "complete" }] } })).toBe(false);
    expect(compare(base, { ...base, visual: { ...visual, segments: [{ percent: 25, tone: "ok", label: "failed" }] } })).toBe(false);
    expect(compare(base, { ...base, visual: { ...visual, badges: [{ key: "det", text: "cached", tone: "fresh" }] } })).toBe(false);
    expect(compare(base, { ...base, visual: { ...visual, badges: [{ key: "cached", text: "other", tone: "fresh" }] } })).toBe(false);
    expect(compare(base, { ...base, visual: { ...visual, badges: [{ key: "cached", text: "cached", tone: "idle" }] } })).toBe(false);
    expect(compare(base, { ...base, visual: { ...visual, segments: [], badges: [] } })).toBe(false);
  });
});

describe("DAG node rendering", () => {
  it("renders rich running RDD metadata, progress, and keyboard and pointer activation", () => {
    const p = props(
      makeVisual({
        running: true,
        flash: "live",
        percent: 72,
        tweenMs: 250,
        taskSummary: "18 / 24 tasks",
        subText: null,
        segments: [
          { percent: 50, tone: "ok", label: "complete" },
          { percent: 22, tone: "live", label: "active" },
          { percent: -5, tone: "idle", label: "clamped" },
        ],
        badges: [
          { key: "sw", text: "↑ 12 MB", tone: "idle", title: "Shuffle Write" },
          { key: "sr", text: "↓ 4 MB", tone: "idle" },
          { key: "dur", text: "1s", tone: "idle" },
          { key: "metrics", text: "2 metrics", tone: "idle" },
          { key: "cached", text: "cached", tone: "fresh" },
        ],
      }),
    );
    const view = renderDagNode(<DagNode {...p} />);
    const item = view.getByRole("treeitem");
    expect(item.getAttribute("data-roomy")).toBe("true");
    expect(view.container.querySelector("[data-flash='true']")).not.toBeNull();
    expect(view.container.querySelector(".burrow-dag-node-hatch")).not.toBeNull();
    expect(view.container.querySelectorAll(".burrow-dag-progress-seg")).toHaveLength(3);
    expect(view.container.querySelector(".burrow-dag-progress")?.getAttribute("aria-valuetext")).toContain("complete 50%");
    expect(view.container.querySelector("[data-row='metadata-primary']")?.textContent).toContain("24 partitions");
    expect(view.container.querySelector("[data-row='metadata-secondary']")?.textContent).toContain("18 / 24 complete");
    fireEvent.pointerEnter(item);
    fireEvent.pointerLeave(item);
    fireEvent.focus(item);
    fireEvent.click(item);
    fireEvent.keyDown(item, { key: "Enter" });
    fireEvent.keyDown(item, { key: " " });
    fireEvent.keyDown(item, { key: "Escape" });
    expect(p.onHover).toHaveBeenNthCalledWith(1, "n1");
    expect(p.onHover).toHaveBeenNthCalledWith(2, null);
    expect(p.onFocus).toHaveBeenCalledWith("n1");
    expect(p.onActivate).toHaveBeenCalledTimes(3);
  });

  it("renders compact, medium, hidden, ghost, and progress-only variants", () => {
    const compact = renderDagNode(
      <DagNode
        {...props(
          makeVisual({
            rect: { x: 0, y: 0, width: 140, height: 60 },
            subText: "Long compact subtext",
            taskSummary: "3 tasks",
            percent: 45,
          }),
        )}
      />,
    );
    expect(compact.container.querySelector("[data-compact='true']")).not.toBeNull();
    expect(compact.container.querySelector("[data-row='metadata-primary']")).toBeNull();
    expect(compact.container.querySelector(".burrow-dag-progress-seg")).not.toBeNull();
    compact.unmount();

    const mediumProps = props(
      makeVisual({
        node: { id: "n1", label: "Medium", kind: "sql" },
        rect: { x: 0, y: 0, width: 130, height: 100 },
        subText: "A rather long operator detail",
        taskSummary: "4 tasks",
        badges: [{ key: "det", text: "unordered", tone: "warn" }],
      }),
    );
    mediumProps.labels[1] = { ...mediumProps.labels[1]!, width: 20 };
    const medium = renderDagNode(<DagNode {...mediumProps} />);
    expect(medium.container.querySelector("[data-roomy='false']")).not.toBeNull();
    expect(medium.container.querySelector("[data-label='sub']")?.lastChild?.textContent).toBe("A…");
    medium.unmount();

    const hidden = renderDagNode(
      <DagNode
        {...props(makeVisual({ percent: 60, taskSummary: "6 tasks", segments: [{ percent: 0, tone: "idle", label: "idle" }] }))}
        visible={false}
      />,
    );
    expect(hidden.container.querySelector("[data-label='title']")).toBeNull();
    expect(hidden.container.querySelector(".burrow-dag-progress-track")).toBeNull();
    hidden.unmount();

    const ghost = renderDagNode(
      <DagNode {...props(makeVisual({ node: { id: "g", label: "External", kind: "ghost" }, percent: 20, taskSummary: null }))} />,
    );
    expect(ghost.container.querySelector(".burrow-dag-progress")).toBeNull();
    ghost.unmount();

    const noText = renderDagNode(
      <DagNode
        {...props(
          makeVisual({
            node: { id: "x", label: "No labels", kind: "stage" },
            rect: { x: 0, y: 0, width: 90, height: 84 },
            taskSummary: null,
          }),
        )}
        labels={[]}
      />,
    );
    expect(noText.container.querySelector("[data-label='title']")).toBeNull();
    expect(noText.container.querySelector(".burrow-dag-progress-track")).toBeNull();
    noText.unmount();

    const wideMeta = renderDagNode(
      <DagNode
        {...props(
          makeVisual({
            rect: { x: 0, y: 0, width: 1000, height: 158 },
            taskSummary: "18 / 24 tasks",
            badges: [{ key: "cached", text: "cached", tone: "fresh" }],
          }),
        )}
      />,
    );
    expect(wideMeta.container.querySelector("[data-row='metadata-primary'] title")).toBeNull();
    expect(wideMeta.container.querySelector("[data-row='metadata-secondary'] title")).toBeNull();
    wideMeta.unmount();

    const truncatedMeta = renderDagNode(
      <DagNode
        {...props(makeVisual({ rect: { x: 0, y: 0, width: 100, height: 158 }, subText: "Custom detail", taskSummary: "Many, many tasks" }))}
      />,
    );
    expect(truncatedMeta.container.querySelector("[data-row='metadata-secondary']")?.lastChild?.textContent).toBe("Many,…");
    truncatedMeta.unmount();

    const sameSubSummary = renderDagNode(
      <DagNode {...props(makeVisual({ subText: "3 tasks", taskSummary: "3 tasks" }))} tabbable={false} />,
    );
    expect(sameSubSummary.container.querySelector(".burrow-dag-node")?.getAttribute("tabindex")).toBe("-1");
    expect(sameSubSummary.container.querySelector("[data-row='metadata-secondary']")).toBeNull();
  });

  it("draws optional cluster detail only when supplied", () => {
    const view = render(
      <svg role="img" aria-label="Cluster frames">
        <ClusterFrame x={1} y={2} width={30} height={40} label="Stage" depth={1} dimmed={false} detail="4 tasks" />
      </svg>,
    );
    expect(view.container.querySelector("title")?.textContent).toBe("Stage · 4 tasks");
    view.rerender(
      <svg role="img" aria-label="Cluster frames">
        <ClusterFrame x={1} y={2} width={30} height={40} label="Stage" depth={1} dimmed={true} />
      </svg>,
    );
    expect(view.container.querySelector("title")).toBeNull();
  });
});
