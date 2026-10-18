/**
 * Page chrome for the Scheduler slice (the shell owns the rail/topbar and the main padding, so these are inner blocks).
 * `KV` renders a legacy-style label→value block where every value is a `Datum`.
 */
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";
import { Datum, type DatumAttrs } from "~/ui/datum";
import { Tooltip } from "~/ui/tooltip";

export function PageHeader({
  title,
  subtitle,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-2", className)}>
      <div className="min-w-0">
        <h1 className="text-h1 font-semibold text-ink text-balance">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-body break-words text-ink-3">{subtitle}</p>}
        {meta && <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-3">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({
  title,
  hint,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-h3">{title}</h2>
        {actions}
      </div>
      {hint && <p className="max-w-4xl text-small text-ink-3">{hint}</p>}
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-w-0 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]", className)}>{children}</div>;
}

export function Tile({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-seam bg-fabric p-2.5", className)} {...rest}>
      {children}
    </div>
  );
}

export function TileLabel({ children }: { children: ReactNode }) {
  return <div className="text-caption tracking-wide text-ink-3 uppercase">{children}</div>;
}

/**
 * Legacy-style key/value block. Values are `<Datum>`s; `raw` may be null (renders "—" with data-yn).
 *
 * The column count is responsive. Every caller with `columns={2}` is a queue-status block whose labels are long
 * ("Configured Max Application Master Limit") while the values are short: two columns at 640–1280px left the values
 * truncated ("1.5 GiB · 1 vCores" cut to "1.5…"), so the second column only appears once the row is wide. Labels may
 * wrap and values may wrap onto a second line — do not re-add `truncate`/`shrink-0` here: a truncated capacity or
 * container count is worse than a taller row.
 */
export function KV({ children, className, columns = 2 }: { children: ReactNode; className?: string; columns?: 1 | 2 | 3 }) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-0 text-body",
        columns === 1 ? "grid-cols-1" : columns === 2 ? "grid-cols-1 xl:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/**
 * A label→value row. The value is a `Datum` carrying `field`/`raw`; `children` are the *plain* visible content
 * (never a `Datum` — that would nest two datums for one value). For a value made of several datums use `KVRowGroup`.
 */
export function KVRow({
  label,
  field,
  raw,
  fmt,
  children,
  className,
}: {
  label: ReactNode;
  field: string;
  raw: unknown;
  fmt?: DatumAttrs["data-yfmt"];
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 border-b border-seam-soft py-1 last:border-b-0", className)}>
      <dt className="min-w-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 text-right">
        <Datum field={field} raw={raw} fmt={fmt}>
          {children}
        </Datum>
      </dd>
    </div>
  );
}

/** Like `KVRow` but the children carry their own datums (composite values: memory + vCores, status pills, …). */
export function KVRowGroup({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 border-b border-seam-soft py-1 last:border-b-0", className)}>
      <dt className="min-w-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/** A value with no upstream source: says so instead of showing a plausible-looking zero. */
export function Unavailable({ reason, hint, className }: { reason: string; hint?: string; className?: string }) {
  const body = (
    <span className={cn("inline-flex flex-col", className)}>
      <span className="text-ink-4">—</span>
      <span className="text-micro text-ink-4">{reason}</span>
    </span>
  );
  /* the explanation is a real tooltip, not a native `title`: it has to be readable. The visible text stands on its
     own, so the trigger stays non-interactive (no extra tab stop). */
  return hint ? (
    <Tooltip label={hint}>
      <span className="inline-flex">{body}</span>
    </Tooltip>
  ) : (
    body
  );
}

export function StateNote({ title, children, tone = "idle" }: { title: string; children?: ReactNode; tone?: "idle" | "warn" | "fail" }) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border border-dashed px-3 py-2.5 text-body",
        tone === "fail" ? "border-fail/40 text-ink-2" : tone === "warn" ? "border-warn/40 text-ink-2" : "border-seam-strong text-ink-3",
      )}
    >
      <div className="font-medium text-ink-2">{title}</div>
      {children && <div className="mt-0.5 text-small">{children}</div>}
    </div>
  );
}
