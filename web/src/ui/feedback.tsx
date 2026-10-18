import { Inbox, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";
import { useInView } from "~/lib/in-view";
import { Button } from "./button";

/** One row of skeleton. The shimmer loops only while the box is on screen (`data-visible` drives the CSS gate). */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const [ref, visible] = useInView<HTMLDivElement>();
  return <div ref={ref} aria-hidden="true" data-visible={visible} className={cn("burrow-skeleton h-3", className)} style={style} />;
}

/** Gives a route-level error or empty state the full content area for vertical centering. */
export function CenteredPageState({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid min-h-0 flex-1 place-items-center py-8", className)}>{children}</div>;
}

/** Structural skeleton for a table: same row height/column rhythm as the real thing so nothing jumps on load. */
export function TableSkeleton({ rows = 10, cols = 7 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="flex flex-col">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-seam-soft px-3" style={{ height: "var(--row-h)" }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="h-2.5" style={{ width: `${c === 0 ? 14 : 6 + ((r * 7 + c * 13) % 9)}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Empty = an invitation: say what is missing and offer exactly one next action. */
export function EmptyState({
  title,
  children,
  action,
  icon,
  compact = false,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "burrow-enter mx-auto flex max-w-xl",
        compact && "w-fit max-w-full",
        compact
          ? "flex-row flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 py-4 text-left"
          : "flex-col items-center gap-2 px-6 py-14 text-center",
        className,
      )}
    >
      <div
        className={cn(
          "mb-1 grid size-10 place-items-center rounded-full border border-dashed border-seam-strong text-ink-3",
          compact && "mb-0 size-7",
        )}
      >
        {icon ?? <Inbox className={cn("size-5", compact && "size-4")} aria-hidden="true" />}
      </div>
      <div className={cn(compact ? "min-w-0 flex-1 basis-48 text-left" : "contents")}>
        <h2 className={compact ? "text-small font-medium" : "text-lead"}>{title}</h2>
        {children && <p className={compact ? "text-caption text-ink-3" : "text-body text-ink-3"}>{children}</p>}
      </div>
      {action && <div className={compact ? "mt-0" : "mt-2"}>{action}</div>}
    </div>
  );
}

/** Errors say what failed, where, and what to try; never apologise, never vague. */
export function ErrorState({
  title,
  message,
  detail,
  hint,
  onRetry,
  compact = false,
  className,
}: {
  title: string;
  message?: ReactNode;
  detail?: ReactNode;
  hint?: ReactNode;
  onRetry?: () => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "burrow-enter mx-auto flex w-full min-w-0 max-w-lg text-center",
        compact ? "flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1 px-3 py-2" : "flex-col items-center gap-2 px-6 py-12",
        className,
      )}
    >
      <div
        className={cn(
          "mb-1 grid size-10 place-items-center rounded-full bg-[color-mix(in_oklch,var(--fail)_14%,transparent)] text-fail",
          compact && "mb-0 size-7",
        )}
      >
        <TriangleAlert className={cn("size-5", compact && "size-4")} aria-hidden="true" />
      </div>
      <div className={cn(compact ? "min-w-0 flex-1 basis-48 text-left" : "contents")}>
        <h2 className={compact ? "text-small font-medium" : "text-lead"}>{title}</h2>
        {message && (
          <p className={cn("min-w-0 max-w-full [overflow-wrap:anywhere]", compact ? "text-caption text-ink-2" : "text-body text-ink-2")}>
            {message}
          </p>
        )}
        {hint && (
          <p className={cn("min-w-0 max-w-full [overflow-wrap:anywhere]", compact ? "text-micro text-ink-3" : "text-small text-ink-3")}>
            {hint}
          </p>
        )}
      </div>
      {detail && (
        <details className="mt-1 w-full min-w-0 max-w-full rounded-md bg-well px-2 py-1.5 text-left text-micro text-ink-3">
          <summary className="min-h-6 cursor-pointer py-1 font-medium text-ink-2">Technical details</summary>
          <pre className="mt-1 max-w-full whitespace-pre-wrap break-all">{detail}</pre>
        </details>
      )}
      {onRetry && (
        <Button size={compact ? "sm" : "md"} className={compact ? "mt-0" : "mt-2"} onClick={onRetry}>
          Retry now
        </Button>
      )}
    </div>
  );
}

/** Compact warning for a failed refresh when the last successful response remains usable. */
export function StaleErrorBanner({ title, error, onRetry }: { title: string; error: unknown; onRetry?: () => void }) {
  return <ErrorState compact title={title} message={error instanceof Error ? error.message : String(error)} onRetry={onRetry} />;
}
