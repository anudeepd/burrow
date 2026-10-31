import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkTask, SparkTaskSummary } from "../data/schemas";
import { Entity } from "~/ui/datum";

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { PlanTree } = await import("./PlanTree");
const { DistributionTable, distributionsOf } = await import("./TaskDistributions");
const { TaskTable } = await import("./TaskTable");

const FIXTURE = resolve(process.cwd(), "../fixtures/spark/3.5.9/dstream/rest");
const tasks = JSON.parse(readFileSync(`${FIXTURE}/final.stage-0-0.taskList.json`, "utf8")) as SparkTask[];
const summary = JSON.parse(readFileSync(`${FIXTURE}/final.stage-0-0.taskSummary.quantiles.json`, "utf8")) as SparkTaskSummary;
const wrap = (children: React.ReactNode) => <Entity id="stage-0">{children}</Entity>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Spark detail widgets", () => {
  it("builds a searchable SQL plan tree, collapses children, and handles an absent plan", () => {
    const onQ = vi.fn();
    const plan = `Root\n+- Project [id#1]\n   +- Scan table [id#1]`;
    const view = render(wrap(<PlanTree plan={plan} q="Scan" onQ={onQ} />));

    expect(view.container.textContent).toContain("1 matching lines");
    const input = screen.getByRole("searchbox", { name: "Find in the SQL plan" });
    fireEvent.change(input, { target: { value: "Project" } });
    expect(onQ).toHaveBeenCalledWith("Project");
    view.rerender(wrap(<PlanTree plan={plan} q="Project" onQ={onQ} />));
    fireEvent.click(screen.getByRole("switch", { name: "Show only matching lines and their parents" }));
    expect(screen.getByText("Project", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse plan lines under line 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(view.container.textContent).toContain("1 matching lines");

    view.rerender(wrap(<PlanTree plan={null} q="" onQ={onQ} />));
    expect(screen.getByText(/carries no/)).toBeTruthy();
  });

  it("renders quantile summaries and the task table's standard and additional metrics", () => {
    const metrics = distributionsOf(summary);
    expect(metrics.length).toBeGreaterThan(10);
    const sorting = [{ id: "duration", desc: true }];
    const onSortingChange = vi.fn();
    const onColumnVisibilityChange = vi.fn();
    render(
      wrap(
        <>
          <DistributionTable metrics={metrics} title="Task distribution" />
          <TaskTable
            tasks={tasks.slice(0, 12)}
            label="Captured stage tasks"
            tz="utc"
            showMore
            sorting={sorting}
            onSortingChange={onSortingChange}
            columnVisibility={{}}
            onColumnVisibilityChange={onColumnVisibilityChange}
            defaultVisibility={{}}
            totalCount={tasks.length}
            exportName="stage-tasks"
          />
        </>,
      ),
    );

    expect(screen.getByRole("region", { name: "Task distribution" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Duration:/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Getting Result Time/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Shuffle Read/ })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Captured stage tasks" })).toBeTruthy();
  });
});
