import { Skeleton } from "~/ui/feedback";

/** Route-level placeholder while the overview bundle is loading. */
export function OverviewLoading() {
  return (
    <div
      className="burrow-scroll burrow-page-scroll min-h-0 flex-1 overflow-y-auto pb-6"
      role="status"
      aria-busy="true"
      aria-label="Loading cluster overview"
    >
      <div className="burrow-overview-content mx-auto flex w-full max-w-[1560px] flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-seam pb-5">
          <div>
            <h1 className="text-h1 font-semibold text-ink">Overview</h1>
            <p className="mt-1 text-body text-ink-3">Loading live cluster data…</p>
          </div>
          <Skeleton className="h-9 w-40" />
        </header>

        <div className="flex flex-col gap-3 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3 w-full max-w-2xl" />
        </div>

        <section className="flex flex-col gap-4 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]">
          <Skeleton className="h-4 w-32" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-52 rounded-lg" />
          <Skeleton className="h-52 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
