/**
 * The stage table, shared by the Stages list (all stages, with attempt selector) and the job detail page (that job's stages).
 *
 * Columns are Spark's own stage columns + the aggregates the brief asks for; `showAttempt` / `showFailureReason` /
 * `showTaskAggregates` let the two callers differ without a second implementation. Sorting is by REST field through the
 * column ids, so `?sort=shuffleReadBytes&dir=desc` is a valid deep link.
 */
import { Link } from "@tanstack/react-router";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { fmtEpoch } from "~/lib/format";
import type { TzMode } from "~/lib/format";
import { stageDurationMs, parseSparkTime } from "../data/format";
import type { SparkStage } from "../data/schemas";
import { ByteRecCell, CountsCell, TaskProgress } from "./Counts";

export interface StageColumnOptions {
  appId: string;
  now: number;
  tz: TzMode;
  attempt?: string | null;
  /** Show the Attempt column (retried stages) — the Stages list does, the job page does not. */
  showAttempt?: boolean;
  /** Show the failure-reason column (only meaningful when some stage failed). */
  showFailureReason?: boolean;
  /** Show GC / spill columns (Spark hides them behind "Show Additional Metrics"). */
  showAdvanced?: boolean;
}

export function stageColumns({
  appId,
  now,
  tz,
  attempt,
  showAttempt,
  showFailureReason,
  showAdvanced,
}: StageColumnOptions): ColDef<SparkStage>[] {
  const cols: ColDef<SparkStage>[] = [
    {
      id: "stageId",
      accessorKey: "stageId",
      size: 76,
      meta: {
        label: "Stage Id",
        hint: "Stage identifier. Open it to inspect every retained task and stage attempt.",
        pinned: true,
        align: "start",
        exportValue: (r: SparkStage) => r.stageId,
      },
      header: "Stage Id",
      cell: (info) => {
        const s = info.row.original;
        return (
          <Link
            to="/apps/$appId/spark/stages/$stageId/$attemptId"
            params={{ appId, stageId: String(s.stageId), attemptId: String(s.attemptId ?? 0) }}
            search={{ attempt: attempt ?? undefined }}
            className="burrow-touch-link font-medium text-live underline-offset-2 hover:underline"
          >
            <Datum field="spark.stage.stageId" raw={s.stageId} fmt="id">
              {String(s.stageId)}
            </Datum>
          </Link>
        );
      },
    },
  ];
  if (showAttempt) {
    cols.push({
      id: "attemptId",
      accessorKey: "attemptId",
      size: 76,
      meta: { label: "Attempt", hint: "Stage retry number, beginning at zero.", align: "end", exportValue: (r: SparkStage) => r.attemptId },
      header: "Attempt",
      cell: (info) => <Datum field="spark.stage.attemptId" raw={info.row.original.attemptId} fmt="id" />,
    });
  }
  cols.push(
    {
      id: "status",
      accessorKey: "status",
      meta: { label: "Status", exportValue: (r: SparkStage) => r.status },
      header: "Status",
      cell: (info) => <StatusPill domain="spark.stage" state={info.row.original.status} field="spark.stage.status" size="sm" />,
    },
    {
      id: "name",
      accessorKey: "name",
      meta: { label: "Name / description", exportValue: (r: SparkStage) => r.description ?? r.name },
      header: "Name",
      cell: (info) => {
        const s = info.row.original;
        return (
          <span className="flex min-w-0 flex-col">
            <Datum field="spark.stage.description" raw={s.description} className="truncate" title={s.description ?? undefined} />
            {s.name && s.name !== s.description && (
              <Datum field="spark.stage.name" raw={s.name} className="truncate text-micro text-ink-4" title={s.name} />
            )}
          </span>
        );
      },
    },
    {
      id: "submitted",
      accessorKey: "submissionTime",
      meta: { label: "Submitted", exportValue: (r: SparkStage) => r.submissionTime },
      header: "Submitted",
      cell: (info) => (
        <Datum
          field="spark.stage.submissionTime"
          raw={info.row.original.submissionTime}
          fmt="text"
          className="whitespace-nowrap text-ink-3"
        >
          {fmtEpoch(parseSparkTime(info.row.original.submissionTime), tz)}
        </Datum>
      ),
    },
    {
      id: "duration",
      sortFn: "basic",
      accessorFn: (s) => stageDurationMs(s, now) ?? -1,
      meta: {
        label: "Duration",
        hint: "Time from stage submission to completion, or elapsed time while the stage runs.",
        align: "end",
        exportValue: (r: SparkStage) => stageDurationMs(r, now),
      },
      header: "Duration",
      cell: (info) => (
        <Datum
          field="spark.stage.derived.durationMs"
          raw={stageDurationMs(info.row.original, now)}
          fmt="dur"
          className="whitespace-nowrap"
        />
      ),
    },
    {
      id: "tasks",
      enableSorting: false,
      meta: {
        label: "Tasks (done / active / failed)",
        hint: "Task attempt counts. Retries and speculative attempts may exceed the number of partitions.",
      },
      header: "Tasks",
      cell: (info) => {
        const s = info.row.original;
        return (
          <CountsCell
            counts={[
              { field: "spark.stage.numCompleteTasks", raw: s.numCompleteTasks, tone: "ok", label: "complete" },
              { field: "spark.stage.numActiveTasks", raw: s.numActiveTasks, tone: "live", label: "active" },
              { field: "spark.stage.numFailedTasks", raw: s.numFailedTasks, tone: "fail", label: "failed" },
              { field: "spark.stage.numKilledTasks", raw: s.numKilledTasks, tone: "idle", label: "killed" },
            ]}
          />
        );
      },
    },
    {
      id: "progress",
      enableSorting: false,
      meta: {
        label: "Progress",
        hint: "Completed partitions / total partitions. Failed and killed attempts are retried and do not advance progress.",
      },
      header: "Progress",
      cell: (info) => {
        const s = info.row.original;
        return (
          <TaskProgress
            complete={s.numCompletedIndices ?? s.numCompleteTasks ?? 0}
            active={s.numActiveTasks ?? 0}
            failed={s.numFailedTasks ?? 0}
            killed={s.numKilledTasks ?? 0}
            total={s.numTasks ?? 0}
            field={s.numCompletedIndices != null ? "spark.stage.numCompletedIndices" : "spark.stage.numCompleteTasks"}
            label={`Stage ${s.stageId} tasks`}
          />
        );
      },
    },
    {
      id: "inputBytes",
      accessorKey: "inputBytes",
      meta: {
        label: "Input Size / Records",
        hint: "Bytes and records read from external input across this stage.",
        align: "end",
        exportValue: (r: SparkStage) => r.inputBytes,
      },
      header: "Input",
      cell: (info) => (
        <ByteRecCell
          bytes={info.row.original.inputBytes}
          records={info.row.original.inputRecords}
          bytesField="spark.stage.inputBytes"
          recordsField="spark.stage.inputRecords"
        />
      ),
    },
    {
      id: "outputBytes",
      accessorKey: "outputBytes",
      meta: {
        label: "Output Size / Records",
        hint: "Bytes and records written to external output across this stage.",
        align: "end",
        exportValue: (r: SparkStage) => r.outputBytes,
      },
      header: "Output",
      cell: (info) => (
        <ByteRecCell
          bytes={info.row.original.outputBytes}
          records={info.row.original.outputRecords}
          bytesField="spark.stage.outputBytes"
          recordsField="spark.stage.outputRecords"
        />
      ),
    },
    {
      id: "shuffleReadBytes",
      accessorKey: "shuffleReadBytes",
      meta: {
        label: "Shuffle Read Size / Records",
        hint: "Bytes and records fetched from preceding stages.",
        align: "end",
        exportValue: (r: SparkStage) => r.shuffleReadBytes,
      },
      header: "Shuffle Read",
      cell: (info) => (
        <ByteRecCell
          bytes={info.row.original.shuffleReadBytes}
          records={info.row.original.shuffleReadRecords}
          bytesField="spark.stage.shuffleReadBytes"
          recordsField="spark.stage.shuffleReadRecords"
        />
      ),
    },
    {
      id: "shuffleWriteBytes",
      accessorKey: "shuffleWriteBytes",
      meta: {
        label: "Shuffle Write Size / Records",
        hint: "Bytes and records produced for subsequent stages.",
        align: "end",
        exportValue: (r: SparkStage) => r.shuffleWriteBytes,
      },
      header: "Shuffle Write",
      cell: (info) => (
        <ByteRecCell
          bytes={info.row.original.shuffleWriteBytes}
          records={info.row.original.shuffleWriteRecords}
          bytesField="spark.stage.shuffleWriteBytes"
          recordsField="spark.stage.shuffleWriteRecords"
        />
      ),
    },
  );

  if (showAdvanced) {
    cols.push(
      {
        id: "spill",
        enableSorting: false,
        meta: {
          label: "Spill (memory / disk)",
          hint: "In-memory size of spilled data, followed by its serialized size written to disk. Both values are bytes.",
        },
        header: "Spill",
        cell: (info) => (
          <ByteRecCell
            bytes={info.row.original.memoryBytesSpilled}
            records={info.row.original.diskBytesSpilled}
            bytesField="spark.stage.memoryBytesSpilled"
            recordsField="spark.stage.diskBytesSpilled"
            recordsUnit="bytes"
          />
        ),
      },
      {
        id: "jvmGcTime",
        accessorKey: "jvmGcTime",
        meta: {
          label: "GC Time",
          hint: "Total time spent collecting JVM garbage across task attempts.",
          align: "end",
          exportValue: (r: SparkStage) => r.jvmGcTime,
        },
        header: "GC",
        cell: (info) => <Datum field="spark.stage.jvmGcTime" raw={info.row.original.jvmGcTime} fmt="dur" className="whitespace-nowrap" />,
      },
    );
  }

  if (showFailureReason) {
    cols.push({
      id: "failureReason",
      enableSorting: false,
      meta: { label: "Failure Reason" },
      header: "Failure reason",
      cell: (info) => {
        const s = info.row.original;
        if (!s.failureReason) return <span className="text-ink-4">—</span>;
        return (
          <Datum
            field="spark.stage.failureReason"
            raw={s.failureReason}
            fmt="text"
            className="block max-w-[42ch] truncate text-fail"
            title={s.failureReason}
          >
            {firstLine(s.failureReason)}
          </Datum>
        );
      },
    });
  }

  return cols;
}

/** Failure reasons are multi-line Java/Python stack traces: show the first meaningful line, keep the rest in `title`. */
export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
