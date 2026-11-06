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
    accessorFn: (row) => row.name,
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
  /** Reserve a stable loading shell; ready results are sized to content and remaining page height. */
  stableViewport?: boolean;
}) {
  const rows = useMemo(() => {
    if (!queuePath || showAll) return properties;
    const prefix = `yarn.scheduler.capacity.${queuePath}.`;
    return properties.filter((p) => p.name.startsWith(prefix));
  }, [properties, queuePath, showAll]);
  // The scheduler-wide Configuration tab reserves its loading pane; ready rows cap to the remaining scrollport height.
  const reserveViewport = stableViewport || fit;

  return (
    <div className={cn(fit && "flex min-h-0 flex-1 flex-col", className)}>
      <DataTable
        data={rows}
        contentIdentity={`${queuePath ?? ""}\0${showAll}`}
        initialContentFade={false}
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
          <div role="status" className="burrow-enter px-4 py-10 text-center text-body text-ink-3">
            No scheduler property matches {queuePath ? <span className="font-mono">{queuePath}</span> : "this cluster"}.
            <p className="mt-1 text-small text-ink-4">
              The RM returns the effective capacity-scheduler configuration; a queue created at runtime may have no explicit property yet.
            </p>
          </div>
        }
        exportName="scheduler-conf"
        totalCount={rows.length}
        className={reserveViewport ? "flex-none" : "flex-none min-h-60 sm:min-h-72"}
        stableViewport={reserveViewport}
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
