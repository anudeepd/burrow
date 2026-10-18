/**
 * Node-label partitions of a capacity queue — `capacities.queueCapacitiesByPartition[]` and
 * `resources.resourceUsagesByPartition[]`, which is where per-label capacity/usage lives.
 * Rows share the queue entity (the inventory keeps partitions as nested leaves under `queue`), so field ids are the
 * literal paths with the array index dropped.
 */
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import { fmtInt, fmtMB } from "~/lib/format";
import type { PartitionCapacity, PartitionResourcesInfo } from "~/api/schemas";
import { countText, partitionText, pctText } from "./format";

export interface PartitionRow {
  cap: PartitionCapacity;
  res: PartitionResourcesInfo | undefined;
}

const COLS: ColDef<PartitionRow>[] = [
  {
    id: "partition",
    meta: { label: "Partition", hint: "Node-label partition. Unlabelled nodes belong to the default partition.", pinned: true },
    size: 180,
    cell: ({ row }) => (
      <Datum
        field="queue.capacities.queueCapacitiesByPartition.partitionName"
        raw={row.original.cap.partitionName ?? ""}
        className="text-caption"
      >
        {partitionText(row.original.cap.partitionName)}
      </Datum>
    ),
  },
  {
    id: "capacity",
    meta: { label: "Capacity %", hint: "Guaranteed share of the parent queue within this partition.", align: "end" },
    size: 110,
    cell: ({ row }) => (
      <Datum field="queue.capacities.queueCapacitiesByPartition.capacity" raw={row.original.cap.capacity} fmt="pct" className="tnum">
        {pctText(row.original.cap.capacity)}
      </Datum>
    ),
  },
  {
    id: "usedCapacity",
    meta: { label: "Used Capacity %", hint: "Resources used relative to this queue’s guaranteed capacity in the partition.", align: "end" },
    size: 130,
    cell: ({ row }) => (
      <Datum
        field="queue.capacities.queueCapacitiesByPartition.usedCapacity"
        raw={row.original.cap.usedCapacity}
        fmt="pct"
        className="tnum"
      >
        {pctText(row.original.cap.usedCapacity)}
      </Datum>
    ),
  },
  {
    id: "maxCapacity",
    meta: { label: "Max Capacity %", hint: "Maximum share of the parent queue this queue may use in this partition.", align: "end" },
    size: 130,
    cell: ({ row }) => (
      <Datum field="queue.capacities.queueCapacitiesByPartition.maxCapacity" raw={row.original.cap.maxCapacity} fmt="pct" className="tnum">
        {pctText(row.original.cap.maxCapacity)}
      </Datum>
    ),
  },
  {
    id: "absoluteCapacity",
    meta: { label: "Absolute Capacity %", hint: "Guaranteed share of the entire partition.", align: "end" },
    size: 150,
    cell: ({ row }) => (
      <Datum
        field="queue.capacities.queueCapacitiesByPartition.absoluteCapacity"
        raw={row.original.cap.absoluteCapacity}
        fmt="pct"
        className="tnum"
      >
        {pctText(row.original.cap.absoluteCapacity)}
      </Datum>
    ),
  },
  {
    id: "absoluteUsedCapacity",
    meta: { label: "Absolute Used %", hint: "Used resources as a share of the entire partition.", align: "end" },
    size: 140,
    cell: ({ row }) => (
      <Datum
        field="queue.capacities.queueCapacitiesByPartition.absoluteUsedCapacity"
        raw={row.original.cap.absoluteUsedCapacity}
        fmt="pct"
        className="tnum"
      >
        {pctText(row.original.cap.absoluteUsedCapacity)}
      </Datum>
    ),
  },
  {
    id: "absoluteMaxCapacity",
    meta: { label: "Absolute Max %", hint: "Maximum share of the entire partition this queue may use.", align: "end" },
    size: 140,
    cell: ({ row }) => (
      <Datum
        field="queue.capacities.queueCapacitiesByPartition.absoluteMaxCapacity"
        raw={row.original.cap.absoluteMaxCapacity}
        fmt="pct"
        className="tnum"
      >
        {pctText(row.original.cap.absoluteMaxCapacity)}
      </Datum>
    ),
  },
  {
    id: "maxAmLimit",
    meta: {
      label: "Max AM Limit %",
      align: "end",
      hint: "maxAMLimitPercentage — 0 on parent queues (the REST layer computes it without AM usage)",
    },
    size: 130,
    cell: ({ row }) => (
      <Datum
        field="queue.capacities.queueCapacitiesByPartition.maxAMLimitPercentage"
        raw={row.original.cap.maxAMLimitPercentage}
        fmt="pct"
        className="tnum"
      >
        {pctText(row.original.cap.maxAMLimitPercentage ?? null)}
      </Datum>
    ),
  },
  {
    id: "effectiveMin",
    meta: { label: "Effective Min", hint: "Minimum resource allocation calculated by the scheduler for this partition.", align: "end" },
    size: 130,
    cell: ({ row }) => (
      <Datum
        field="queue.capacities.queueCapacitiesByPartition.effectiveMinResource.memory"
        raw={row.original.cap.effectiveMinResource?.memory}
        fmt="mb"
        className="tnum"
      >
        {row.original.cap.effectiveMinResource ? fmtMB(row.original.cap.effectiveMinResource.memory) : "—"}
      </Datum>
    ),
  },
  {
    id: "effectiveMax",
    meta: { label: "Effective Max", hint: "Maximum resource allocation calculated by the scheduler for this partition.", align: "end" },
    size: 130,
    cell: ({ row }) => (
      <Datum
        field="queue.capacities.queueCapacitiesByPartition.effectiveMaxResource.memory"
        raw={row.original.cap.effectiveMaxResource?.memory}
        fmt="mb"
        className="tnum"
      >
        {row.original.cap.effectiveMaxResource ? fmtMB(row.original.cap.effectiveMaxResource.memory) : "—"}
      </Datum>
    ),
  },
  {
    id: "configuredMin",
    meta: { label: "Configured Min", hint: "Minimum resource allocation configured for this partition.", align: "end" },
    size: 130,
    cell: ({ row }) => (
      <Datum
        field="queue.capacities.queueCapacitiesByPartition.configuredMinResource.memory"
        raw={row.original.cap.configuredMinResource?.memory}
        fmt="mb"
        className="tnum"
      >
        {row.original.cap.configuredMinResource ? fmtMB(row.original.cap.configuredMinResource.memory) : "—"}
      </Datum>
    ),
  },
  {
    id: "configuredMax",
    meta: { label: "Configured Max", hint: "Maximum resource allocation configured for this partition.", align: "end" },
    size: 130,
    cell: ({ row }) => (
      <Datum
        field="queue.capacities.queueCapacitiesByPartition.configuredMaxResource.memory"
        raw={row.original.cap.configuredMaxResource?.memory}
        fmt="mb"
        className="tnum"
      >
        {row.original.cap.configuredMaxResource ? fmtMB(row.original.cap.configuredMaxResource.memory) : "—"}
      </Datum>
    ),
  },
  {
    id: "weight",
    meta: { label: "Weight", hint: "Relative scheduling weight used when capacity is configured by weight.", align: "end" },
    size: 100,
    cell: ({ row }) => (
      <Datum field="queue.capacities.queueCapacitiesByPartition.weight" raw={row.original.cap.weight} className="tnum">
        {row.original.cap.weight == null ? "—" : String(row.original.cap.weight)}
      </Datum>
    ),
  },
  {
    id: "usedMem",
    meta: { label: "Used Mem", hint: "Memory allocated to containers in this queue and partition.", align: "end" },
    size: 120,
    cell: ({ row }) => (
      <Datum field="queue.resources.resourceUsagesByPartition.used.memory" raw={row.original.res?.used?.memory} fmt="mb" className="tnum">
        {row.original.res?.used ? fmtMB(row.original.res.used.memory) : "—"}
      </Datum>
    ),
  },
  {
    id: "usedVcores",
    meta: { label: "Used vCores", hint: "Virtual CPU cores allocated to containers in this queue and partition.", align: "end" },
    size: 120,
    cell: ({ row }) => (
      <Datum field="queue.resources.resourceUsagesByPartition.used.vCores" raw={row.original.res?.used?.vCores} fmt="int" className="tnum">
        {countText(row.original.res?.used?.vCores ?? null)}
      </Datum>
    ),
  },
  {
    id: "reservedMem",
    meta: { label: "Reserved Mem", hint: "Memory reserved for requests that cannot currently be allocated.", align: "end" },
    size: 130,
    cell: ({ row }) => (
      <Datum
        field="queue.resources.resourceUsagesByPartition.reserved.memory"
        raw={row.original.res?.reserved?.memory}
        fmt="mb"
        className="tnum"
      >
        {row.original.res?.reserved ? fmtInt(row.original.res.reserved.memory) : "—"}
      </Datum>
    ),
  },
  {
    id: "pendingMem",
    meta: { label: "Pending Mem", hint: "Memory requested by applications that has not yet been allocated.", align: "end" },
    size: 126,
    cell: ({ row }) => (
      <Datum
        field="queue.resources.resourceUsagesByPartition.pending.memory"
        raw={row.original.res?.pending?.memory}
        fmt="mb"
        className="tnum"
      >
        {row.original.res?.pending ? fmtInt(row.original.res.pending.memory) : "—"}
      </Datum>
    ),
  },
];

export function PartitionsTable({
  queuePath,
  rows,
  sorting,
  onSortingChange,
  columnVisibility,
  onColumnVisibilityChange,
  className,
  stableViewport = false,
}: {
  queuePath: string;
  rows: PartitionRow[];
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  columnVisibility: ColumnVisibilityState;
  onColumnVisibilityChange: (v: ColumnVisibilityState) => void;
  className?: string;
  stableViewport?: boolean;
}) {
  return (
    <div className={className}>
      <DataTable
        data={rows}
        columns={COLS}
        getRowId={(r) => `${queuePath}#${r.cap.partitionName ?? ""}`}
        entityKey={() => queuePath}
        label={`Node-label partitions of ${queuePath}`}
        storageKey="scheduler-partitions"
        sorting={sorting}
        onSortingChange={onSortingChange}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={onColumnVisibilityChange}
        defaultVisibility={{ configuredMin: false, configuredMax: false, weight: false, reservedMem: false, pendingMem: false }}
        empty={<div className="px-4 py-10 text-center text-body text-ink-3">This queue has no per-partition capacities.</div>}
        exportName="queue-partitions"
        totalCount={rows.length}
        className="h-[min(34dvh,360px)]"
        stableViewport={stableViewport}
      />
    </div>
  );
}
