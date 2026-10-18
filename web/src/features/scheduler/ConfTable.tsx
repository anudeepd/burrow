/**
 * Scheduler configuration — `GET /api/yarn/scheduler-conf` (Capacity only: the endpoint 400s for Fair/FIFO because they
 * do not implement MutableConfScheduler). Entity `conf`, fields `conf.property.name` / `conf.property.value`.
 * No legacy page consumes this endpoint; it is exposed here because queue freeness is often explained by its config.
 */
import { useMemo } from "react";
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import type { SchedulerConfItem } from "~/api/schemas";
import { Button } from "~/ui/button";
import { cn } from "~/lib/cn";

const COLS: ColDef<SchedulerConfItem>[] = [
  {
    id: "name",
    meta: { label: "Property", pinned: true },
    cell: ({ row }) => (
      <Datum field="conf.property.name" raw={row.original.name} className="truncate font-mono text-caption">
        {row.original.name}
      </Datum>
    ),
  },
  {
    id: "value",
    meta: { label: "Value" },
    cell: ({ row }) => (
      <Datum field="conf.property.value" raw={row.original.value} className="truncate font-mono text-caption">
        {row.original.value ?? "—"}
      </Datum>
    ),
  },
];

export function ConfTable({
  properties,
  queuePath,
  showAll,
  onShowAllChange,
  loading,
  error,
  sorting,
  onSortingChange,
  columnVisibility,
  onColumnVisibilityChange,
  className,
  fit = false,
  stableViewport = false,
}: {
  properties: SchedulerConfItem[];
  /** when set, only this queue's subtree properties are shown */
  queuePath?: string;
  showAll: boolean;
  onShowAllChange: (v: boolean) => void;
  loading?: boolean;
  error?: React.ReactNode;
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  columnVisibility: ColumnVisibilityState;
  onColumnVisibilityChange: (v: ColumnVisibilityState) => void;
  className?: string;
  /** Fill the active scheduler tab while keeping long row sets inside a bounded table viewport. */
  fit?: boolean;
  /** Keep a steady scroll viewport while live rows are added or removed. */
  stableViewport?: boolean;
}) {
  const rows = useMemo(() => {
    if (!queuePath || showAll) return properties;
    const prefix = `yarn.scheduler.capacity.${queuePath}.`;
    return properties.filter((p) => p.name.startsWith(prefix));
  }, [properties, queuePath, showAll]);
  // The scheduler-wide Configuration tab fills the space below its header and metrics. Keep that viewport steady
  // once the list grows so rows scroll inside the table instead of pushing its header/footer down the page.
  const keepViewport = stableViewport || fit;

  return (
    <div className={cn(fit && "flex min-h-0 flex-1 flex-col", className)}>
      <DataTable
        data={rows}
        columns={COLS}
        getRowId={(p) => p.name}
        entityKey={() => "_"}
        label="Scheduler configuration"
        storageKey="scheduler-conf"
        sorting={sorting}
        onSortingChange={onSortingChange}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={onColumnVisibilityChange}
        defaultVisibility={{}}
        loading={loading}
        error={error}
        empty={
          <div className="px-4 py-10 text-center text-body text-ink-3">
            No scheduler property matches {queuePath ? <span className="font-mono">{queuePath}</span> : "this cluster"}.
            <p className="mt-1 text-small text-ink-4">
              The RM returns the effective capacity-scheduler configuration; a queue created at runtime may have no explicit property yet.
            </p>
          </div>
        }
        exportName="scheduler-conf"
        totalCount={rows.length}
        className={
          keepViewport
            ? "flex-none max-h-[min(30dvh,320px)]"
            : "flex-none h-[min(32dvh,400px)] min-h-60 sm:h-[min(48dvh,640px)] sm:min-h-72 xl:h-[min(64dvh,calc(100dvh_-_21rem),640px)]"
        }
        stableViewport={keepViewport}
        toolbar={
          queuePath ? (
            <div className="flex items-center gap-0.5" role="group" aria-label="Configuration scope">
              <Button size="sm" variant={!showAll ? "default" : "ghost"} aria-pressed={!showAll} onClick={() => onShowAllChange(false)}>
                This queue
              </Button>
              <Button size="sm" variant={showAll ? "default" : "ghost"} aria-pressed={showAll} onClick={() => onShowAllChange(true)}>
                Whole scheduler
              </Button>
              <span className="ml-1 text-small text-ink-4 tnum">
                {rows.length} of {properties.length} properties
              </span>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
