/**
 * Shared state panels for Spark pages: one place that decides what "we cannot show this" looks like.
 *
 * Rules (task brief): never fake a value. When a fetch fails, render the specific reason — backend route missing,
 * source unavailable, not found, unreachable, schema drift — plus the one action that helps. Loading and empty states are
 * structural (table skeletons, "no rows yet"), so a page never collapses to a blank rectangle.
 */
import type { ReactNode } from "react";
import { EmptyState, ErrorState, TableSkeleton } from "~/ui/feedback";
import { Button } from "~/ui/button";
import { classifySparkError, type SparkFailure } from "./errors";

/** Renders the classified failure. `subject` names the thing being fetched ("stage 3", "SQL execution 0"). */
export function SparkFailureState({ error, subject, onRetry }: { error: unknown; subject: string; onRetry?: () => void }) {
  const f: SparkFailure = classifySparkError(error, subject);
  return (
    <ErrorState
      title={f.title}
      message={f.message}
      hint={f.hint}
      detail={f.detail}
      onRetry={f.kind === "backend-missing" ? undefined : onRetry}
      className="py-10"
    />
  );
}

/** Failed background refresh: keep the last successful Spark response visible. */
export function SparkStaleErrorBanner({ error, subject, onRetry }: { error: unknown; subject: string; onRetry?: () => void }) {
  const f: SparkFailure = classifySparkError(error, subject);
  return (
    <ErrorState
      compact
      title={`Could not refresh ${subject}`}
      message={f.message}
      hint={f.hint}
      onRetry={f.kind === "backend-missing" ? undefined : onRetry}
    />
  );
}

/** Deliberate "there is nothing here" — with room for the reason. */
export function SparkEmpty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <EmptyState title={title} action={action} className="py-10">
      {children}
    </EmptyState>
  );
}

/** Skeleton sized like the table it replaces. */
export function SparkLoading({ rows = 8, cols = 7 }: { rows?: number; cols?: number }) {
  return <TableSkeleton rows={rows} cols={cols} />;
}

/**
 * A section whose data comes from a *different* source than the page (DAG HTML extraction, streaming endpoints, taskList):
 * while loading show the skeleton, on failure show the reason inline without taking down the rest of the page.
 */
export function SparkSection({
  title,
  loading,
  error,
  subject,
  onRetry,
  empty,
  children,
}: {
  title: string;
  loading?: boolean;
  error?: unknown;
  subject: string;
  onRetry?: () => void;
  empty?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      {loading ? (
        <SparkLoading rows={4} cols={4} />
      ) : error ? (
        <SparkFailureState error={error} subject={subject} onRetry={onRetry} />
      ) : (
        (children ?? empty)
      )}
    </section>
  );
}

/** A small inline "this endpoint is not available" note used inside dense tables/cards. */
export function InlineNote({ children, tone = "idle" }: { children: ReactNode; tone?: "idle" | "warn" }) {
  return (
    <p
      className={
        tone === "warn"
          ? "rounded-md border border-dashed border-seam-strong bg-well px-2.5 py-1.5 text-small text-ink-3"
          : "text-small text-ink-3"
      }
    >
      {children}
    </p>
  );
}

export function RetryRow({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex justify-center py-4">
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
