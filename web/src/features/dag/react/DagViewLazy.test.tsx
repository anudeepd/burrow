import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dag, SqlPlanExecution } from "../types";

vi.mock("./DagView", () => ({ DagView: () => <div data-testid="lazy-dag-view" /> }));

const { DagViewLazy, preloadDagView } = await import("./DagViewLazy");

const DAG: Dag = {
  kind: "stage",
  granularity: "stage",
  stages: [
    {
      stageId: 1,
      skipped: false,
      label: "stage 1",
      clusters: [],
      nodes: [{ id: 1, name: "node 1", callsite: "", cached: false, clusterId: null }],
      edges: [{ from: 1, to: 2 }],
    },
  ],
  edges: [],
};
const SQL_PLAN: SqlPlanExecution = {
  id: 7,
  status: "COMPLETED",
  description: "SQL plan",
  nodes: [{ nodeId: 1, nodeName: "Scan", metrics: [] }],
  edges: [],
};

afterEach(cleanup);

describe("DagViewLazy", () => {
  it("shows its default-height loading panel and reuses the preloaded engine promise", async () => {
    const { container } = render(
      <>
        <DagViewLazy dag={DAG} />
        <DagViewLazy dag={SQL_PLAN} height={280} />
      </>,
    );
    const fallbacks = container.querySelectorAll(".burrow-dag");

    expect((fallbacks[0] as HTMLDivElement).style.height).toBe("420px");
    expect((fallbacks[1] as HTMLDivElement).style.height).toBe("280px");
    expect(screen.getByText("1 nodes · 1 edges")).toBeTruthy();
    expect(screen.getByText("1 nodes · 0 edges")).toBeTruthy();

    const first = preloadDagView();
    const second = preloadDagView();
    expect(second).toBe(first);
    await act(async () => first);
    await waitFor(() => expect(screen.getAllByTestId("lazy-dag-view")).toHaveLength(2));
  });
});
