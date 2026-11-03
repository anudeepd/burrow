import { Fragment, type ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SparkStage } from "../data/schemas";
import { Entity } from "~/ui/datum";
import { firstLine, stageColumns, type StageColumnOptions } from "./StageTable";

afterEach(cleanup);

const baseStage = {
  stageId: 4,
  status: "FAILED",
  name: "Parse records",
  description: undefined,
  submissionTime: undefined,
  numTasks: undefined,
  numCompletedIndices: undefined,
  numCompleteTasks: undefined,
  numActiveTasks: undefined,
  numFailedTasks: undefined,
  numKilledTasks: undefined,
  inputBytes: undefined,
  inputRecords: undefined,
  outputBytes: undefined,
  outputRecords: undefined,
  shuffleReadBytes: undefined,
  shuffleReadRecords: undefined,
  shuffleWriteBytes: undefined,
  shuffleWriteRecords: undefined,
  memoryBytesSpilled: undefined,
  diskBytesSpilled: undefined,
  jvmGcTime: undefined,
  failureReason: undefined,
} as SparkStage;

function evaluateCells(stage: SparkStage, options: StageColumnOptions) {
  const columns = stageColumns(options);
  const cells = columns.flatMap((column) => {
    const exportValue = column.meta?.exportValue as unknown as ((row: SparkStage) => unknown) | undefined;
    exportValue?.(stage);
    const accessor = (column as unknown as { accessorFn?: (row: SparkStage) => unknown }).accessorFn;
    accessor?.(stage);
    if (typeof column.cell !== "function") return [];
    const cell = column.cell as (context: never) => ReactNode;
    const element = cell({ row: { original: stage } } as never);
    return column.id === "stageId" ? [] : [<Fragment key={column.id}>{element}</Fragment>];
  });
  return { columns, cells };
}

function renderCells(cells: ReactNode[]) {
  return render(<Entity id="stage-4">{cells}</Entity>);
}

describe("Spark stage table columns", () => {
  it("builds optional columns and renders sparse metric fallbacks", () => {
    const options: StageColumnOptions = {
      appId: "application_1",
      now: 1_800_000_000_000,
      tz: "utc",
      showAttempt: true,
      showAdvanced: true,
      showFailureReason: true,
    };
    const { columns, cells } = evaluateCells(baseStage, options);
    expect(columns.map((column) => column.id)).toContain("attemptId");
    expect(columns.map((column) => column.id)).toContain("spill");
    expect(columns.map((column) => column.id)).toContain("failureReason");
    expect(
      (columns.find((column) => column.id === "name")?.meta?.exportValue as unknown as ((row: SparkStage) => unknown) | undefined)?.(
        baseStage,
      ),
    ).toBe("Parse records");
    expect(
      (columns.find((column) => column.id === "stageId")?.meta?.exportValue as unknown as ((row: SparkStage) => unknown) | undefined)?.(
        baseStage,
      ),
    ).toBe(4);
    expect(firstLine("\n  \n  java.lang.IllegalStateException: bad row\nstack trace")).toBe("  java.lang.IllegalStateException: bad row");
    expect(firstLine("\n   ")).toBe("\n   ");
    expect(renderCells(cells).container.textContent).toContain("—");
  });

  it("renders complete metrics, distinct descriptions, and truncated failure reasons", () => {
    const detailedStage = {
      ...baseStage,
      attemptId: 2,
      name: "Fallback display name",
      description: "Visible stage description",
      submissionTime: "2026-10-01T12:30:00.000Z",
      completionTime: "2026-10-01T12:31:00.000Z",
      numTasks: 5,
      numCompletedIndices: 3,
      numCompleteTasks: 4,
      numActiveTasks: 1,
      numFailedTasks: 2,
      numKilledTasks: 1,
      inputBytes: 4096,
      inputRecords: 20,
      outputBytes: 8192,
      outputRecords: 30,
      shuffleReadBytes: 1024,
      shuffleReadRecords: 10,
      shuffleWriteBytes: 2048,
      shuffleWriteRecords: 15,
      memoryBytesSpilled: 512,
      diskBytesSpilled: 256,
      jvmGcTime: 300,
      failureReason: `\n${"x".repeat(180)}\nstack frame`,
    } as SparkStage;
    const options: StageColumnOptions = {
      appId: "application_1",
      now: Date.parse("2026-10-01T12:31:00.000Z"),
      tz: "utc",
      attempt: "1",
      showAttempt: true,
      showAdvanced: true,
      showFailureReason: true,
    };
    const { columns, cells } = evaluateCells(detailedStage, options);
    const view = renderCells(cells);

    expect(
      (columns.find((column) => column.id === "name")?.meta?.exportValue as unknown as ((row: SparkStage) => unknown) | undefined)?.(
        detailedStage,
      ),
    ).toBe("Visible stage description");
    expect(
      (columns.find((column) => column.id === "attemptId")?.meta?.exportValue as unknown as ((row: SparkStage) => unknown) | undefined)?.(
        detailedStage,
      ),
    ).toBe(2);
    expect(view.container.textContent).toContain("Visible stage description");
    expect(view.container.textContent).toContain("Fallback display name");
    expect(view.container.textContent).toContain("x".repeat(157));
    expect(firstLine("x".repeat(161))).toBe(`${"x".repeat(157)}…`);
  });

  it("omits attempt, advanced and failure columns when the list does not request them", () => {
    const { columns } = evaluateCells(baseStage, { appId: "application_1", now: 0, tz: "utc" });
    const ids = columns.map((column) => column.id);
    expect(ids).not.toContain("attemptId");
    expect(ids).not.toContain("spill");
    expect(ids).not.toContain("jvmGcTime");
    expect(ids).not.toContain("failureReason");
  });
});
