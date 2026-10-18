/**
 * The node table's columns: exactly the 16 columns of the legacy `/cluster/nodes` page (`NodesPage.java`, Hadoop 3.4.3),
 * in the legacy order, with the legacy semantics (see `domain.ts` for the mapping of each column onto the REST field).
 * Every cell that shows a YARN datum goes through `<Datum>` so `?parity=1` exposes it.
 */
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import type { Node } from "~/api/schemas";
import { cn } from "~/lib/cn";
import { fmtClock, fmtEpoch, fmtInt, fmtRelative } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { Datum } from "~/ui/datum";
import type { ColDef } from "~/ui/data-table/features";
import { StatusDot, StatusPill } from "~/ui/status";
import { Tooltip } from "~/ui/tooltip";
import { allocationTagSummary, customResourceNames, customResourceValue, healthOf, utilBand, UTIL_BAND_TONE, utilOf } from "./domain";

const LABEL_CHIP =
  "inline-flex h-[18px] max-w-full items-center truncate rounded-full border border-seam-strong bg-well px-1.5 text-micro text-ink-2";

function HealthUpdateCell({ node }: { node: Node }) {
  const tz = usePref("tz");
  const updatedAt = fmtEpoch(node.lastHealthUpdate, tz);
  const timeZoneLabel = tz === "utc" ? "UTC" : "local time";
  const relative = node.lastHealthUpdate > 0 ? fmtRelative(node.lastHealthUpdate, Date.now()) : "not reported";
  return (
    <Tooltip label={`Last health update ${updatedAt} (${timeZoneLabel}; ${relative}).`}>
      <Datum
        field="node.lastHealthUpdate"
        raw={node.lastHealthUpdate}
        fmt="epoch"
        className="whitespace-nowrap font-mono text-small text-ink-2 tnum"
      >
        {fmtClock(node.lastHealthUpdate, tz)}
      </Datum>
    </Tooltip>
  );
}

function LabelsCell({ node }: { node: Node }) {
  const labels = node.nodeLabels ?? [];
  return (
    <Datum
      field="node.nodeLabels"
      raw={labels.length ? labels : undefined}
      fmt="text"
      className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden"
    >
      {labels.length === 0 ? (
        <span className="text-ink-4">—</span>
      ) : (
        labels.map((l) => (
          <Tooltip key={l} label={l}>
            <span className={LABEL_CHIP}>{l}</span>
          </Tooltip>
        ))
      )}
    </Datum>
  );
}

function Bar({ pct }: { pct: number }) {
  const fill = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <span aria-hidden="true" className="absolute bottom-0.5 left-0 right-1 h-0.5 rounded-full bg-seam">
      <span
        className="burrow-bar block h-full w-full rounded-full"
        style={{ "--fill": fill, background: UTIL_BAND_TONE[utilBand(pct)] } as React.CSSProperties}
      />
    </span>
  );
}

/**
 * The legacy table appends a `"{type} Used"`/`"{type} Avail"` column pair for every configured resource type other
 * than memory-mb/vcores (NodesPage.java:239-249) and emits *no* such column when none is configured. To keep the
 * inventory's required `node.derived.customResource{Used,Avail}` fields from being silently dropped on a cluster
 * with no custom resource type, each row carries them as an explicitly absent marker (`data-yn="1"`), mirroring the
 * `UnavailableField` contract elsewhere. It sits next to the last resource column, where the real columns would go.
 */
function CustomResourceAbsence() {
  return (
    <span className="sr-only" data-burrow="custom-resources-not-configured">
      <Datum field="node.derived.customResourceUsed" raw={null} fmt="int" />
      <Datum field="node.derived.customResourceAvail" raw={null} fmt="int" />
    </span>
  );
}

/**
 * One column pair per custom resource type, in the RM's order, inserted where `NodesPage.java:239-249` appends them
 * (after "Phys VCores Used %", before "Version"). The header embeds the raw resource-type name, and the cell prints
 * `String.valueOf(long)` exactly as legacy does.
 */
function customResourceColumns(names: readonly string[]): ColDef<Node>[] {
  return names.flatMap((name): ColDef<Node>[] => [
    {
      id: `custom-${name}-used`,
      accessorFn: (n) => customResourceValue(n, name, "used"),
      size: 110,
      meta: { label: `${name} Used`, align: "end", hint: `Amount of ${name} allocated to containers on this node.` },
      cell: ({ row }) => (
        <Datum
          field="node.derived.customResourceUsed"
          raw={customResourceValue(row.original, name, "used")}
          fmt="int"
          className="block text-end tnum"
        >
          {String(customResourceValue(row.original, name, "used"))}
        </Datum>
      ),
    },
    {
      id: `custom-${name}-avail`,
      accessorFn: (n) => customResourceValue(n, name, "avail"),
      size: 110,
      meta: { label: `${name} Avail`, align: "end", hint: `Amount of ${name} remaining for container allocation.` },
      cell: ({ row }) => (
        <Datum
          field="node.derived.customResourceAvail"
          raw={customResourceValue(row.original, name, "avail")}
          fmt="int"
          className="block text-end tnum"
        >
          {String(customResourceValue(row.original, name, "avail"))}
        </Datum>
      ),
    },
  ]);
}

export function nodeColumns(customTypes: readonly string[] = []): ColDef<Node>[] {
  const hasCustom = customTypes.length > 0;
  return [
    {
      id: "nodeLabels",
      accessorFn: (n) => (n.nodeLabels ?? []).join(","),
      size: 110,
      meta: { label: "Node Labels", hint: "Scheduling partitions this node belongs to. Unlabelled nodes use the default partition." },
      cell: ({ row }) => <LabelsCell node={row.original} />,
    },
    {
      id: "rack",
      accessorFn: (n) => n.rack,
      size: 130,
      meta: { label: "Rack", hint: "Network rack used by YARN for placement and locality." },
      cell: ({ row }) => (
        <Datum field="node.rack" raw={row.original.rack} fmt="text" className="truncate font-mono text-small text-ink-2">
          {row.original.rack || "/default-rack"}
        </Datum>
      ),
    },
    {
      id: "state",
      accessorFn: (n) => n.state,
      size: 150,
      meta: { label: "Node State", hint: "Current lifecycle state reported by the ResourceManager." },
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusPill domain="node.state" state={row.original.state} field="node.state" size="sm" />
          {row.original.state === "RUNNING" && healthOf(row.original) === "unhealthy" && (
            <StatusDot domain="node.health" state="unhealthy" label={false} />
          )}
        </span>
      ),
    },
    {
      id: "id",
      accessorFn: (n) => n.id,
      size: 165,
      meta: { label: "Node Address", hint: "NodeManager host and service port. Open the row for resource and container details." },
      cell: ({ row }) => (
        <Datum field="node.id" raw={row.original.id} fmt="text">
          <Link
            to="/nodes/$nodeId"
            params={{ nodeId: row.original.id }}
            className="truncate font-mono text-small text-ink underline-offset-2 hover:text-live hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.id}
          </Link>
        </Datum>
      ),
    },
    {
      id: "nodeHTTPAddress",
      accessorFn: (n) => n.nodeHTTPAddress,
      size: 165,
      meta: { label: "Node HTTP Address", hint: "NodeManager web interface. Inactive nodes may have no web address." },
      cell: ({ row }) => {
        const addr = row.original.nodeHTTPAddress;
        // legacy: inactive nodes carry an empty address and the column shows "N/A" (NodesPage.java)
        return (
          <Datum field="node.nodeHTTPAddress" raw={addr} fmt="text" className="flex min-w-0 items-center gap-1 font-mono text-small">
            {addr ? (
              <>
                <span className="truncate text-ink-2">{addr}</span>
                <Tooltip label={`Open the NodeManager UI at ${addr}`}>
                  <a
                    href={`http://${addr}/`}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={`Open the NodeManager UI at ${addr}`}
                    className="burrow-touch-link text-ink-4 hover:text-live"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                </Tooltip>
              </>
            ) : (
              <span className="text-ink-4">N/A</span>
            )}
          </Datum>
        );
      },
    },
    {
      id: "lastHealthUpdate",
      accessorFn: (n) => n.lastHealthUpdate,
      size: 155,
      meta: { label: "Last health-update", hint: "Most recent health report received from the NodeManager." },
      cell: ({ row }) => <HealthUpdateCell node={row.original} />,
    },
    {
      id: "healthReport",
      accessorFn: (n) => n.healthReport ?? "",
      size: 170,
      meta: {
        label: "Health-report",
        hint: "Diagnostic text from the NodeManager health checks. Node State determines whether the node is unhealthy.",
      },
      cell: ({ row }) => {
        const report = row.original.healthReport ?? "";
        return (
          <Datum
            field="node.healthReport"
            raw={report}
            fmt="text"
            className={cn("block truncate text-small", report ? "text-warn" : "text-ink-4")}
            title={report || "No health report"}
          >
            {report || "—"}
          </Datum>
        );
      },
    },
    {
      id: "numContainers",
      accessorFn: (n) => n.numContainers,
      size: 96,
      meta: { label: "Containers", hint: "Containers currently assigned to this node.", align: "end" },
      cell: ({ row }) => <Datum field="node.numContainers" raw={row.original.numContainers} fmt="int" className="block text-end tnum" />,
    },
    {
      id: "allocationTags",
      accessorFn: (n) => allocationTagSummary(n),
      size: 140,
      meta: { label: "Allocation Tags", hint: "Application placement tags followed by the number of containers carrying each tag." },
      cell: ({ row }) => {
        // NodesPage.java:88 appends `info.getAllocationTagsSummary()` verbatim: `tag(count),tag2(count)`, and "" when
        // the node has no allocation tags (NodeInfo.getAllocationTagsSummary returns "" for null). Verified against
        // legacy.rm.nodes: on the live cluster every node's cell is empty, so the cell must render empty too.
        const summary = allocationTagSummary(row.original);
        return (
          <Datum
            field="node.derived.allocationTagsSummary"
            raw={summary}
            fmt="text"
            className="block truncate text-small text-ink-2"
            title={summary || undefined}
          >
            {summary}
          </Datum>
        );
      },
    },
    {
      id: "usedMemoryMB",
      accessorFn: (n) => n.usedMemoryMB,
      size: 116,
      meta: { label: "Mem Used", hint: "Memory allocated to YARN containers. This differs from physical host memory usage.", align: "end" },
      cell: ({ row }) => (
        <Datum field="node.usedMemoryMB" raw={row.original.usedMemoryMB} fmt="mb" className="relative block text-end tnum" />
      ),
    },
    {
      id: "availMemoryMB",
      accessorFn: (n) => n.availMemoryMB,
      size: 116,
      meta: { label: "Mem Avail", hint: "Memory remaining for YARN container allocation.", align: "end" },
      cell: ({ row }) => (
        <Datum field="node.availMemoryMB" raw={row.original.availMemoryMB} fmt="mb" className="relative block text-end tnum" />
      ),
    },
    {
      id: "memUtilization",
      accessorFn: (n) => utilOf(n).mem,
      size: 130,
      meta: {
        label: "Phys Mem Used %",
        hint: "Physical host memory usage, including processes outside YARN. Displayed as a whole percentage.",
        align: "end",
      },
      cell: ({ row }) => (
        <Datum field="node.memUtilization" raw={row.original.memUtilization} fmt="pct" className="relative block pb-1 text-end tnum">
          <span>{fmtInt(Math.trunc(utilOf(row.original).mem))}%</span>
          <Bar pct={utilOf(row.original).mem} />
        </Datum>
      ),
    },
    {
      id: "usedVirtualCores",
      accessorFn: (n) => n.usedVirtualCores,
      size: 112,
      meta: { label: "VCores Used", hint: "Virtual CPU cores allocated to YARN containers.", align: "end" },
      cell: ({ row }) => (
        <Datum field="node.usedVirtualCores" raw={row.original.usedVirtualCores} fmt="int" className="block text-end tnum" />
      ),
    },
    {
      id: "availableVirtualCores",
      accessorFn: (n) => n.availableVirtualCores,
      size: 112,
      meta: { label: "VCores Avail", hint: "Virtual CPU cores remaining for YARN container allocation.", align: "end" },
      cell: ({ row }) => (
        <Datum field="node.availableVirtualCores" raw={row.original.availableVirtualCores} fmt="int" className="block text-end tnum" />
      ),
    },
    {
      id: "cpuUtilization",
      accessorFn: (n) => utilOf(n).cpu,
      size: 135,
      meta: {
        label: "Phys VCores Used %",
        hint: "Physical CPU utilization reported by the NodeManager. Displayed as a whole percentage.",
        align: "end",
      },
      cell: ({ row }) => (
        <>
          <Datum field="node.cpuUtilization" raw={row.original.cpuUtilization} fmt="pct" className="relative block pb-1 text-end tnum">
            <span>{fmtInt(Math.trunc(utilOf(row.original).cpu))}%</span>
            <Bar pct={utilOf(row.original).cpu} />
          </Datum>
          {!hasCustom && <CustomResourceAbsence />}
        </>
      ),
    },
    ...customResourceColumns(customTypes),
    {
      id: "version",
      accessorFn: (n) => n.version ?? "",
      size: 92,
      meta: { label: "Version", hint: "Hadoop version running on this NodeManager." },
      cell: ({ row }) => <Datum field="node.version" raw={row.original.version} fmt="text" className="truncate text-small text-ink-2" />,
    },
  ];
}

/** Column visibility defaults: the "empty unless configured" columns stay hidden until the cluster actually has them. */
export function defaultVisibility(nodes: readonly Node[]): Record<string, boolean> {
  const anyTags = nodes.some((n) => (n.allocationTags?.allocationTagInfo ?? []).length > 0);
  const anyLabels = nodes.some((n) => (n.nodeLabels ?? []).length > 0);
  const anyHealth = nodes.some((n) => (n.healthReport ?? "").trim() !== "");
  const vis: Record<string, boolean> = {
    nodeLabels: anyLabels,
    state: true,
    id: true,
    rack: true,
    nodeHTTPAddress: true,
    lastHealthUpdate: true,
    healthReport: anyHealth,
    numContainers: true,
    allocationTags: anyTags,
    usedMemoryMB: true,
    availMemoryMB: true,
    memUtilization: true,
    usedVirtualCores: true,
    availableVirtualCores: true,
    cpuUtilization: true,
    version: true,
  };
  // Legacy shows the custom-resource pair as soon as the RM configures the type; mirror that for each type present.
  for (const name of customResourceNames(nodes)) {
    vis[`custom-${name}-used`] = true;
    vis[`custom-${name}-avail`] = true;
  }
  return vis;
}

/** Flash only on a meaningful node health/lifecycle change; heartbeats and resource counters update every poll. */
export function nodeRowVersion(node: Node): string {
  return `${node.state}:${healthOf(node)}`;
}

/** Just the epoch, for tests/tooltips. */
export const healthUpdatedText = (node: Pick<Node, "lastHealthUpdate">) => fmtEpoch(node.lastHealthUpdate);
