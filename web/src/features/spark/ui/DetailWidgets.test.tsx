import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkTask, SparkTaskSummary } from "../data/schemas";
import { Entity } from "~/ui/datum";

const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { PlanTree } = await import("./PlanTree");
const { DistributionTable, distributionsOf } = await import("./TaskDistributions");
type DistMetric = import("./TaskDistributions").DistMetric;
const { TaskTable, taskColumns } = await import("./TaskTable");
const { parityStore } = await import("~/state/parity");
const copyModule = await import("~/lib/copy");

const FIXTURE = resolve(process.cwd(), "../fixtures/spark/3.5.9/dstream/rest");
const tasks = JSON.parse(readFileSync(`${FIXTURE}/final.stage-0-0.taskList.json`, "utf8")) as SparkTask[];
const summary = JSON.parse(readFileSync(`${FIXTURE}/final.stage-0-0.taskSummary.quantiles.json`, "utf8")) as SparkTaskSummary;
const wrap = (children: React.ReactNode) => <Entity id="stage-0">{children}</Entity>;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    vi.spyOn(copyModule, "copyText").mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();

    view.rerender(wrap(<PlanTree plan={null} q="" onQ={onQ} />));
    expect(screen.getByText(/carries no/)).toBeTruthy();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  it("covers empty searches, adjacent plan matches, and parity-visible children", () => {
    const onQ = vi.fn();
    const view = render(wrap(<PlanTree plan={"abc\nnothing\nabcabc"} q="" onQ={onQ} />));
    expect(view.container.textContent).toContain("3 lines");

    view.rerender(wrap(<PlanTree plan={"abc\nnothing\nabcabc"} q="abc" onQ={onQ} />));
    expect(view.container.querySelectorAll("mark")).toHaveLength(3);

    view.rerender(wrap(<PlanTree plan={"abc\n"} q="abc" onQ={onQ} />));
    expect(view.container.querySelectorAll("mark")).toHaveLength(1);

    view.rerender(wrap(<PlanTree plan={"Root\n+- Child"} q="absent" onQ={onQ} />));
    fireEvent.click(screen.getByRole("switch", { name: "Show only matching lines and their parents" }));

    view.rerender(wrap(<PlanTree plan={"Root\n+- Child"} q="" onQ={onQ} />));
    parityStore.setState(() => ({ enabled: true }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(view.container.textContent).toContain("Child");
  });

  it("clears the copied indicator after its timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(copyModule, "copyText").mockResolvedValue(true);
    render(wrap(<PlanTree plan="Root" q="" onQ={vi.fn()} />));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("renders quantile summaries and the task table's standard and additional metrics", () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:task-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const metrics = distributionsOf(summary);
    expect(metrics.length).toBeGreaterThan(10);
    expect(distributionsOf(undefined)).toEqual([]);
    expect(distributionsOf({ duration: [10] } as never)).toEqual([]);
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

  it("renders task error summaries and sparse distribution-series states", () => {
    parityStore.setState(() => ({ enabled: true }));
    const failedTask = { ...tasks[0]!, errorMessage: "Executor failed\nCaused by: disk error" };
    render(
      wrap(
        <TaskTable
          tasks={[failedTask]}
          label="Task error summary"
          tz="utc"
          showMore
          sorting={[]}
          onSortingChange={() => undefined}
          columnVisibility={{ error: true }}
          onColumnVisibilityChange={() => undefined}
          defaultVisibility={{ error: true }}
          exportName="task-errors"
        />,
      ),
    );
    expect(screen.getByText("Executor failed")).toBeTruthy();
    expect(screen.queryByText("Caused by: disk error")).toBeNull();
    cleanup();

    const errorCell = taskColumns({ tz: "utc", showMore: false }).find((column) => column.id === "error") as unknown as {
      cell: (context: { row: { original: SparkTask } }) => React.ReactNode;
    };
    render(wrap(errorCell.cell({ row: { original: failedTask } })));
    expect(screen.getByText("Executor failed")).toBeTruthy();
    cleanup();

    const missingSeries: DistMetric = { key: "missing", label: "Missing series", unit: "ms", field: "missing", series: null };
    const missingValue: DistMetric = {
      key: "missing-value",
      label: "Missing value",
      unit: "bytes",
      field: "missing-value",
      series: { quantiles: [0.5], values: [] },
    };
    const zeroValue: DistMetric = {
      key: "zero-value",
      label: "Zero value",
      unit: "count",
      field: "zero-value",
      series: { quantiles: [], values: [0] },
    };
    const empty = render(<DistributionTable metrics={[]} title="Empty distributions" />);
    expect(empty.container.firstChild).toBeNull();
    empty.unmount();

    render(
      wrap(
        <>
          <DistributionTable metrics={[missingSeries]} title="Missing series distributions" />
          <DistributionTable metrics={[missingValue]} title="Missing value distributions" />
          <DistributionTable metrics={[zeroValue]} />
        </>,
      ),
    );
    expect(screen.getByRole("region", { name: "Missing series distributions" })).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("formats numeric and string launch times and every speculative state", () => {
    const columns = taskColumns({ tz: "utc", showMore: true });
    const launch = columns.find((column) => column.id === "launchTime") as unknown as {
      accessorFn: (task: SparkTask, index: number) => number;
    };
    expect(launch.accessorFn({ ...tasks[0]!, launchTime: 123 }, 0)).toBe(123);
    expect(launch.accessorFn({ ...tasks[0]!, launchTime: "2026-11-03T00:00:00Z" }, 0)).toBe(Date.parse("2026-11-03T00:00:00Z"));

    const speculative = columns.find((column) => column.id === "speculative") as unknown as {
      cell: (context: { row: { original: SparkTask } }) => React.ReactNode;
    };
    const renderCell = (value: boolean | undefined) => speculative.cell({ row: { original: { ...tasks[0]!, speculative: value } } });
    render(
      wrap(
        <>
          {renderCell(true)}
          {renderCell(false)}
          {renderCell(undefined)}
        </>,
      ),
    );
    expect(screen.getByText("yes")).toBeTruthy();
    expect(screen.getByText("no")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("forwards optional loading, error, empty, toolbar, and row-version settings", () => {
    render(
      wrap(
        <TaskTable
          tasks={[]}
          label="Empty configurable tasks"
          tz="utc"
          showMore={false}
          sorting={[]}
          onSortingChange={() => undefined}
          columnVisibility={{}}
          onColumnVisibilityChange={() => undefined}
          defaultVisibility={{}}
          rowVersion={() => "v1"}
          totalCount={0}
          loading={false}
          error={<span>Task query error</span>}
          empty={<span>Empty task rows</span>}
          toolbar={<span>Task controls</span>}
          exportName="optional-task-settings"
        />,
      ),
    );
    expect(screen.getByRole("table", { name: "Empty configurable tasks" })).toBeTruthy();
  });
});
