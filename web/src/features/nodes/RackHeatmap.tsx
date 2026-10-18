/**
 * Rack × node utilisation heatmap — the "where is the cluster hot" view.
 *
 * Colouring is the worse of physical memory % and vCore % (`node.memUtilization` / `node.cpuUtilization`, i.e.
 * `NodeInfo.getMemUtilization()` / `getVcoreUtilization()`), banded by `utilBand`. Never colour-only: each cell also
 * carries its percentages as text and an aria-label, and the legend names every band.
 */
import { useMemo } from "react";
import type { Node } from "~/api/schemas";
import { cn } from "~/lib/cn";
import { fmtInt } from "~/lib/format";
import { Entity, datumAttrs } from "~/ui/datum";
import { EmptyState } from "~/ui/feedback";
import { Tooltip } from "~/ui/tooltip";
import { groupByRack, UTIL_BAND_TONE, utilBand, utilOf, type UtilBand } from "./domain";

const BANDS: { band: UtilBand; label: string }[] = [
  { band: "idle", label: "idle" },
  { band: "ok", label: "< 50%" },
  { band: "busy", label: "50–75%" },
  { band: "hot", label: "75–90%" },
  { band: "full", label: "≥ 90%" },
];

function Cell({
  node,
  selected,
  onSelect,
  onOpen,
}: {
  node: Node;
  selected: boolean;
  onSelect: (n: Node) => void;
  onOpen: (n: Node) => void;
}) {
  const util = utilOf(node);
  const band = utilBand(util.max);
  return (
    <Entity id={node.id} as="div" className="min-w-0">
      <Tooltip
        label={
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-micro">{node.id}</span>
            <span>
              memory {fmtInt(Math.trunc(util.mem))}% · vcores {fmtInt(Math.trunc(util.cpu))}%
            </span>
            <span>
              {node.numContainers} container{node.numContainers === 1 ? "" : "s"} · {node.state}
            </span>
          </div>
        }
      >
        <button
          type="button"
          onClick={() => onSelect(node)}
          onDoubleClick={() => onOpen(node)}
          aria-pressed={selected}
          aria-label={`${node.id}: memory ${fmtInt(Math.trunc(util.mem))} percent, vcores ${fmtInt(Math.trunc(util.cpu))} percent, ${node.state}`}
          className={cn(
            "relative flex h-14 w-full min-w-0 flex-col justify-between overflow-hidden rounded-md border px-2 py-1 text-start",
            // colour and outline only: the old list animated `box-shadow`, which is a paint cost the design rules forbid
            "border-seam bg-fabric-2 transition-[border-color,outline-color] duration-(--dur-fast) ease-(--ease-out) hover:border-seam-strong",
            selected && "border-live outline-2 outline-live/60",
          )}
          style={{
            backgroundImage: `linear-gradient(160deg, color-mix(in oklch, ${UTIL_BAND_TONE[band]} 26%, transparent), transparent 78%)`,
          }}
        >
          <span className="flex min-w-0 items-center gap-1">
            <span aria-hidden="true" className="block size-2 shrink-0 rounded-xs" style={{ background: UTIL_BAND_TONE[band] }} />
            <span className="truncate font-mono text-micro text-ink-2">{node.nodeHostName}</span>
          </span>
          <span className="flex items-baseline gap-1.5 text-micro text-ink-3">
            <span {...datumAttrs("node.memUtilization", node.memUtilization, "pct")} className="tnum">
              {fmtInt(Math.trunc(util.mem))}%
            </span>
            <span {...datumAttrs("node.cpuUtilization", node.cpuUtilization, "pct")} className="tnum">
              {fmtInt(Math.trunc(util.cpu))}%
            </span>
          </span>
          <span {...datumAttrs("node.numContainers", node.numContainers, "int")} className="sr-only">
            {node.numContainers} containers
          </span>
          <span {...datumAttrs("node.state", node.state, "text")} className="sr-only">
            {node.state}
          </span>
        </button>
      </Tooltip>
    </Entity>
  );
}

export function RackHeatmap({
  nodes,
  selected,
  onSelect,
  onOpen,
}: {
  nodes: readonly Node[];
  selected?: string;
  onSelect: (n: Node) => void;
  onOpen: (n: Node) => void;
}) {
  const racks = useMemo(() => groupByRack(nodes), [nodes]);
  if (nodes.length === 0) {
    return <EmptyState title="No node in this view">Widen the state tab or clear the filters to see the racks.</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-seam bg-fabric p-3">
      <div className="flex flex-wrap items-center gap-3">
        {BANDS.map(({ band, label }) => (
          <span key={band} className="flex items-center gap-1.5 text-micro text-ink-3">
            <span
              aria-hidden="true"
              className="block size-2.5 rounded-xs border border-seam-strong"
              style={{ background: UTIL_BAND_TONE[band] }}
            />
            {label}
          </span>
        ))}
        <span className="ml-auto text-micro text-ink-4">max(memory %, vcores %) per node</span>
      </div>
      {racks.map(({ rack, nodes: rackNodes }) => (
        <div key={rack} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <h3 className="font-mono text-small text-ink-2">{rack}</h3>
            <span className="text-micro text-ink-4">
              {rackNodes.length} node{rackNodes.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-1.5">
            {rackNodes.map((node) => (
              <Cell key={node.id} node={node} selected={selected === node.id} onSelect={onSelect} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
