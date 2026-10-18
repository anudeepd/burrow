/**
 * Spark's task table for one stage attempt — the columns of `/stages/stage/?id=..&attempt=..` (Index, Attempt, Status, Id,
 * Executor Id, Host, Launch Time, Duration, GC Time, Input, Shuffle Read/Write, Spill, Error) plus the "additional
 * metrics" Spark hides behind *Show Additional Metrics* (getting-result time, scheduler delay, locality, speculative,
 * result size, peak execution memory), gated by the caller's `showMore`.
 *
 * `Shuffle Read` is the sum of local + remote bytes; both halves keep their own `data-yf` so the parity harness compares
 * the REST values, and the sum carries a `derived.` id. Launch time is a timestamp string in Spark's REST payload (epoch
 * ms in some builds), so it is parsed defensively and the raw value is what `data-yv` carries.
 */
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { type ReactNode, useMemo } from "react";
import { fmtBytes, fmtEpoch } from "~/lib/format";
import type { TzMode } from "~/lib/format";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { parseSparkTime, taskRowKey, totalShuffleReadBytes } from "../data/format";
import type { SparkTask } from "../data/schemas";
import { ByteRecCell } from "./Counts";
import { OptionalTooltip } from "~/ui/tooltip";

/** Launch time as epoch ms: Spark REST delivers an ISO string (`2026-…GMT`), some builds an epoch number. */
function launchMs(t: SparkTask): number | null {
  const v: unknown = t.launchTime;
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseSparkTime(v);
  return null;
}

export interface TaskColumnOptions {
  tz: TzMode;
  /** Render the additional-metrics columns (`?level=more`). */
  showMore?: boolean;
}

export function taskColumns({ tz, showMore }: TaskColumnOptions): ColDef<SparkTask>[] {
  const cols: ColDef<SparkTask>[] = [
    {
      id: "index",
      accessorKey: "index",
      size: 72,
      meta: {
        label: "Index",
        hint: "Partition index within this stage. Multiple attempts may share an index.",
        align: "end",
        exportValue: (t: SparkTask) => t.index,
      },
      header: "Index",
      cell: (info) => <Datum field="spark.task.index" raw={info.row.original.index} fmt="id" className="tnum" />,
    },
    {
      id: "attempt",
      accessorKey: "attempt",
      size: 76,
      meta: {
        label: "Attempt",
        hint: "Retry number for this partition, beginning at zero.",
        align: "end",
        exportValue: (t: SparkTask) => t.attempt,
      },
      header: "Attempt",
      cell: (info) => <Datum field="spark.task.attempt" raw={info.row.original.attempt} fmt="id" className="tnum" />,
    },
    {
      id: "status",
      accessorKey: "status",
      meta: { label: "Status", exportValue: (t: SparkTask) => t.status },
      header: "Status",
      cell: (info) => <StatusPill domain="spark.task" state={info.row.original.status} field="spark.task.status" size="sm" />,
    },
    {
      id: "taskId",
      accessorKey: "taskId",
      meta: { label: "Id", hint: "Unique identifier for this task attempt.", align: "end", exportValue: (t: SparkTask) => t.taskId },
      header: "Id",
      cell: (info) => <Datum field="spark.task.taskId" raw={info.row.original.taskId} fmt="id" className="tnum" />,
    },
    {
      id: "executorId",
      accessorKey: "executorId",
      meta: { label: "Executor Id", hint: "Spark executor that ran this task attempt.", exportValue: (t: SparkTask) => t.executorId },
      header: "Executor Id",
      cell: (info) => <Datum field="spark.task.executorId" raw={info.row.original.executorId} className="font-mono text-micro" />,
    },
    {
      id: "host",
      accessorKey: "host",
      meta: { label: "Host", exportValue: (t: SparkTask) => t.host },
      header: "Host",
      cell: (info) => <Datum field="spark.task.host" raw={info.row.original.host} className="font-mono text-micro" />,
    },
    {
      id: "launchTime",
      accessorFn: (t) => launchMs(t) ?? -1,
      sortFn: "basic",
      meta: { label: "Launch Time", exportValue: (t: SparkTask) => launchMs(t) },
      header: "Launch Time",
      cell: (info) => (
        <Datum field="spark.task.launchTime" raw={info.row.original.launchTime} fmt="text" className="whitespace-nowrap text-ink-3">
          {fmtEpoch(launchMs(info.row.original), tz)}
        </Datum>
      ),
    },
    {
      id: "duration",
      accessorKey: "duration",
      meta: {
        label: "Duration",
        hint: "Elapsed wall-clock time for this task attempt.",
        align: "end",
        exportValue: (t: SparkTask) => t.duration,
      },
      header: "Duration",
      cell: (info) => <Datum field="spark.task.duration" raw={info.row.original.duration} fmt="dur" className="tnum whitespace-nowrap" />,
    },
    {
      id: "gcTime",
      accessorFn: (t) => t.taskMetrics?.jvmGcTime,
      meta: {
        label: "GC Time",
        hint: "Time spent collecting JVM garbage during this task attempt.",
        align: "end",
        exportValue: (t: SparkTask) => t.taskMetrics?.jvmGcTime,
      },
      header: "GC Time",
      cell: (info) => (
        <Datum
          field="spark.task.taskMetrics.jvmGcTime"
          raw={info.row.original.taskMetrics?.jvmGcTime ?? null}
          fmt="dur"
          className="tnum whitespace-nowrap"
        />
      ),
    },
    {
      id: "input",
      enableSorting: false,
      meta: { label: "Input Size / Records", hint: "Bytes and records read by this task from external input.", align: "end" },
      header: "Input",
      cell: (info) => (
        <ByteRecCell
          bytes={info.row.original.taskMetrics?.inputMetrics?.bytesRead}
          records={info.row.original.taskMetrics?.inputMetrics?.recordsRead}
          bytesField="spark.task.taskMetrics.inputMetrics.bytesRead"
          recordsField="spark.task.taskMetrics.inputMetrics.recordsRead"
        />
      ),
    },
    {
      id: "shuffleRead",
      accessorFn: (t) => totalShuffleReadBytes(t) ?? -1,
      sortFn: "basic",
      meta: {
        label: "Shuffle Read (local + remote)",
        hint: "Total bytes fetched from preceding stages, broken down into local and remote reads, followed by records.",
        align: "end",
        exportValue: (t: SparkTask) => totalShuffleReadBytes(t),
      },
      header: "Shuffle Read",
      cell: (info) => {
        const sr = info.row.original.taskMetrics?.shuffleReadMetrics;
        const local = sr?.localBytesRead ?? null;
        const remote = sr?.remoteBytesRead ?? null;
        const total = totalShuffleReadBytes(info.row.original);
        return (
          <OptionalTooltip label={`local ${fmtBytes(local)} + remote ${fmtBytes(remote)}`}>
            <span className="flex items-center gap-1 tnum">
              <Datum field="spark.task.derived.shuffleReadBytes" raw={total} fmt="bytes" />
              <span className="text-micro text-ink-4">
                (
                <Datum field="spark.task.taskMetrics.shuffleReadMetrics.localBytesRead" raw={local} fmt="bytes" />
                +
                <Datum field="spark.task.taskMetrics.shuffleReadMetrics.remoteBytesRead" raw={remote} fmt="bytes" />)
              </span>
              <span className="text-ink-4">/</span>
              <Datum
                field="spark.task.taskMetrics.shuffleReadMetrics.recordsRead"
                raw={sr?.recordsRead ?? null}
                fmt="int"
                className="text-ink-3"
              />
            </span>
          </OptionalTooltip>
        );
      },
    },
    {
      id: "shuffleWrite",
      enableSorting: false,
      meta: { label: "Shuffle Write Size / Records", hint: "Bytes and records produced by this task for subsequent stages.", align: "end" },
      header: "Shuffle Write",
      cell: (info) => (
        <ByteRecCell
          bytes={info.row.original.taskMetrics?.shuffleWriteMetrics?.bytesWritten}
          records={info.row.original.taskMetrics?.shuffleWriteMetrics?.recordsWritten}
          bytesField="spark.task.taskMetrics.shuffleWriteMetrics.bytesWritten"
          recordsField="spark.task.taskMetrics.shuffleWriteMetrics.recordsWritten"
        />
      ),
    },
    {
      id: "spill",
      enableSorting: false,
      meta: {
        label: "Spill (memory / disk)",
        hint: "In-memory size of spilled data, followed by its serialized disk size. Both values are bytes.",
        align: "end",
      },
      header: "Spill",
      cell: (info) => (
        <ByteRecCell
          bytes={info.row.original.taskMetrics?.memoryBytesSpilled}
          records={info.row.original.taskMetrics?.diskBytesSpilled}
          bytesField="spark.task.taskMetrics.memoryBytesSpilled"
          recordsField="spark.task.taskMetrics.diskBytesSpilled"
          recordsUnit="bytes"
        />
      ),
    },
    {
      id: "error",
      accessorKey: "errorMessage",
      meta: { label: "Error", exportValue: (t: SparkTask) => t.errorMessage },
      header: "Error",
      cell: (info) => {
        const message = info.row.original.errorMessage;
        if (!message) return <span className="text-ink-4">—</span>;
        return (
          <Datum field="spark.task.errorMessage" raw={message} fmt="text" className="block max-w-[46ch] truncate text-fail" title={message}>
            {message.split("\n")[0] ?? message}
          </Datum>
        );
      },
    },
  ];

  if (showMore) {
    cols.push(
      {
        id: "gettingResultTime",
        accessorFn: (t) => t.gettingResultTime,
        meta: {
          label: "Getting Result Time",
          hint: "Time spent transferring this task result to the driver.",
          align: "end",
          exportValue: (t: SparkTask) => t.gettingResultTime,
        },
        header: "Getting Result Time",
        cell: (info) => (
          <Datum
            field="spark.task.gettingResultTime"
            raw={info.row.original.gettingResultTime}
            fmt="dur"
            className="tnum whitespace-nowrap"
          />
        ),
      },
      {
        id: "schedulerDelay",
        accessorFn: (t) => t.schedulerDelay,
        meta: {
          label: "Scheduler Delay",
          hint: "Time before execution and result handling, excluding reported task execution work.",
          align: "end",
          exportValue: (t: SparkTask) => t.schedulerDelay,
        },
        header: "Scheduler Delay",
        cell: (info) => (
          <Datum field="spark.task.schedulerDelay" raw={info.row.original.schedulerDelay} fmt="dur" className="tnum whitespace-nowrap" />
        ),
      },
      {
        id: "taskLocality",
        accessorKey: "taskLocality",
        meta: { label: "Task Locality", exportValue: (t: SparkTask) => t.taskLocality },
        header: "Task Locality",
        cell: (info) => <Datum field="spark.task.taskLocality" raw={info.row.original.taskLocality} className="text-micro" />,
      },
      {
        id: "speculative",
        accessorFn: (t) => t.speculative,
        sortFn: "basic",
        meta: {
          label: "Speculative",
          hint: "Whether this attempt duplicated a slow-running task to reduce overall completion time.",
          exportValue: (t: SparkTask) => t.speculative,
        },
        header: "Speculative",
        cell: (info) => {
          const v = info.row.original.speculative;
          return (
            <Datum field="spark.task.speculative" raw={v} fmt="text">
              {v == null ? "—" : v ? "yes" : "no"}
            </Datum>
          );
        },
      },
      {
        id: "resultSize",
        accessorFn: (t) => t.taskMetrics?.resultSize,
        meta: {
          label: "Result Size",
          hint: "Size of the serialized task result sent to the driver.",
          align: "end",
          exportValue: (t: SparkTask) => t.taskMetrics?.resultSize,
        },
        header: "Result Size",
        cell: (info) => (
          <Datum
            field="spark.task.taskMetrics.resultSize"
            raw={info.row.original.taskMetrics?.resultSize ?? null}
            fmt="bytes"
            className="tnum"
          />
        ),
      },
      {
        id: "peakExecutionMemory",
        accessorFn: (t) => t.taskMetrics?.peakExecutionMemory,
        meta: {
          label: "Peak Execution Memory",
          hint: "Peak memory used by internal task data structures, such as shuffle and aggregation buffers.",
          align: "end",
          exportValue: (t: SparkTask) => t.taskMetrics?.peakExecutionMemory,
        },
        header: "Peak Execution Memory",
        cell: (info) => (
          <Datum
            field="spark.task.taskMetrics.peakExecutionMemory"
            raw={info.row.original.taskMetrics?.peakExecutionMemory ?? null}
            fmt="bytes"
            className="tnum"
          />
        ),
      },
    );
  }

  return cols;
}

export interface TaskTableProps {
  tasks: readonly SparkTask[];
  label: string;
  tz: TzMode;
  showMore: boolean;
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  columnVisibility: ColumnVisibilityState;
  onColumnVisibilityChange: (v: ColumnVisibilityState) => void;
  defaultVisibility: ColumnVisibilityState;
  rowVersion?: (t: SparkTask) => string;
  totalCount?: number;
  loading?: boolean;
  error?: ReactNode;
  empty?: ReactNode;
  toolbar?: ReactNode;
  exportName: string;
}

/** The shared task table: every column carries a `spark.task.*` field id inside the row's `<Entity>` (`taskId-attempt`). */
export function TaskTable({
  tasks,
  label,
  tz,
  showMore,
  sorting,
  onSortingChange,
  columnVisibility,
  onColumnVisibilityChange,
  defaultVisibility,
  rowVersion,
  totalCount,
  loading,
  error,
  empty,
  toolbar,
  exportName,
}: TaskTableProps) {
  const columns = useMemo(() => taskColumns({ tz, showMore }), [tz, showMore]);
  return (
    <DataTable<SparkTask>
      className="min-h-[24rem]"
      data={tasks}
      columns={columns}
      getRowId={taskRowKey}
      entityKey={taskRowKey}
      label={label}
      storageKey="spark-stage-tasks"
      sorting={sorting}
      onSortingChange={onSortingChange}
      columnVisibility={columnVisibility}
      onColumnVisibilityChange={onColumnVisibilityChange}
      defaultVisibility={defaultVisibility}
      {...(rowVersion ? { rowVersion } : {})}
      {...(totalCount != null ? { totalCount } : {})}
      {...(loading != null ? { loading } : {})}
      {...(error != null ? { error } : {})}
      {...(empty != null ? { empty } : {})}
      {...(toolbar != null ? { toolbar } : {})}
      exportName={exportName}
    />
  );
}
