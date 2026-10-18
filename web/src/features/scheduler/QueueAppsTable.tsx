/**
 * Active applications of one queue (`GET /api/yarn/apps?queue=…&states=…`). A focused subset of the Applications
 * slice's 24-column table — the queue page's job is to show what is competing for the queue's capacity right now.
 */
import { Link } from "@tanstack/react-router";
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { fmtDuration, fmtInt, fmtMB, fmtPct } from "~/lib/format";
import type { App } from "~/api/schemas";

const COLS: ColDef<App>[] = [
  {
    id: "id",
    meta: { label: "ID", pinned: true },
    size: 250,
    cell: ({ row }) => (
      <Link to="/apps/$appId" params={{ appId: row.original.id }} className="truncate font-mono text-caption text-live hover:underline">
        <Datum field="app.id" raw={row.original.id} className="truncate">
          {row.original.id}
        </Datum>
      </Link>
    ),
  },
  {
    id: "user",
    meta: { label: "User" },
    size: 110,
    cell: ({ row }) => <Datum field="app.user" raw={row.original.user} className="truncate" />,
  },
  {
    id: "name",
    meta: { label: "Name" },
    size: 220,
    cell: ({ row }) => <Datum field="app.name" raw={row.original.name} className="truncate" />,
  },
  {
    id: "applicationType",
    meta: { label: "Application Type" },
    size: 150,
    cell: ({ row }) => <Datum field="app.applicationType" raw={row.original.applicationType} className="truncate" />,
  },
  {
    id: "priority",
    meta: { label: "Application Priority", align: "end" },
    size: 150,
    cell: ({ row }) => (
      <Datum field="app.priority" raw={row.original.priority} fmt="int" className="tnum">
        {fmtInt(row.original.priority)}
      </Datum>
    ),
  },
  {
    id: "state",
    meta: { label: "State" },
    size: 120,
    cell: ({ row }) => <StatusPill domain="app.state" state={row.original.state} field="app.state" size="sm" />,
  },
  {
    id: "finalStatus",
    meta: { label: "FinalStatus" },
    size: 120,
    cell: ({ row }) => <StatusPill domain="app.finalStatus" state={row.original.finalStatus} field="app.finalStatus" size="sm" />,
  },
  {
    id: "runningContainers",
    meta: { label: "Running Containers", align: "end" },
    size: 150,
    cell: ({ row }) => (
      <Datum field="app.runningContainers" raw={row.original.runningContainers} fmt="int" className="tnum">
        {fmtInt(row.original.runningContainers)}
      </Datum>
    ),
  },
  {
    id: "allocatedMB",
    meta: { label: "Allocated Memory MB", align: "end" },
    size: 158,
    cell: ({ row }) => (
      <Datum field="app.allocatedMB" raw={row.original.allocatedMB} fmt="mb" className="tnum">
        {fmtMB(row.original.allocatedMB)}
      </Datum>
    ),
  },
  {
    id: "allocatedVCores",
    meta: { label: "Allocated CPU VCores", align: "end" },
    size: 160,
    cell: ({ row }) => (
      <Datum field="app.allocatedVCores" raw={row.original.allocatedVCores} fmt="int" className="tnum">
        {fmtInt(row.original.allocatedVCores)}
      </Datum>
    ),
  },
  {
    id: "reservedMB",
    meta: { label: "Reserved Memory MB", align: "end" },
    size: 152,
    cell: ({ row }) => (
      <Datum field="app.reservedMB" raw={row.original.reservedMB} fmt="mb" className="tnum">
        {fmtMB(row.original.reservedMB)}
      </Datum>
    ),
  },
  {
    id: "reservedVCores",
    meta: { label: "Reserved CPU VCores", align: "end" },
    size: 154,
    cell: ({ row }) => (
      <Datum field="app.reservedVCores" raw={row.original.reservedVCores} fmt="int" className="tnum">
        {fmtInt(row.original.reservedVCores)}
      </Datum>
    ),
  },
  {
    id: "queueUsagePercentage",
    meta: { label: "% of Queue", align: "end" },
    size: 110,
    cell: ({ row }) => (
      <Datum field="app.queueUsagePercentage" raw={row.original.queueUsagePercentage} fmt="pct" className="tnum">
        {fmtPct(row.original.queueUsagePercentage)}
      </Datum>
    ),
  },
  {
    id: "clusterUsagePercentage",
    meta: { label: "% of Cluster", align: "end" },
    size: 120,
    cell: ({ row }) => (
      <Datum field="app.clusterUsagePercentage" raw={row.original.clusterUsagePercentage} fmt="pct" className="tnum">
        {fmtPct(row.original.clusterUsagePercentage)}
      </Datum>
    ),
  },
  {
    id: "startedTime",
    meta: { label: "StartTime" },
    size: 160,
    cell: ({ row }) => <Datum field="app.startedTime" raw={row.original.startedTime} fmt="epoch" className="tnum" />,
  },
  {
    id: "elapsedTime",
    meta: { label: "Elapsed", align: "end" },
    size: 110,
    cell: ({ row }) => (
      <Datum field="app.elapsedTime" raw={row.original.elapsedTime} fmt="dur" className="tnum">
        {fmtDuration(row.original.elapsedTime)}
      </Datum>
    ),
  },
  {
    id: "progress",
    meta: { label: "Progress", align: "end" },
    size: 100,
    cell: ({ row }) => (
      <Datum field="app.progress" raw={row.original.progress} fmt="pct" className="tnum">
        {fmtPct(row.original.progress)}
      </Datum>
    ),
  },
];

export function QueueAppsTable({
  apps,
  loading,
  error,
  sorting,
  onSortingChange,
  columnVisibility,
  onColumnVisibilityChange,
  className,
  stableViewport = false,
}: {
  apps: App[];
  loading?: boolean;
  error?: React.ReactNode;
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  columnVisibility: ColumnVisibilityState;
  onColumnVisibilityChange: (v: ColumnVisibilityState) => void;
  className?: string;
  stableViewport?: boolean;
}) {
  return (
    <DataTable
      className={className ?? (stableViewport ? "h-[min(34dvh,360px)]" : undefined)}
      data={apps}
      columns={COLS}
      getRowId={(a) => a.id}
      entityKey={(a) => a.id}
      label="Applications in this queue"
      storageKey="scheduler-queue-apps"
      sorting={sorting}
      onSortingChange={onSortingChange}
      columnVisibility={columnVisibility}
      onColumnVisibilityChange={onColumnVisibilityChange}
      defaultVisibility={{ applicationType: false, finalStatus: false, reservedMB: false, reservedVCores: false }}
      loading={loading}
      error={error}
      empty={
        <div className="px-4 py-10 text-center text-body text-ink-3">
          No application is running or waiting in this queue.
          <p className="mt-1 text-small text-ink-4">Finished applications live under Applications → Finished.</p>
        </div>
      }
      exportName="queue-apps"
      totalCount={apps.length}
      stableViewport={stableViewport}
    />
  );
}
