/**
 * The count/progress cells shared by the Jobs, Stages and Executors tables. Each number carries its own `data-yf`
 * (so the parity harness compares the raw REST count, not the composite cell text) and the tone comes from the status
 * language — never colour alone: the `title` spells the counts out.
 */
import { Datum } from "~/ui/datum";
import { ProgressBar, type Segment } from "~/ui/progress-bar";
import { HelpTip, Tooltip } from "~/ui/tooltip";
import { stageTaskShares } from "../data/format";
import { cn } from "~/lib/cn";
import { fmtBytes, fmtInt } from "~/lib/format";

export interface CountSpec {
  /** REST key relative to the entity (e.g. `numCompletedStages`). */
  field: string;
  raw: number | null | undefined;
  tone: "ok" | "live" | "fail" | "idle" | "wait";
  label: string;
}

/** "1.2 MiB / 3,456" with each half stamped separately (`bytesField`, `recordsField`). */
export function ByteRecCell({
  bytes,
  records,
  bytesField,
  recordsField,
  recordsUnit = "count",
  className,
}: {
  bytes: number | null | undefined;
  records: number | null | undefined;
  bytesField: string;
  recordsField: string;
  recordsUnit?: "count" | "bytes";
  className?: string;
}) {
  if (bytes == null && records == null) return <span className="text-ink-4">—</span>;
  const fullValue = `${fmtBytes(bytes)} / ${recordsUnit === "bytes" ? fmtBytes(records) : fmtInt(records)}`;
  return (
    <Tooltip label={fullValue}>
      <span className={cn("flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap tnum", className)}>
        <Datum field={bytesField} raw={bytes} fmt="bytes" className="min-w-0 truncate" />
        <span className="shrink-0 text-ink-4">/</span>
        <Datum field={recordsField} raw={records} fmt={recordsUnit === "bytes" ? "bytes" : "int"} className="min-w-0 truncate text-ink-3" />
      </span>
    </Tooltip>
  );
}

/** "3 / 1 / 0 / 2" with per-number tone + tooltip. */
export function CountsCell({ counts, className }: { counts: CountSpec[]; className?: string }) {
  const title = counts.map((c) => `${c.label}: ${c.raw ?? "—"}`).join(" · ");
  return (
    <span className={cn("flex items-center gap-1.5 tnum", className)}>
      {counts.map((c) => (
        <Datum
          key={c.field}
          field={c.field}
          raw={c.raw}
          fmt="int"
          className={cn(`burrow-tone-${c.tone}`, "text-(--tone)", c.raw ? "font-medium" : "text-ink-4")}
        >
          {c.raw ?? "—"}
        </Datum>
      ))}
      <HelpTip label="Task and stage counts">{title}</HelpTip>
    </span>
  );
}

/** Segmented progress: done / active / failed / killed / pending shares of a task set (Spark's stage-progress semantics). */
export function TaskProgress({
  complete,
  active,
  failed,
  killed = 0,
  total,
  field,
  label,
}: {
  complete: number;
  active: number;
  failed: number;
  killed?: number;
  total: number;
  /** REST field carrying the completed count (the "value" of the bar). */
  field: string;
  label: string;
}) {
  const shares = stageTaskShares({ numTasks: total, numCompleteTasks: complete, numActiveTasks: active });
  const segments: Segment[] = [
    { percent: shares.complete, tone: "ok", label: "complete" },
    { percent: shares.active, tone: "live", label: "active" },
    { percent: shares.pending, tone: "wait", label: "pending" },
  ].filter((s) => s.percent > 0) as Segment[];
  const done = Math.round(shares.complete);
  const empty: Segment[] = [{ percent: 0, tone: "wait", label: "pending" }];
  return (
    <div className="flex min-w-[128px] items-center gap-2">
      <ProgressBar
        percent={done}
        segments={segments.length ? segments : empty}
        // an ACTIVE stage reads as in-flight on the thread, not just as a live-toned segment
        live={active > 0}
        label={`${label}: ${complete}/${total} partitions complete, ${active} active task attempts, ${failed} failed attempts, ${killed} killed attempts`}
        datum={{ "data-yf": field, "data-yv": String(complete), "data-yfmt": "int" }}
        className="min-w-[64px] flex-1"
      />
      <span className="shrink-0 text-micro text-ink-3 tnum">
        {complete}/{total}
      </span>
    </div>
  );
}
