/** Node state totals and the live NodeManager inventory shown on Overview. */
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { useState } from "react";
import { ov } from "~/api/queries/overview";
import { type ClusterMetrics, type Node, selectNodes } from "~/api/schemas";
import { fmtEpoch, fmtMB, fmtPct } from "~/lib/format";
import { statusSpec } from "~/design/status";
import { utilizationTone } from "~/lib/progress-tone";
import { usePref } from "~/state/prefs";
import { DataTable, defaultVisibilityOf } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum, datumAttrs, Entity, SINGLETON } from "~/ui/datum";
import { EmptyState, ErrorState, StaleErrorBanner } from "~/ui/feedback";
import { ProgressBar } from "~/ui/progress-bar";
import { StatusPill } from "~/ui/status";
import { healthOf } from "~/features/nodes/domain";
import { MetricCard } from "./metric-card";
import { NODE_STATE_METRICS } from "./derive";
import { Unavailable, useStale } from "./ui";
import { nodeRowVersion } from "~/features/nodes/columns";
import { Tooltip } from "~/ui/tooltip";

const nodesHref = (state: string) => `/nodes?states=${state}`;

function NodeHealthCell({ node }: { node: Node }) {
  const tz = usePref("tz");
  const health = healthOf(node);
  const timeZoneLabel = tz === "utc" ? "UTC" : "local time";
  return (
    <StatusPill
      domain="node.health"
      state={health}
      field="node.state"
      raw={node.state}
      size="sm"
      tooltipLabel={`${statusSpec("node.health", health).hint}. Last health update ${fmtEpoch(node.lastHealthUpdate, tz)} (${timeZoneLabel}).`}
    />
  );
}

const NODE_COLUMNS: ColDef<Node>[] = [
  {
    id: "name",
    accessorFn: (node) => node.nodeHostName,
    size: 184,
    meta: { label: "Name", pinned: true, hint: "Registered NodeManager host. Open it to inspect resources, applications and containers." },
    cell: ({ row }) => (
      <Datum field="node.nodeHostName" raw={row.original.nodeHostName} fmt="text" className="min-w-0 truncate font-mono text-small">
        <Tooltip label={`Open node ${row.original.nodeHostName}`}>
          <Link
            to="/nodes/$nodeId"
            params={{ nodeId: row.original.id }}
            className="truncate underline-offset-2 hover:text-live hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {row.original.nodeHostName}
          </Link>
        </Tooltip>
      </Datum>
    ),
  },
  {
    id: "labels",
    accessorFn: (node) => [node.rack, ...(node.nodeLabels ?? [])].join(", "),
    size: 106,
    meta: {
      label: "Labels",
      hint: "Rack followed by node labels. Labels partition the resources available to queues.",
      exportValue: (node: Node) => [node.rack, ...(node.nodeLabels ?? [])].join(", "),
    },
    cell: ({ row }) => {
      const labels = row.original.nodeLabels ?? [];
      const text = [row.original.rack, ...labels].filter(Boolean).join(" · ");
      return (
        <Tooltip label={text || "No labels"}>
          <Datum
            field="node.nodeLabels"
            raw={row.original.nodeLabels ?? null}
            fmt="text"
            className="block min-w-0 truncate text-small text-ink-2"
          >
            {text || <span className="text-ink-4">—</span>}
          </Datum>
        </Tooltip>
      );
    },
  },
  {
    id: "containers",
    accessorFn: (node) => node.numContainers,
    size: 108,
    meta: { label: "Containers", align: "end", hint: "Containers currently allocated on this node." },
    cell: ({ row }) => <Datum field="node.numContainers" raw={row.original.numContainers} fmt="int" className="tnum" />,
  },
  {
    id: "memory",
    accessorFn: (node) => node.usedMemoryMB,
    size: 118,
    meta: {
      label: "Memory",
      hint: "YARN memory allocated to containers and remaining capacity; this differs from physical process memory.",
      exportValue: (node: Node) => node.usedMemoryMB,
    },
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-small">
        <Datum field="node.usedMemoryMB" raw={row.original.usedMemoryMB} fmt="mb" className="tnum">
          {fmtMB(row.original.usedMemoryMB)}
        </Datum>
        <span className="text-ink-4"> used · </span>
        <Datum field="node.availMemoryMB" raw={row.original.availMemoryMB} fmt="mb" className="tnum">
          {fmtMB(row.original.availMemoryMB)}
        </Datum>
        <span className="text-ink-3"> free</span>
      </span>
    ),
  },
  {
    id: "health",
    accessorFn: (node) => healthOf(node),
    size: 104,
    meta: {
      label: "Health",
      hint: "Health derived from the ResourceManager's node state, with the time of the last health report. A report containing text can still be healthy.",
    },
    cell: ({ row }) => <NodeHealthCell node={row.original} />,
  },
  {
    id: "vcores",
    accessorFn: (node) => node.usedVirtualCores,
    size: 108,
    meta: {
      label: "vCores",
      hint: "Virtual cores allocated to YARN containers and remaining capacity.",
      exportValue: (node: Node) => node.usedVirtualCores,
    },
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-small tnum">
        <Datum field="node.usedVirtualCores" raw={row.original.usedVirtualCores} fmt="int" />
        <span className="text-ink-4"> used · </span>
        <Datum field="node.availableVirtualCores" raw={row.original.availableVirtualCores} fmt="int" />
        <span className="text-ink-3"> free</span>
      </span>
    ),
  },
  {
    id: "state",
    accessorFn: (node) => node.state,
    size: 90,
    meta: { label: "State", hint: "Registration and lifecycle state reported by the ResourceManager." },
    cell: ({ row }) => <StatusPill domain="node.state" state={row.original.state} field="node.state" size="sm" />,
  },
  {
    id: "physicalMemory",
    accessorFn: (node) => node.memUtilization,
    size: 124,
    meta: {
      label: "Physical memory",
      wrapHeader: true,
      hint: "Physical memory utilization reported by the NodeManager, as a percentage. Missing measurements are shown as a dash.",
      exportValue: (node: Node) => node.memUtilization,
    },
    cell: ({ row }) => {
      const percent = row.original.memUtilization;
      return (
        <div className="flex min-w-0 items-center gap-1.5">
          <ProgressBar
            percent={percent ?? 0}
            tone={utilizationTone(percent)}
            label={`Physical memory utilization on ${row.original.nodeHostName}`}
            datum={datumAttrs("node.memUtilization", percent, "pct")}
            className="w-12 shrink-0 sm:w-14"
          />
          <Datum field="node.memUtilization" raw={percent} fmt="pct" className="burrow-progress-value text-micro text-ink-2 tnum">
            {percent == null ? "—" : fmtPct(percent)}
          </Datum>
        </div>
      );
    },
  },
];

export function NodeStatesSection({
  metrics,
  collapseInventory = false,
}: {
  metrics: ClusterMetrics | undefined;
  collapseInventory?: boolean;
}) {
  const nodes = useQuery(ov.nodes());
  const navigate = useNavigate();
  const stale = useStale();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>(() => defaultVisibilityOf(NODE_COLUMNS));

  const list: Node[] = nodes.data ? selectNodes(nodes.data) : [];
  const table = (
    <div data-testid="registered-nodes-table" aria-live="polite">
      <DataTable
        data={list}
        columns={NODE_COLUMNS}
        getRowId={(node) => node.id}
        entityKey={(node) => node.id}
        label="Registered nodes"
        storageKey="burrow.overview.nodes"
        sorting={sorting}
        onSortingChange={setSorting}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={setColumnVisibility}
        defaultVisibility={defaultVisibilityOf(NODE_COLUMNS)}
        rowVersion={nodeRowVersion}
        onRowActivate={(node) => void navigate({ to: "/nodes/$nodeId", params: { nodeId: node.id } })}
        toolbar={
          collapseInventory ? undefined : (
            <>
              <div className="flex items-baseline gap-2">
                <h3 className="text-small font-medium text-ink-2">Registered nodes</h3>
                {nodes.isSuccess && <span className="text-micro text-ink-4">{list.length} total</span>}
              </div>
              {stale && nodes.isSuccess && <Unavailable variant="info" reason="stale cache" />}
            </>
          )
        }
        toolbarArrangement="inline"
        loading={nodes.isPending}
        error={
          nodes.isError && nodes.data === undefined ? (
            <ErrorState
              title="The node list is unavailable"
              message={nodes.error instanceof Error ? nodes.error.message : String(nodes.error)}
              hint={metrics ? "Node state counts above remain available." : undefined}
              onRetry={() => void nodes.refetch()}
              compact
            />
          ) : undefined
        }
        empty={
          <EmptyState title="No nodes registered">
            The ResourceManager reports zero NodeManagers. Nothing can be scheduled until one registers.
          </EmptyState>
        }
        exportName="overview-nodes"
        className="min-h-[13rem] w-full flex-none"
      />
    </div>
  );

  return (
    <div className="burrow-overview-metrics-container flex flex-col gap-[var(--gap-card)]" data-testid="node-states">
      {metrics ? (
        <Entity
          id={SINGLETON}
          className={
            collapseInventory
              ? "burrow-overview-row-grid burrow-overview-row-grid--node-states rounded-lg border border-seam bg-fabric px-[var(--gap-card)]"
              : "burrow-overview-row-grid burrow-overview-row-grid--node-states"
          }
        >
          {NODE_STATE_METRICS.map(({ key, label, state }) => (
            <MetricCard
              key={key}
              label={label}
              field={`cluster.metrics.${key}`}
              raw={metrics[key]}
              fmt="int"
              layout="row"
              href={nodesHref(state)}
              hrefHint={`Nodes in state ${state}`}
              testId={`node-count-${state.toLowerCase()}`}
            />
          ))}
        </Entity>
      ) : (
        <Unavailable reason="Node state counts are unavailable." />
      )}

      {nodes.isError && nodes.data !== undefined && (
        <StaleErrorBanner
          title={
            list.length > 0
              ? "Node list refresh failed; showing the last loaded rows"
              : "Node list refresh failed; showing the last loaded result"
          }
          error={nodes.error}
          onRetry={() => void nodes.refetch()}
        />
      )}

      {collapseInventory ? (
        <details className="burrow-overview-disclosure overflow-hidden rounded-md border border-seam-soft bg-well">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-small font-medium text-ink-2 focus-visible:outline-2">
            <span>Registered nodes</span>
            <span className="flex items-center gap-2 text-micro font-normal text-ink-4">
              {nodes.isPending ? "loading" : `${list.length} total`}
              {stale && nodes.isSuccess && <span className="text-wait">stale cache</span>}
              <span>expand list</span>
              <span aria-hidden="true" className="burrow-overview-disclosure-indicator" />
            </span>
          </summary>
          <div className="border-t border-seam-soft px-3 pb-3">{table}</div>
        </details>
      ) : (
        table
      )}
    </div>
  );
}
