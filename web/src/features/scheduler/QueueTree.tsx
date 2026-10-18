/**
 * The queue tree: a flattened, virtualized view of the scheduler hierarchy rendered through the shared `DataTable`.
 * Expansion is controlled by the page (`openQueues` search param, matching the legacy `openQueues=` convention); sibling
 * order is a `sort` search param (name · used · free · apps) because a plain column sort would break the hierarchy.
 */
import { useMemo } from "react";
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { DataTable, defaultVisibilityOf } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum, Entity } from "~/ui/datum";
import { cn } from "~/lib/cn";
import { Button } from "~/ui/button";
import { type QueueNode, headroomOf, metricsOf, partitionOf, walkTree } from "./model";
import { type QueueRow, capacityColumns, fairColumns, toQueueRows } from "./columns";

export type SiblingSort = "name" | "used" | "free" | "apps";

const sortValue = (node: QueueNode, sort: SiblingSort, partition: string): number | string => {
  const m = metricsOf(node, partition);
  switch (sort) {
    case "used":
      return -(m.absUsedPct ?? m.usedPct ?? -1);
    case "free":
      return -(headroomOf(node, partition).guaranteedFreePct ?? headroomOf(node, partition).fairShareFreeMb ?? -1);
    case "apps":
      return -(m.activeApps ?? m.apps ?? -1);
    default:
      return node.name;
  }
};

/** Depth-first flatten, skipping subtrees whose parent is collapsed, with siblings ordered by `sort`. */
function flatten(root: QueueNode, isOpen: (path: string) => boolean, sort: SiblingSort, partition: string): QueueNode[] {
  const out: QueueNode[] = [];
  const visit = (node: QueueNode) => {
    out.push(node);
    if (!node.children.length || !isOpen(node.id)) return;
    const kids = [...node.children].sort((a, b) => {
      const va = sortValue(a, sort, partition);
      const vb = sortValue(b, sort, partition);
      if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb));
      return va - vb;
    });
    for (const k of kids) visit(k);
  };
  visit(root);
  return out;
}

export function QueueTree({
  root,
  kind,
  partition,
  scale,
  isOpen,
  onToggle,
  sort,
  onSortChange,
  sorting,
  onSortingChange,
  columnVisibility,
  onColumnVisibilityChange,
  onActivate,
  className,
  toolbarExtra,
}: {
  root: QueueNode;
  kind: "capacity" | "fair";
  /** Shared scale across the whole tree so queue bars stay comparable. */
  scale: number;
  /** selected node-label partition ("" = default partition) */
  partition: string;
  isOpen: (path: string) => boolean;
  onToggle: (path: string) => void;
  sort: SiblingSort;
  onSortChange: (s: SiblingSort) => void;
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  columnVisibility: ColumnVisibilityState | undefined;
  onColumnVisibilityChange: (v: ColumnVisibilityState) => void;
  onActivate: (node: QueueNode) => void;
  className?: string;
  toolbarExtra?: React.ReactNode;
}) {
  const nodes = useMemo(() => flatten(root, isOpen, sort, partition), [root, isOpen, sort, partition]);
  const rows = useMemo(() => toQueueRows(nodes, partition), [nodes, partition]);
  const columns = useMemo<ColDef<QueueRow>[]>(
    () => (kind === "capacity" ? capacityColumns({ isOpen, onToggle, scale }) : fairColumns({ isOpen, onToggle, scale })),
    [kind, isOpen, onToggle, scale],
  );
  const total = useMemo(() => walkTree(root).length, [root]);
  /* the tree is 39 columns wide; only the core ones start visible (see columns.tsx) */
  const defaultVisibility = useMemo(() => defaultVisibilityOf(columns), [columns]);

  const sorts: { id: SiblingSort; label: string }[] = [
    { id: "name", label: "Name" },
    { id: "used", label: "Used" },
    { id: "free", label: "Free" },
    { id: "apps", label: "Apps" },
  ];

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.node.id}
        entityKey={(r) => r.node.id}
        label={`${kind === "capacity" ? "Capacity" : "Fair"} scheduler queue tree`}
        storageKey={`scheduler-${kind}-tree`}
        sorting={sorting}
        onSortingChange={onSortingChange}
        columnVisibility={columnVisibility ?? defaultVisibility}
        onColumnVisibilityChange={onColumnVisibilityChange}
        defaultVisibility={defaultVisibility}
        onRowActivate={(r) => onActivate(r.node)}
        totalCount={total}
        exportName={`${kind}-queues`}
        toolbar={
          <>
            {toolbarExtra}
            <div className="flex items-center gap-1 text-small text-ink-3">
              <span className="text-ink-4">Order siblings by</span>
              <div className="flex items-center gap-0.5" role="group" aria-label="Sibling order">
                {sorts.map((s) => (
                  <Button
                    key={s.id}
                    size="sm"
                    variant={sort === s.id ? "default" : "ghost"}
                    aria-pressed={sort === s.id}
                    onClick={() => onSortChange(s.id)}
                    className={cn(sort === s.id && "text-ink")}
                  >
                    {s.label}
                  </Button>
                ))}
              </div>
            </div>
          </>
        }
      />
      <QueueTreeA11y root={root} isOpen={isOpen} partition={partition} />
    </div>
  );
}

/**
 * Accessible twin of the tree: the grid gives sighted users aligned columns, but a hierarchy belongs in a `tree`. This
 * visually-hidden list carries the real tree semantics (`treeitem` + `aria-expanded` + nesting = level) and links each
 * queue, so a screen reader user gets the structure the columns cannot express.
 */
export function QueueTreeA11y({
  root,
  isOpen,
  partition = "",
}: {
  root: QueueNode;
  isOpen: (path: string) => boolean;
  partition?: string;
}) {
  const render = (node: QueueNode) => {
    const m = metricsOf(node, partition);
    const h = headroomOf(node, partition);
    const open = isOpen(node.id);
    return (
      <div key={node.id} role="treeitem" aria-expanded={node.children.length ? open : undefined}>
        <Entity id={node.id}>
          <a href={`/scheduler/${encodeURIComponent(node.id)}`} className="text-live hover:underline">
            {node.id}
          </a>
          <span>
            {" — "}
            <Datum
              field="queue.capacities.queueCapacitiesByPartition.usedCapacity"
              raw={partitionOf(node, partition).cap?.usedCapacity}
              fmt="pct"
            >
              {m.usedPct == null ? "no usage reported" : `${m.usedPct.toFixed(1)}% of its share used`}
            </Datum>
            {node.capacity ? (
              <>
                {", "}
                <Datum field="queue.derived.freeGuaranteedPct" raw={h.guaranteedFreePct} fmt="pct">
                  {h.guaranteedFreePct == null ? "freeness unknown" : `${h.guaranteedFreePct.toFixed(1)}% free inside its share`}
                </Datum>
              </>
            ) : (
              <>
                {", "}
                <Datum field="queue.derived.fairShareFreeMb" raw={h.fairShareFreeMb} fmt="mb">
                  {h.fairShareFreeMb == null ? "fair share unknown" : `${Math.round(h.fairShareFreeMb)} MB free of its fair share`}
                </Datum>
              </>
            )}
          </span>
        </Entity>
        {node.children.length > 0 && <div role="group">{node.children.map(render)}</div>}
      </div>
    );
  };
  return (
    <div role="tree" aria-label="Queue hierarchy" className="sr-only">
      {render(root)}
    </div>
  );
}
