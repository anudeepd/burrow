/** Node-label partitions with one sortable row per registered NodeManager. */
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import type { Node } from "~/api/schemas";
import { fmtMB } from "~/lib/format";
import { DataTable, defaultVisibilityOf } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum, Entity } from "~/ui/datum";
import { HorizontalScrollCues, useHorizontalScrollCues } from "~/ui/horizontal-scroll-cues";
import { StatusPill } from "~/ui/status";
import { resourceInfoText } from "~/features/overview/derive";
import { Section } from "./Chrome";
import { partitionText, resourceValueText } from "./format";

/** `RMNodeLabel.getResource()`: total memory and vCores for the nodes carrying a label. */
function partitionResources(nodes: readonly Node[]): { memory: number; vCores: number } {
  const memory = nodes.reduce((a, n) => a + n.usedMemoryMB + n.availMemoryMB, 0);
  const vCores = nodes.reduce((a, n) => a + n.usedVirtualCores + n.availableVirtualCores, 0);
  return { memory, vCores };
}

function partitionResourceText(nodes: readonly Node[]): string {
  const resources = partitionResources(nodes);
  return resourceInfoText(resources.memory, resources.vCores);
}

/** Legacy partition tag retained for the parity contract. */
export function partitionUiTag(label: string, nodes: readonly Node[]): string {
  return `Partition: ${label || "<DEFAULT_PARTITION>"} ${partitionResourceText(nodes)}`;
}

export function partitionDisplayTag(label: string, nodes: readonly Node[]): string {
  const resources = partitionResources(nodes);
  return `Partition: ${partitionText(label)} · ${resourceValueText(resources.memory, resources.vCores)}`;
}

interface PartitionNodeRow {
  node: Node;
  partition: string;
}

const COLUMNS: ColDef<PartitionNodeRow>[] = [
  {
    id: "partition",
    accessorFn: (row) => row.partition,
    size: 150,
    meta: { label: "Partition", hint: "Unlabelled nodes belong to the default partition." },
    cell: ({ row }) => (
      <Datum field="node.nodeLabels" raw={row.original.node.nodeLabels ?? []} fmt="text" className="font-mono text-small text-ink-2">
        {partitionText(row.original.partition)}
      </Datum>
    ),
  },
  {
    id: "node",
    accessorFn: (row) => row.node.id,
    size: 190,
    meta: { label: "Node", pinned: true },
    cell: ({ row }) => (
      <Datum field="node.id" raw={row.original.node.id} fmt="text" className="truncate font-mono text-small">
        <Link
          to="/nodes/$nodeId"
          params={{ nodeId: row.original.node.id }}
          className="hover:text-live hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {row.original.node.id}
        </Link>
      </Datum>
    ),
  },
  {
    id: "containers",
    accessorFn: (row) => row.node.numContainers,
    size: 100,
    meta: { label: "Containers", align: "end" },
    cell: ({ row }) => <Datum field="node.numContainers" raw={row.original.node.numContainers} fmt="int" className="tnum" />,
  },
  {
    id: "memory",
    accessorFn: (row) => row.node.usedMemoryMB,
    size: 220,
    meta: { label: "Memory", hint: "Used · free" },
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-small">
        <Datum field="node.usedMemoryMB" raw={row.original.node.usedMemoryMB} fmt="mb" className="tnum">
          {fmtMB(row.original.node.usedMemoryMB)}
        </Datum>
        <span className="text-ink-4"> used · </span>
        <Datum field="node.availMemoryMB" raw={row.original.node.availMemoryMB} fmt="mb" className="tnum">
          {fmtMB(row.original.node.availMemoryMB)}
        </Datum>
        <span className="text-ink-3"> free</span>
      </span>
    ),
  },
  {
    id: "vcores",
    accessorFn: (row) => row.node.usedVirtualCores,
    size: 190,
    meta: { label: "vCores", hint: "Used · free" },
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-small tnum">
        <Datum field="node.usedVirtualCores" raw={row.original.node.usedVirtualCores} fmt="int" />
        <span className="text-ink-4"> used · </span>
        <Datum field="node.availableVirtualCores" raw={row.original.node.availableVirtualCores} fmt="int" />
        <span className="text-ink-3"> free</span>
      </span>
    ),
  },
  {
    id: "state",
    accessorFn: (row) => row.node.state,
    size: 105,
    meta: { label: "State" },
    cell: ({ row }) => <StatusPill domain="node.state" state={row.original.node.state} field="node.state" size="sm" />,
  },
];

const DEFAULT_SORTING: SortingState = [
  { id: "partition", desc: false },
  { id: "node", desc: false },
];
const DEFAULT_VISIBILITY = defaultVisibilityOf(COLUMNS);

export function NodeLabelsCard({
  nodes,
  loading,
  stale,
  error,
  className,
}: {
  nodes: Node[];
  loading?: boolean;
  stale?: boolean;
  error?: ReactNode;
  className?: string;
}) {
  const navigate = useNavigate();
  const rows = useMemo<PartitionNodeRow[]>(
    () =>
      nodes.map((node) => ({
        node,
        partition: node.nodeLabels?.length ? node.nodeLabels.join(", ") : "Default",
      })),
    [nodes],
  );
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORTING);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>(DEFAULT_VISIBILITY);

  const partitions = useMemo(() => {
    const grouped = new Map<string, Node[]>();
    for (const node of nodes) {
      for (const label of node.nodeLabels?.length ? node.nodeLabels : [""]) {
        const group = grouped.get(label) ?? [];
        group.push(node);
        grouped.set(label, group);
      }
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [nodes]);
  const partitionStripRef = useRef<HTMLDivElement>(null);
  const partitionCues = useHorizontalScrollCues(partitionStripRef, true, partitions);

  return (
    <Section title="Node-label partitions" className={className}>
      <DataTable
        data={rows}
        columns={COLUMNS}
        getRowId={(row) => row.node.id}
        entityKey={(row) => row.node.id}
        label="Nodes by label partition"
        storageKey="scheduler-node-labels"
        sorting={sorting}
        onSortingChange={setSorting}
        defaultSorting={DEFAULT_SORTING}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={setColumnVisibility}
        defaultVisibility={DEFAULT_VISIBILITY}
        onRowActivate={(row) => void navigate({ to: "/nodes/$nodeId", params: { nodeId: row.node.id } })}
        loading={loading}
        error={error}
        empty={<div className="px-4 py-8 text-center text-body text-ink-3">No registered nodes.</div>}
        exportName="node-label-partitions"
        totalCount={rows.length}
        toolbar={
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <div
                ref={partitionStripRef}
                role="region"
                aria-label="Partition resource totals"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: This horizontal region must be focusable so keyboard users can scroll additional partitions.
                tabIndex={0}
                onScroll={partitionCues.onScroll}
                className="burrow-scroll burrow-scroll-hidden flex min-w-0 items-center gap-2 overflow-x-auto py-px"
              >
                {partitions.map(([label, members]) => (
                  <Entity
                    key={label}
                    id={label || "_"}
                    className="shrink-0 rounded-md border border-seam bg-well px-2 py-1 text-small text-ink-2"
                  >
                    <Datum field="queue.derived.partitionUiTag" raw={partitionUiTag(label, members)}>
                      {partitionDisplayTag(label, members)}
                    </Datum>
                  </Entity>
                ))}
              </div>
              <HorizontalScrollCues left={partitionCues.left} right={partitionCues.right} />
            </div>
            {stale && (
              <span role="status" className="shrink-0 text-small text-warn">
                showing cached nodes
              </span>
            )}
          </div>
        }
        toolbarArrangement="inline"
        className="h-[min(44dvh,420px)]"
      />
    </Section>
  );
}
