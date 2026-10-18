/**
 * Queue-tree columns for the Capacity and Fair schedulers. The tree is rendered with the shared `DataTable`
 * (virtualized, column chooser, export, URL-synced visibility) — the hierarchy is expressed by indentation in the
 * name cell, and expansion is controlled by the page (`openQueues` search param).
 *
 * Capacity numbers are read from the selected node-label partition
 * (`capacities.queueCapacitiesByPartition[]` / `resources.resourceUsagesByPartition[]`), which is what the legacy page
 * shows one tree per. Every visible value carries `data-yf`/`data-yv` for its queue entity.
 */
import type { ReactNode } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { cn } from "~/lib/cn";
import { Datum, type DatumAttrs, datumAttrs } from "~/ui/datum";
import type { Fmt } from "~/lib/format";
import { StatusPill } from "~/ui/status";
import type { ColDef } from "~/ui/data-table/features";
import { fmtInt } from "~/lib/format";
import { AppsReadout, CapacityBar, FairBar, FreeReadout } from "./bars";
import { countText, orderingPolicyDisplayName, partitionText, pctText, pressureTone, resourceText } from "./format";
import { type Headroom, type QueueMetrics, type QueueNode, headroomOf, metricsOf, partitionOf, pressurePctOf } from "./model";
import type { PartitionCapacity, PartitionResourcesInfo } from "~/api/schemas";
import { OptionalTooltip } from "~/ui/tooltip";

export interface QueueRow {
  node: QueueNode;
  metrics: QueueMetrics;
  headroom: Headroom;
  /** the selected partition's capacity entry (capacity scheduler only) */
  cap?: PartitionCapacity;
  /** the selected partition's usage entry */
  res?: PartitionResourcesInfo;
}

export const toQueueRows = (nodes: QueueNode[], partition = ""): QueueRow[] =>
  nodes.map((node) => {
    const { cap, res } = partitionOf(node, partition);
    return { node, metrics: metricsOf(node, partition), headroom: headroomOf(node, partition), cap, res };
  });

const CAP = "queue.capacities.queueCapacitiesByPartition";
const RES = "queue.resources.resourceUsagesByPartition";

function NameCell({
  row,
  hasChildren,
  open,
  onToggle,
  kind,
}: {
  row: QueueRow;
  hasChildren: boolean;
  open: boolean;
  onToggle: () => void;
  kind: "capacity" | "fair";
}) {
  return (
    <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: row.node.depth * 14 }}>
      {hasChildren ? (
        <OptionalTooltip label={`${open ? "Collapse" : "Expand"} queue ${row.node.id}`}>
          <button
            type="button"
            aria-label={`${open ? "Collapse" : "Expand"} ${row.node.id}`}
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="burrow-touch-target grid size-4 shrink-0 place-items-center rounded-xs text-ink-3 hover:bg-fabric-3 hover:text-ink"
          >
            {/* one glyph that rotates: a swap between two mounts cannot be transitioned */}
            <ChevronRight
              className={cn("size-3 transition-transform duration-(--dur-fast) ease-(--ease-out)", open && "rotate-90")}
              aria-hidden="true"
            />
          </button>
        </OptionalTooltip>
      ) : (
        <span className="size-4 shrink-0" aria-hidden="true" />
      )}
      <Datum
        field={kind === "capacity" ? "queue.queuePath" : "queue.queueName"}
        raw={kind === "capacity" ? row.node.capacity?.queuePath : row.node.fair?.queueName}
        className="truncate font-medium"
      >
        {row.node.name}
      </Datum>
      {row.node.capacity?.isAutoCreatedLeafQueue && (
        <Datum
          field="queue.isAutoCreatedLeafQueue"
          raw={row.node.capacity.isAutoCreatedLeafQueue}
          title="auto-created leaf queue"
          className="shrink-0 text-wait"
        >
          <Sparkles className="size-3" aria-hidden="true" />
        </Datum>
      )}
      {row.node.role === "leaf" && row.metrics.maxAppsPerUser != null && row.metrics.maxAppsPerUser !== 2147483647 && (
        <OptionalTooltip label={"max applications per user"}>
          <span className="shrink-0 rounded-xs bg-fabric-3 px-1 text-micro text-ink-3 tnum">{fmtInt(row.metrics.maxAppsPerUser)}/user</span>
        </OptionalTooltip>
      )}
    </span>
  );
}

const hint = (text: string): ReactNode => <span className="block max-w-64">{text}</span>;

/** `Datum` props for a partition-level capacity leaf. */
function capDatum(field: string, raw: unknown, fmt?: Fmt) {
  return { field: `${CAP}.${field}`, raw, fmt };
}

function resDatum(field: string, raw: unknown, fmt?: Fmt) {
  return { field: `${RES}.${field}`, raw, fmt };
}

/** Pre-built parity attributes for elements that are not `Datum`s (the freeness bar encodes the value itself). */
const capAttrs = (field: string, raw: unknown, fmt?: Fmt): DatumAttrs => datumAttrs(`${CAP}.${field}`, raw, fmt);

export interface CapacityColumnOpts {
  isOpen: (path: string) => boolean;
  onToggle: (path: string) => void;
  /** A shared scale keeps usage bars comparable across every queue row. */
  scale: number;
}

export function capacityColumns({ isOpen, onToggle, scale }: CapacityColumnOpts): ColDef<QueueRow>[] {
  const cols: ColDef<QueueRow>[] = [
    {
      id: "queue",
      header: "Queue",
      meta: { label: "Queue", pinned: true },
      enableSorting: false,
      size: 250,
      cell: ({ row }) => (
        <NameCell
          row={row.original}
          kind="capacity"
          hasChildren={row.original.node.children.length > 0}
          open={isOpen(row.original.node.id)}
          onToggle={() => onToggle(row.original.node.id)}
        />
      ),
    },
    {
      id: "state",
      meta: { label: "State", hint: hint("queue.state — RUNNING | STOPPED | DRAINING") },
      enableSorting: false,
      size: 96,
      cell: ({ row }) =>
        row.original.node.capacity?.state == null ? (
          <span className="text-ink-4">—</span>
        ) : (
          <StatusPill domain="queue.state" state={row.original.node.capacity.state} field="queue.state" size="sm" />
        ),
    },
    {
      id: "freeness",
      meta: {
        label: "Usage / headroom",
        hint: hint(
          "Bar: absolute usage against the selected partition, with markers for the guaranteed share and max capacity. Headroom: unused portion of the guaranteed share.",
        ),
      },
      enableSorting: false,
      size: 200,
      cell: ({ row }) => {
        const m = row.original.metrics;
        const cap = row.original.cap;
        const used = m.absUsedPct ?? m.usedPct;
        return (
          <div className="flex w-full min-w-0 items-center gap-2">
            <CapacityBar
              usedPct={used}
              capPct={m.absCapPct ?? m.capPct}
              maxPct={m.absMaxPct ?? m.maxPct}
              tone={pressureTone(pressurePctOf(row.original.node, m))}
              label={row.original.node.id}
              datum={capAttrs("absoluteUsedCapacity", cap?.absoluteUsedCapacity ?? cap?.usedCapacity, "pct")}
              scale={scale}
            />
            <FreeReadout
              freePct={row.original.headroom.guaranteedFreePct}
              freeMb={null}
              field="queue.derived.freeGuaranteedPct"
              className="w-20 shrink-0 text-left text-small"
            />
          </div>
        );
      },
    },
    {
      id: "usedPct",
      meta: {
        label: "Used % of share",
        align: "end",
        hint: hint(`${CAP}.usedCapacity — used resources ÷ this queue's guaranteed capacity, for the selected partition`),
      },
      enableSorting: false,
      size: 124,
      cell: ({ row }) => (
        <Datum {...capDatum("usedCapacity", row.original.cap?.usedCapacity, "pct")} className="tnum">
          {pctText(row.original.metrics.usedPct)}
        </Datum>
      ),
    },
    {
      id: "capacity",
      meta: { label: "Capacity %", align: "end", hint: hint(`${CAP}.capacity — configured share of the parent queue`) },
      enableSorting: false,
      size: 104,
      cell: ({ row }) => (
        <Datum {...capDatum("capacity", row.original.cap?.capacity, "pct")} className="tnum">
          {pctText(row.original.metrics.capPct)}
        </Datum>
      ),
    },
    {
      id: "maxCapacity",
      meta: { label: "Max Capacity %", align: "end", hint: hint(`${CAP}.maxCapacity — the ceiling this queue may burst to`) },
      enableSorting: false,
      size: 124,
      cell: ({ row }) => (
        <Datum {...capDatum("maxCapacity", row.original.cap?.maxCapacity, "pct")} className="tnum">
          {pctText(row.original.metrics.maxPct)}
        </Datum>
      ),
    },
    {
      id: "absCapPct",
      meta: { label: "Absolute Capacity %", align: "end", hint: hint(`${CAP}.absoluteCapacity — guaranteed share of the cluster`) },
      enableSorting: false,
      size: 146,
      cell: ({ row }) => (
        <Datum {...capDatum("absoluteCapacity", row.original.cap?.absoluteCapacity, "pct")} className="tnum">
          {pctText(row.original.metrics.absCapPct)}
        </Datum>
      ),
    },
    {
      id: "absUsedPct",
      meta: { label: "Absolute Used %", align: "end", hint: hint(`${CAP}.absoluteUsedCapacity`) },
      enableSorting: false,
      size: 120,
      cell: ({ row }) => (
        <Datum {...capDatum("absoluteUsedCapacity", row.original.cap?.absoluteUsedCapacity, "pct")} className="tnum">
          {pctText(row.original.metrics.absUsedPct)}
        </Datum>
      ),
    },
    {
      id: "absMaxPct",
      meta: { label: "Absolute Max %", align: "end", hint: hint(`${CAP}.absoluteMaxCapacity`) },
      enableSorting: false,
      size: 120,
      cell: ({ row }) => (
        <Datum {...capDatum("absoluteMaxCapacity", row.original.cap?.absoluteMaxCapacity, "pct")} className="tnum">
          {pctText(row.original.metrics.absMaxPct)}
        </Datum>
      ),
    },
    {
      id: "freePct",
      meta: {
        label: "Free (of share)",
        align: "end",
        hint: hint(
          "Unused percentage of the queue's guaranteed share: 100 − usedCapacity, clamped to 0–100%. 100% means none of the share is in use.",
        ),
      },
      enableSorting: false,
      size: 122,
      cell: ({ row }) => (
        <FreeReadout freePct={row.original.headroom.guaranteedFreePct} freeMb={null} field="queue.derived.freeGuaranteedPct" />
      ),
    },
    {
      id: "burst",
      meta: {
        label: "Room to max",
        align: "end",
        hint: hint(
          "Unused percentage of maxCapacity, calculated from absoluteMaxCapacity and absoluteUsedCapacity. 0% means the queue is at or above its ceiling.",
        ),
      },
      enableSorting: false,
      size: 118,
      cell: ({ row }) => <FreeReadout freePct={row.original.headroom.burstRoomPct} freeMb={null} field="queue.derived.burstRoomPct" />,
    },
    {
      id: "headroomMb",
      meta: {
        label: "Headroom",
        align: "end",
        hint: hint("Derived: maxEffectiveCapacity.memory − used memory — MB available before the queue's max."),
      },
      enableSorting: false,
      size: 116,
      cell: ({ row }) => (
        <Datum field="queue.derived.headroomMb" raw={row.original.headroom.freeMb} fmt="mb" className="tnum">
          {countText(row.original.headroom.freeMb)}
        </Datum>
      ),
    },
    {
      id: "apps",
      meta: { label: "Applications", hint: hint("numActiveApplications / numPendingApplications") },
      enableSorting: false,
      size: 170,
      cell: ({ row }) => (
        <AppsReadout
          active={row.original.metrics.activeApps ?? row.original.metrics.apps}
          pending={row.original.metrics.pendingApps}
          fieldActive="queue.numActiveApplications"
          fieldPending="queue.numPendingApplications"
        />
      ),
    },
    {
      id: "containers",
      meta: { label: "Containers", hint: hint("allocatedContainers / reservedContainers / pendingContainers") },
      enableSorting: false,
      size: 156,
      cell: ({ row }) => {
        const m = row.original.metrics;
        const raw = row.original.node.capacity;
        return (
          <span className="flex items-baseline gap-1 text-small tnum">
            <Datum field="queue.allocatedContainers" raw={raw?.allocatedContainers} fmt="int" className="text-ink-2">
              {countText(m.containers)}
            </Datum>
            <span className="text-ink-4">alloc</span>
            <span className="text-ink-4">·</span>
            <Datum field="queue.reservedContainers" raw={raw?.reservedContainers} fmt="int">
              {countText(m.reservedContainers)}
            </Datum>
            <span className="text-ink-4">res</span>
            <span className="text-ink-4">·</span>
            <Datum field="queue.pendingContainers" raw={raw?.pendingContainers} fmt="int">
              {countText(m.pendingContainers)}
            </Datum>
            <span className="text-ink-4">pend</span>
          </span>
        );
      },
    },
    {
      id: "numContainers",
      meta: {
        label: "Num Containers",
        align: "end",
        hint: hint("numContainers (leaf) — containers the scheduler counts against the queue"),
      },
      enableSorting: false,
      size: 142,
      cell: ({ row }) => (
        <Datum field="queue.numContainers" raw={row.original.node.capacity?.numContainers} fmt="int" className="tnum">
          {countText(row.original.node.capacity?.numContainers ?? null)}
        </Datum>
      ),
    },
    {
      id: "memUsed",
      meta: { label: "Memory Used", align: "end", hint: hint(`${RES}.used.memory — the selected partition`) },
      enableSorting: false,
      size: 136,
      cell: ({ row }) => (
        <Datum {...resDatum("used.memory", row.original.res?.used?.memory, "mb")} className="tnum">
          {row.original.res?.used ? resourceText(row.original.res.used) : "—"}
        </Datum>
      ),
    },
    {
      id: "vcoresUsed",
      meta: { label: "VCores Used", align: "end", hint: hint(`${RES}.used.vCores`) },
      enableSorting: false,
      size: 112,
      cell: ({ row }) => (
        <Datum {...resDatum("used.vCores", row.original.res?.used?.vCores, "int")} className="tnum">
          {countText(row.original.metrics.usedVcores)}
        </Datum>
      ),
    },
    {
      id: "memReserved",
      meta: { label: "Memory Reserved", align: "end", hint: hint(`${RES}.reserved.memory`) },
      enableSorting: false,
      size: 140,
      cell: ({ row }) => (
        <Datum {...resDatum("reserved.memory", row.original.res?.reserved?.memory, "mb")} className="tnum">
          {countText(row.original.res?.reserved?.memory ?? null)}
        </Datum>
      ),
    },
    {
      id: "memPending",
      meta: { label: "Memory Pending", align: "end", hint: hint(`${RES}.pending.memory`) },
      enableSorting: false,
      size: 136,
      cell: ({ row }) => (
        <Datum {...resDatum("pending.memory", row.original.res?.pending?.memory, "mb")} className="tnum">
          {countText(row.original.res?.pending?.memory ?? null)}
        </Datum>
      ),
    },
    {
      id: "amLimit",
      meta: { label: "AM Limit", align: "end", hint: hint(`${RES}.amLimit.memory (queue-wide; leaves only)`) },
      enableSorting: false,
      size: 120,
      cell: ({ row }) => (
        <Datum {...resDatum("amLimit.memory", row.original.res?.amLimit?.memory, "mb")} className="tnum">
          {countText(row.original.res?.amLimit?.memory ?? null)}
        </Datum>
      ),
    },
    {
      id: "amUsed",
      meta: { label: "AM Used", align: "end", hint: hint(`${RES}.amUsed.memory`) },
      enableSorting: false,
      size: 112,
      cell: ({ row }) => (
        <Datum {...resDatum("amUsed.memory", row.original.res?.amUsed?.memory, "mb")} className="tnum">
          {countText(row.original.res?.amUsed?.memory ?? null)}
        </Datum>
      ),
    },
    {
      id: "userAmLimit",
      meta: { label: "User AM Limit", align: "end", hint: hint(`${RES}.userAmLimit.memory`) },
      enableSorting: false,
      size: 134,
      cell: ({ row }) => (
        <Datum {...resDatum("userAmLimit.memory", row.original.res?.userAmLimit?.memory, "mb")} className="tnum">
          {countText(row.original.res?.userAmLimit?.memory ?? null)}
        </Datum>
      ),
    },
    {
      id: "maxAmLimitPct",
      meta: { label: "Max AM Limit %", align: "end", hint: hint(`${CAP}.maxAMLimitPercentage — 0 on parent queues`) },
      enableSorting: false,
      size: 128,
      cell: ({ row }) => (
        <Datum {...capDatum("maxAMLimitPercentage", row.original.cap?.maxAMLimitPercentage, "pct")} className="tnum">
          {pctText(row.original.cap?.maxAMLimitPercentage ?? null)}
        </Datum>
      ),
    },
    {
      id: "effectiveMin",
      meta: { label: "Effective Min", align: "end", hint: hint(`${CAP}.effectiveMinResource.memory`) },
      enableSorting: false,
      size: 124,
      cell: ({ row }) => (
        <Datum {...capDatum("effectiveMinResource.memory", row.original.cap?.effectiveMinResource?.memory, "mb")} className="tnum">
          {countText(row.original.cap?.effectiveMinResource?.memory ?? null)}
        </Datum>
      ),
    },
    {
      id: "effectiveMax",
      meta: { label: "Effective Max", align: "end", hint: hint(`${CAP}.effectiveMaxResource.memory`) },
      enableSorting: false,
      size: 124,
      cell: ({ row }) => (
        <Datum {...capDatum("effectiveMaxResource.memory", row.original.cap?.effectiveMaxResource?.memory, "mb")} className="tnum">
          {countText(row.original.cap?.effectiveMaxResource?.memory ?? null)}
        </Datum>
      ),
    },
    {
      id: "maxApps",
      meta: { label: "Max Applications", align: "end", hint: hint("maxApplications (leaf) — 2147483647 = unlimited") },
      enableSorting: false,
      size: 144,
      cell: ({ row }) => (
        <Datum field="queue.maxApplications" raw={row.original.node.capacity?.maxApplications} fmt="int" className="tnum">
          {countText(row.original.metrics.maxApps)}
        </Datum>
      ),
    },
    {
      id: "maxAppsPerUser",
      meta: { label: "Max Apps / User", align: "end", hint: hint("maxApplicationsPerUser (leaf)") },
      enableSorting: false,
      size: 132,
      cell: ({ row }) => (
        <Datum field="queue.maxApplicationsPerUser" raw={row.original.node.capacity?.maxApplicationsPerUser} fmt="int" className="tnum">
          {countText(row.original.metrics.maxAppsPerUser)}
        </Datum>
      ),
    },
    {
      id: "userLimit",
      meta: { label: "User Limit %", align: "end", hint: hint("userLimit — per-user share of the queue") },
      enableSorting: false,
      size: 120,
      cell: ({ row }) => (
        <Datum field="queue.userLimit" raw={row.original.node.capacity?.userLimit} fmt="pct" className="tnum">
          {pctText(row.original.metrics.userLimit)}
        </Datum>
      ),
    },
    {
      id: "userLimitFactor",
      meta: {
        label: "User Limit Factor",
        align: "end",
        hint: hint("userLimitFactor — multiplier on the user limit when the queue is free"),
      },
      enableSorting: false,
      size: 142,
      cell: ({ row }) => (
        <Datum field="queue.userLimitFactor" raw={row.original.node.capacity?.userLimitFactor} className="tnum">
          {row.original.metrics.userLimitFactor == null ? "—" : String(row.original.metrics.userLimitFactor)}
        </Datum>
      ),
    },
    {
      id: "policy",
      meta: {
        label: "Ordering Policy",
        hint: hint(
          "orderingPolicyInfo — the policy's config name. Leaf queues also show the policy's display name (FifoOrderingPolicy, FairOrderingPolicy…), which the RM web UI prints.",
        ),
      },
      enableSorting: false,
      size: 190,
      cell: ({ row }) => {
        const configName = row.original.node.capacity?.orderingPolicyInfo;
        const display = row.original.node.role === "leaf" ? orderingPolicyDisplayName(configName) : null;
        return (
          <span className="flex min-w-0 items-baseline gap-1.5">
            {display != null && (
              <Datum field="queue.derived.orderingPolicyDisplayName" raw={display} className="truncate">
                {display}
              </Datum>
            )}
            <Datum field="queue.orderingPolicyInfo" raw={configName} className={display != null ? "text-micro text-ink-4" : "truncate"}>
              {configName ?? "—"}
            </Datum>
          </span>
        );
      },
    },
    {
      id: "preemption",
      meta: { label: "Preemption", hint: hint("preemptionDisabled / intraQueuePreemptionDisabled") },
      enableSorting: false,
      size: 138,
      cell: ({ row }) => {
        const raw = row.original.node.capacity?.preemptionDisabled;
        const intra = row.original.node.capacity?.intraQueuePreemptionDisabled;
        return (
          <span className="flex items-baseline gap-1 text-small">
            <Datum field="queue.preemptionDisabled" raw={raw} className="tnum">
              {raw == null ? "—" : raw ? "off" : "on"}
            </Datum>
            <span className="text-ink-4">/</span>
            <Datum field="queue.intraQueuePreemptionDisabled" raw={intra} className="tnum">
              {intra == null ? "—" : intra ? "off" : "on"}
            </Datum>
            <span className="text-micro text-ink-4">intra</span>
          </span>
        );
      },
    },
    {
      id: "labels",
      meta: { label: "Node Labels", hint: hint("nodeLabels the queue can use") },
      enableSorting: false,
      size: 136,
      cell: ({ row }) => {
        const labels = row.original.node.capacity?.nodeLabels ?? [];
        return (
          <span className="truncate text-small">
            {labels.length ? (
              labels.map((l, i) => (
                <Datum key={l} field="queue.nodeLabels" raw={l} className="mr-1 font-mono text-caption">
                  {l}
                  {i < labels.length - 1 ? "," : ""}
                </Datum>
              ))
            ) : (
              <span className="text-ink-4">—</span>
            )}
          </span>
        );
      },
    },
    {
      id: "labelExpr",
      meta: { label: "Default Label Expression", hint: hint("defaultNodeLabelExpression") },
      enableSorting: false,
      size: 180,
      cell: ({ row }) => (
        <Datum
          field="queue.defaultNodeLabelExpression"
          raw={row.original.node.capacity?.defaultNodeLabelExpression}
          className="truncate font-mono text-caption"
        >
          {partitionText(row.original.node.capacity?.defaultNodeLabelExpression)}
        </Datum>
      ),
    },
    {
      id: "defaultPriority",
      meta: {
        label: "Default App Priority",
        align: "end",
        hint: hint("defaultPriority (leaf) — priority given to applications submitted without one"),
      },
      enableSorting: false,
      size: 152,
      cell: ({ row }) => (
        <Datum field="queue.defaultPriority" raw={row.original.node.capacity?.defaultPriority} fmt="int" className="tnum">
          {countText(row.original.node.capacity?.defaultPriority ?? null)}
        </Datum>
      ),
    },
    {
      id: "weight",
      meta: { label: "Weight", align: "end", hint: hint("weight / normalizedWeight (-1 = capacity mode)") },
      enableSorting: false,
      size: 112,
      cell: ({ row }) => (
        <span className="flex items-baseline gap-1 text-small tnum">
          <Datum field="queue.weight" raw={row.original.node.capacity?.weight}>
            {row.original.node.capacity?.weight == null ? "—" : String(row.original.node.capacity.weight)}
          </Datum>
          <span className="text-ink-4">/</span>
          <Datum field="queue.normalizedWeight" raw={row.original.node.capacity?.normalizedWeight}>
            {row.original.node.capacity?.normalizedWeight == null ? "—" : String(row.original.node.capacity.normalizedWeight)}
          </Datum>
        </span>
      ),
    },
    {
      id: "maxParallelApps",
      meta: { label: "Max Parallel Apps", align: "end", hint: hint("maxParallelApps") },
      enableSorting: false,
      size: 146,
      cell: ({ row }) => (
        <Datum field="queue.maxParallelApps" raw={row.original.node.capacity?.maxParallelApps} fmt="int" className="tnum">
          {countText(row.original.node.capacity?.maxParallelApps ?? null)}
        </Datum>
      ),
    },
    {
      id: "queueType",
      meta: { label: "Queue Type", hint: hint("queueType / creationMethod / autoCreationEligibility") },
      enableSorting: false,
      size: 156,
      cell: ({ row }) => {
        const raw = row.original.node.capacity;
        return (
          <span className="flex items-baseline gap-1 text-small">
            <Datum field="queue.queueType" raw={raw?.queueType}>
              {raw?.queueType ?? "—"}
            </Datum>
            <span className="text-ink-4">/</span>
            <Datum field="queue.creationMethod" raw={raw?.creationMethod} className="text-caption">
              {raw?.creationMethod ?? "—"}
            </Datum>
            <span className="text-ink-4">/</span>
            <Datum field="queue.autoCreationEligibility" raw={raw?.autoCreationEligibility} className="text-caption">
              {raw?.autoCreationEligibility ?? "—"}
            </Datum>
          </span>
        );
      },
    },
    {
      id: "autoCreated",
      meta: { label: "Auto-created", hint: hint("isAutoCreatedLeafQueue — the queue was created by auto queue creation, not configured") },
      enableSorting: false,
      size: 118,
      cell: ({ row }) => {
        // CapacitySchedulerPage: `info.isLeafQueue() ? leaf.isAutoCreatedLeafQueue() : false` — a parent queue (no such key in the REST) is "no"
        const { node } = row.original;
        const raw = node.role === "leaf" ? node.capacity?.isAutoCreatedLeafQueue : false;
        return (
          <Datum field="queue.isAutoCreatedLeafQueue" raw={raw} className="text-small">
            {raw == null ? "—" : raw ? "yes" : "no"}
          </Datum>
        );
      },
    },
    {
      id: "mode",
      meta: { label: "Mode", hint: hint("mode — percentage | absolute | weight") },
      enableSorting: false,
      size: 100,
      cell: ({ row }) => (
        <Datum field="queue.mode" raw={row.original.node.capacity?.mode}>
          {row.original.node.capacity?.mode ?? "—"}
        </Datum>
      ),
    },
  ];
  return cols;
}

export function fairColumns({ isOpen, onToggle, scale }: CapacityColumnOpts): ColDef<QueueRow>[] {
  return [
    {
      id: "queue",
      header: "Queue",
      meta: { label: "Queue", pinned: true },
      enableSorting: false,
      size: 250,
      cell: ({ row }) => (
        <NameCell
          row={row.original}
          kind="fair"
          hasChildren={row.original.node.children.length > 0}
          open={isOpen(row.original.node.id)}
          onToggle={() => onToggle(row.original.node.id)}
        />
      ),
    },
    {
      id: "policy",
      meta: { label: "Scheduling Policy", hint: hint("schedulingPolicy — fair | fifo | drf") },
      enableSorting: false,
      size: 144,
      cell: ({ row }) => (
        <Datum field="queue.schedulingPolicy" raw={row.original.node.fair?.schedulingPolicy}>
          {row.original.metrics.policy ?? "—"}
        </Datum>
      ),
    },
    {
      id: "freeness",
      meta: {
        label: "Usage / headroom",
        hint: hint("Bar: used memory against the minimum, fair share and max. Headroom: memory remaining to the fair share."),
      },
      enableSorting: false,
      size: 230,
      cell: ({ row }) => {
        const m = row.original.metrics;
        const fair = row.original.node.fair;
        return (
          <div className="flex w-full min-w-0 items-center gap-2">
            <FairBar
              usedMb={m.usedMb}
              minMb={m.minMb}
              fairMb={m.fairMb}
              maxMb={m.maxMb}
              tone={pressureTone(pressurePctOf(row.original.node, m))}
              label={row.original.node.id}
              datum={{
                "data-yf": "queue.usedResources.memory",
                "data-yv": fair?.usedResources?.memory == null ? "" : String(fair.usedResources.memory),
                "data-yfmt": "mb",
                ...(fair?.usedResources?.memory == null ? { "data-yn": "1" as const } : {}),
              }}
              scale={scale}
            />
            <FreeReadout
              freePct={null}
              freeMb={row.original.headroom.fairShareFreeMb}
              field="queue.derived.fairShareFreeMb"
              className="w-24 shrink-0 text-left text-small"
            />
          </div>
        );
      },
    },
    {
      id: "usedMb",
      meta: { label: "Used", align: "end", hint: hint("usedResources.memory") },
      enableSorting: false,
      size: 124,
      cell: ({ row }) => (
        <Datum field="queue.usedResources.memory" raw={row.original.node.fair?.usedResources?.memory} fmt="mb" className="tnum">
          {row.original.metrics.usedMb == null ? "—" : resourceText(row.original.node.fair?.usedResources)}
        </Datum>
      ),
    },
    {
      id: "fairMb",
      meta: { label: "Fair Share", align: "end", hint: hint("fairResources.memory — the instantaneous fair share") },
      enableSorting: false,
      size: 124,
      cell: ({ row }) => (
        <Datum field="queue.fairResources.memory" raw={row.original.node.fair?.fairResources?.memory} fmt="mb" className="tnum">
          {countText(row.original.metrics.fairMb)}
        </Datum>
      ),
    },
    {
      id: "steadyFairMb",
      meta: { label: "Steady Fair Share", align: "end", hint: hint("steadyFairResources.memory") },
      enableSorting: false,
      size: 152,
      cell: ({ row }) => (
        <Datum field="queue.steadyFairResources.memory" raw={row.original.node.fair?.steadyFairResources?.memory} fmt="mb" className="tnum">
          {countText(row.original.metrics.steadyFairMb)}
        </Datum>
      ),
    },
    {
      id: "minMb",
      meta: { label: "Minimum", align: "end", hint: hint("minResources.memory") },
      enableSorting: false,
      size: 116,
      cell: ({ row }) => (
        <Datum field="queue.minResources.memory" raw={row.original.node.fair?.minResources?.memory} fmt="mb" className="tnum">
          {countText(row.original.metrics.minMb)}
        </Datum>
      ),
    },
    {
      id: "maxMb",
      meta: { label: "Maximum", align: "end", hint: hint("maxResources.memory") },
      enableSorting: false,
      size: 120,
      cell: ({ row }) => (
        <Datum field="queue.maxResources.memory" raw={row.original.node.fair?.maxResources?.memory} fmt="mb" className="tnum">
          {countText(row.original.metrics.maxMb)}
        </Datum>
      ),
    },
    {
      id: "headroomMb",
      meta: { label: "Headroom", align: "end", hint: hint("Derived: maxResources.memory − usedResources.memory") },
      enableSorting: false,
      size: 120,
      cell: ({ row }) => (
        <Datum field="queue.derived.headroomMb" raw={row.original.headroom.freeMb} fmt="mb" className="tnum">
          {countText(row.original.headroom.freeMb)}
        </Datum>
      ),
    },
    {
      id: "demandMb",
      meta: { label: "Demand", align: "end", hint: hint("demandResources.memory — what the queue is asking for") },
      enableSorting: false,
      size: 120,
      cell: ({ row }) => (
        <Datum field="queue.demandResources.memory" raw={row.original.node.fair?.demandResources?.memory} fmt="mb" className="tnum">
          {countText(row.original.metrics.demandMb)}
        </Datum>
      ),
    },
    {
      id: "clusterMb",
      meta: { label: "Cluster", align: "end", hint: hint("clusterResources.memory") },
      enableSorting: false,
      size: 120,
      cell: ({ row }) => (
        <Datum field="queue.clusterResources.memory" raw={row.original.node.fair?.clusterResources?.memory} fmt="mb" className="tnum">
          {countText(row.original.metrics.clusterMb)}
        </Datum>
      ),
    },
    {
      id: "usedOfFair",
      meta: { label: "Used of Fair", align: "end", hint: hint("Derived: usedResources ÷ fairResources") },
      enableSorting: false,
      size: 126,
      cell: ({ row }) => {
        const m = row.original.metrics;
        const p = m.fairMb && m.usedMb != null ? (m.usedMb / m.fairMb) * 100 : null;
        return (
          <Datum field="queue.derived.usedOfFairPct" raw={p} fmt="pct" className="tnum">
            {pctText(p)}
          </Datum>
        );
      },
    },
    {
      id: "usedOfMin",
      meta: { label: "Used of Min", align: "end", hint: hint("Derived: usedResources ÷ minResources") },
      enableSorting: false,
      size: 124,
      cell: ({ row }) => {
        const m = row.original.metrics;
        const p = m.minMb && m.usedMb != null ? (m.usedMb / m.minMb) * 100 : null;
        return (
          <Datum field="queue.derived.usedOfMinPct" raw={p} fmt="pct" className="tnum">
            {pctText(p)}
          </Datum>
        );
      },
    },
    {
      id: "containers",
      meta: { label: "Containers", hint: hint("allocatedContainers / reservedContainers / pendingContainers") },
      enableSorting: false,
      size: 166,
      cell: ({ row }) => {
        const m = row.original.metrics;
        const fair = row.original.node.fair;
        return (
          <span className="flex items-baseline gap-1 text-small tnum">
            <Datum field="queue.allocatedContainers" raw={fair?.allocatedContainers} fmt="int" className="text-ink-2">
              {countText(m.containers)}
            </Datum>
            <span className="text-ink-4">alloc</span>
            <span className="text-ink-4">·</span>
            <Datum field="queue.reservedContainers" raw={fair?.reservedContainers} fmt="int">
              {countText(m.reservedContainers)}
            </Datum>
            <span className="text-ink-4">res</span>
            <span className="text-ink-4">·</span>
            <Datum field="queue.pendingContainers" raw={fair?.pendingContainers} fmt="int">
              {countText(m.pendingContainers)}
            </Datum>
            <span className="text-ink-4">pend</span>
          </span>
        );
      },
    },
    {
      id: "apps",
      meta: { label: "Applications", hint: hint("numActiveApps / numPendingApps (leaf queues)") },
      enableSorting: false,
      size: 174,
      cell: ({ row }) => (
        <AppsReadout
          active={row.original.metrics.activeApps}
          pending={row.original.metrics.pendingApps}
          fieldActive="queue.numActiveApps"
          fieldPending="queue.numPendingApps"
        />
      ),
    },
    {
      id: "maxApps",
      meta: { label: "Max Apps", align: "end", hint: hint("maxApps — 2147483647 = unlimited") },
      enableSorting: false,
      size: 116,
      cell: ({ row }) => (
        <Datum field="queue.maxApps" raw={row.original.node.fair?.maxApps} fmt="int" className="tnum">
          {countText(row.original.metrics.maxApps)}
        </Datum>
      ),
    },
    {
      id: "amUsed",
      meta: { label: "AM Used", align: "end", hint: hint("amUsedResources.memory") },
      enableSorting: false,
      size: 116,
      cell: ({ row }) => (
        <Datum field="queue.amUsedResources.memory" raw={row.original.node.fair?.amUsedResources?.memory} fmt="mb" className="tnum">
          {countText(row.original.metrics.amUsedMb)}
        </Datum>
      ),
    },
    {
      id: "amMax",
      meta: { label: "AM Max", align: "end", hint: hint("amMaxResources.memory") },
      enableSorting: false,
      size: 116,
      cell: ({ row }) => (
        <Datum field="queue.amMaxResources.memory" raw={row.original.node.fair?.amMaxResources?.memory} fmt="mb" className="tnum">
          {countText(row.original.metrics.amLimitMb)}
        </Datum>
      ),
    },
    {
      id: "reserved",
      meta: { label: "Reserved", align: "end", hint: hint("reservedResources.memory") },
      enableSorting: false,
      size: 120,
      cell: ({ row }) => (
        <Datum field="queue.reservedResources.memory" raw={row.original.node.fair?.reservedResources?.memory} fmt="mb" className="tnum">
          {countText(row.original.metrics.reservedMb)}
        </Datum>
      ),
    },
    {
      id: "maxContainerAllocation",
      meta: { label: "Max Container", align: "end", hint: hint("maxContainerAllocation.memory") },
      enableSorting: false,
      size: 134,
      cell: ({ row }) => (
        <Datum
          field="queue.maxContainerAllocation.memory"
          raw={row.original.node.fair?.maxContainerAllocation?.memory}
          fmt="mb"
          className="tnum"
        >
          {countText(row.original.node.fair?.maxContainerAllocation?.memory ?? null)}
        </Datum>
      ),
    },
    {
      id: "preemptable",
      meta: { label: "Preemptable", hint: hint("preemptable") },
      enableSorting: false,
      size: 116,
      cell: ({ row }) => (
        <Datum field="queue.preemptable" raw={row.original.node.fair?.preemptable}>
          {row.original.node.fair?.preemptable == null ? "—" : String(row.original.node.fair.preemptable)}
        </Datum>
      ),
    },
  ];
}
