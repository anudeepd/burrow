import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkTask, SparkTaskSummary } from "../data/schemas";
import { Entity } from "~/ui/datum";

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { PlanTree } = await import("./PlanTree");
const { DistributionTable, distributionsOf } = await import("./TaskDistributions");
const { TaskTable, taskColumns } = await import("./TaskTable");
const { parityStore } = await import("~/state/parity");
const copyModule = await import("~/lib/copy");

const FIXTURE = resolve(process.cwd(), "../fixtures/spark/3.5.9/dstream/rest");
const tasks = JSON.parse(readFileSync(`${FIXTURE}/final.stage-0-0.taskList.json`, "utf8")) as SparkTask[];
const summary = JSON.parse(readFileSync(`${FIXTURE}/final.stage-0-0.taskSummary.quantiles.json`, "utf8")) as SparkTaskSummary;
const wrap = (children: React.ReactNode) => <Entity id="stage-0">{children}</Entity>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  parityStore.setState(() => ({ enabled: false }));
});

describe("Spark detail widgets", () => {
  it("builds a searchable SQL plan tree, collapses children, copies it, and handles an absent plan", async () => {
    parityStore.setState(() => ({ enabled: false }));
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
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
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse plan lines under line 1" }));
    expect(screen.getByRole("button", { name: "Expand plan lines under line 1" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Expand plan lines under line 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    vi.spyOn(copyModule, "copyText").mockRejectedValueOnce(new Error("copy failed"));
    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();

    view.rerender(wrap(<PlanTree plan={null} q="" onQ={onQ} />));
    expect(screen.getByText(/carries no/)).toBeTruthy();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  it("renders quantile summaries and the task table's standard and additional metrics", () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:task-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
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

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(clickAnchor).toHaveBeenCalledTimes(2);
  });

  it("sorts and renders tasks whose optional metrics were omitted by Spark", () => {
    parityStore.setState(() => ({ enabled: true }));
    const sparseTask: SparkTask = {
      ...tasks[0]!,
      launchTime: undefined,
      taskMetrics: undefined,
      errorMessage: undefined,
      gettingResultTime: undefined,
      schedulerDelay: undefined,
      speculative: undefined,
    };
    const columns = taskColumns({ tz: "utc", showMore: true });
    for (const id of [
      "launchTime",
      "gcTime",
      "shuffleRead",
      "gettingResultTime",
      "schedulerDelay",
      "speculative",
      "resultSize",
      "peakExecutionMemory",
    ]) {
      const accessor = (
        columns.find((column) => column.id === id) as { accessorFn?: (row: typeof sparseTask, index: number) => unknown } | undefined
      )?.accessorFn;
      expect(accessor).toBeTypeOf("function");
      expect(accessor?.(sparseTask, 0)).toBe(id === "launchTime" || id === "shuffleRead" ? -1 : undefined);
    }

    render(
      wrap(
        <TaskTable
          tasks={[sparseTask]}
          label="Sparse task metrics"
          tz="utc"
          showMore
          sorting={[]}
          onSortingChange={() => undefined}
          columnVisibility={{}}
          onColumnVisibilityChange={() => undefined}
          defaultVisibility={{}}
          exportName="sparse-task"
        />,
      ),
    );
    const table = screen.getByRole("table", { name: "Sparse task metrics" });
    expect(table).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
