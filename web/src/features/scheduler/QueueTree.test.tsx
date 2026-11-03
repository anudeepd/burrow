import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { SiblingSort } from "./QueueTree";

window.__BURROW_PARITY__ = true;
const { QueueTree, QueueTreeA11y } = await import("./QueueTree");
const { toQueueRows } = await import("./columns");
afterEach(cleanup);

const root = {
  id: "root",
  name: "root",
  depth: 0,
  role: "root",
  children: [
    { id: "root.z", name: "z", depth: 1, role: "leaf", children: [] },
    { id: "root.a", name: "a", depth: 1, role: "leaf", children: [] },
  ],
};

describe("queue tree sibling order and accessible hierarchy", () => {
  it("sorts siblings by used, free, and active applications when metrics are absent", () => {
    const onActivate = vi.fn();
    function Harness() {
      const [sort, setSort] = useState<SiblingSort>("name");
      return (
        <QueueTree
          root={root as never}
          kind="capacity"
          partition=""
          scale={100}
          isOpen={() => true}
          onToggle={vi.fn()}
          sort={sort}
          onSortChange={setSort}
          sorting={[]}
          onSortingChange={vi.fn()}
          columnVisibility={undefined}
          onColumnVisibilityChange={vi.fn()}
          onActivate={onActivate}
        />
      );
    }

    render(<Harness />);
    const table = screen.getByRole("table", { name: "Capacity scheduler queue tree" });
    const order = within(screen.getByRole("group", { name: "Sibling order" }));
    fireEvent.click(order.getByRole("button", { name: "Used" }));
    fireEvent.click(order.getByRole("button", { name: "Free" }));
    fireEvent.click(order.getByRole("button", { name: "Apps" }));
    expect(table.textContent).toContain("root");
    expect(table.textContent).toContain("a");
    expect(table.textContent).toContain("z");
    fireEvent.click(table.querySelector('[data-ye="root.a"]')!);
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: "root.a" }));
  });

  it("shows unavailable usage and fair-share hints in the accessible tree", () => {
    const capacityRoot = { ...root, capacity: {} };
    render(<QueueTreeA11y root={capacityRoot as never} isOpen={() => true} />);

    expect(screen.getByRole("tree", { name: "Queue hierarchy" }).textContent).toContain("no usage reported");
    expect(screen.getByRole("tree", { name: "Queue hierarchy" }).textContent).toContain("freeness unknown");
    cleanup();

    const usedCapacityRoot = {
      ...root,
      capacity: { usedCapacity: 20, absoluteUsedCapacity: 20, absoluteCapacity: 100 },
    };
    render(<QueueTreeA11y root={usedCapacityRoot as never} isOpen={() => true} />);
    expect(screen.getByRole("tree", { name: "Queue hierarchy" }).textContent).toContain("80.0% free inside its share");
    cleanup();

    const fairRoot = {
      ...root,
      fair: {
        queueName: "root",
        fairResources: { memory: 1024 },
        usedResources: { memory: 256 },
      },
    };
    render(<QueueTreeA11y root={fairRoot as never} isOpen={() => true} />);
    expect(screen.getByRole("tree", { name: "Queue hierarchy" }).textContent).toContain("768 MB free of its fair share");
    cleanup();

    render(
      <QueueTree
        root={root as never}
        kind="fair"
        partition=""
        scale={100}
        isOpen={() => true}
        onToggle={() => undefined}
        sort="name"
        onSortChange={() => undefined}
        sorting={[]}
        onSortingChange={() => undefined}
        columnVisibility={undefined}
        onColumnVisibilityChange={() => undefined}
        onActivate={() => undefined}
      />,
    );
    expect(screen.getByRole("table", { name: "Fair scheduler queue tree" })).toBeTruthy();
  });

  it("renders capacity preemption and fair utilization values from queue metrics", () => {
    const capacityRoot = { ...root, capacity: { intraQueuePreemptionDisabled: false } };
    expect(toQueueRows([capacityRoot as never])[0]?.node.id).toBe("root");
    render(
      <QueueTree
        root={capacityRoot as never}
        kind="capacity"
        partition=""
        scale={100}
        isOpen={() => true}
        onToggle={() => undefined}
        sort="name"
        onSortChange={() => undefined}
        sorting={[]}
        onSortingChange={() => undefined}
        columnVisibility={{ preemption: true }}
        onColumnVisibilityChange={() => undefined}
        onActivate={() => undefined}
      />,
    );
    expect(screen.getByRole("table", { name: "Capacity scheduler queue tree" }).textContent).toContain("on");
    cleanup();

    const fairInfo = (queueName: string, fairMb: number, usedMb: number | undefined, minMb: number) => ({
      queueName,
      fairResources: { memory: fairMb },
      usedResources: usedMb === undefined ? undefined : { memory: usedMb },
      minResources: { memory: minMb },
    });
    const fairRoot = {
      ...root,
      fair: fairInfo("root", 512, 256, 128),
      children: [
        { ...root.children[0], fair: fairInfo("root.z", 512, 256, 128) },
        { ...root.children[1], fair: fairInfo("root.a", 0, undefined, 0) },
        { id: "root.m", name: "m", depth: 1, role: "leaf", children: [], fair: fairInfo("root.m", 512, undefined, 128) },
      ],
    };
    render(
      <QueueTree
        root={fairRoot as never}
        kind="fair"
        partition=""
        scale={1024}
        isOpen={() => true}
        onToggle={() => undefined}
        sort="name"
        onSortChange={() => undefined}
        sorting={[]}
        onSortingChange={() => undefined}
        columnVisibility={{ usedOfFair: true, usedOfMin: true }}
        onColumnVisibilityChange={() => undefined}
        onActivate={() => undefined}
      />,
    );
    const fairTable = screen.getByRole("table", { name: "Fair scheduler queue tree" });
    expect(fairTable.textContent).toContain("50.0%");
    expect(fairTable.textContent).toContain("—");
  });
});
