import type { ReactNode } from "react";
import { HelpTip } from "~/ui/tooltip";

const PAGE_DESCRIPTIONS: Record<string, string> = {
  Timeline: "Compare job, stage, and executor activity over time.",
  Jobs: "Review Spark jobs, their status, and the stages they coordinate.",
  Stages: "Inspect stage progress, task outcomes, and shuffle activity.",
  Executors: "Compare executor health, task throughput, and resource use.",
  Storage: "Browse cached RDDs and their partition and memory usage.",
  Environment: "Review Spark properties, runtime details, and classpaths.",
  SQL: "Explore SQL executions and the plans Spark generated for them.",
  Streaming: "Track streaming batches, processing rates, and latency.",
};

/** A Spark view heading with optional context and controls. */
export function PageHeader({
  title,
  description,
  children,
  hideTitle = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  hideTitle?: boolean;
}) {
  const pageDescription = description ?? (typeof title === "string" ? PAGE_DESCRIPTIONS[title] : undefined);
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-1">
      <div className="min-w-0">
        <h2 className={hideTitle ? "sr-only" : "text-h2 font-semibold text-ink"}>{title}</h2>
        {pageDescription && <p className="mt-1 max-w-3xl text-pretty text-body break-words text-ink-3">{pageDescription}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** A labelled scalar in a dense metrics strip (Spark's "kv" rows). */
export function MetricStrip({ children }: { children: ReactNode }) {
  return (
    <dl className="grid min-w-0 gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 10rem), 1fr))" }}>
      {children}
    </dl>
  );
}

export function Metric({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-seam-soft bg-fabric px-3 py-2.5">
      <dt className="flex min-w-0 items-center gap-1 text-caption font-medium leading-snug text-ink-3">
        {label}
        {hint && <HelpTip label={label}>{hint}</HelpTip>}
      </dt>
      <dd className="min-w-0 break-words text-body font-medium leading-snug text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
