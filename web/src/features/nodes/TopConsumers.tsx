/**
 * "Top consumers" rail: which nodes are carrying the cluster right now, by running containers.
 *
 * This is a derived view (a sort of `node.numContainers`), not a new YARN source. Memory and vCore shares come from the
 * same node objects, so the rail needs no extra request and stays live with the list.
 */
import { Flame } from "lucide-react";
import { useMemo } from "react";
import type { Node } from "~/api/schemas";
import { cn } from "~/lib/cn";
import { fmtInt, fmtMB, fmtPct } from "~/lib/format";
import { Datum } from "~/ui/datum";
import { Tooltip } from "~/ui/tooltip";
import { utilOf } from "./domain";
import { Section } from "./page";

export function TopConsumers({ nodes, onOpen }: { nodes: readonly Node[]; onOpen: (n: Node) => void }) {
  const ranked = useMemo(
    () =>
      [...nodes]
        .filter((n) => n.state === "RUNNING" || n.state === "DECOMMISSIONING")
        .sort((a, b) => b.numContainers - a.numContainers || a.id.localeCompare(b.id))
        .slice(0, 12),
    [nodes],
  );
  const busiest = ranked[0]?.numContainers ?? 0;

  return (
    <Section
      title={
        <h2 className="flex items-center gap-1.5 text-lead font-medium text-ink-2">
          <Flame className="size-4 text-warn" aria-hidden="true" />
          Top consumers
        </h2>
      }
      actions={
        <Tooltip label="Bar length compares container counts with the busiest node.">
          <span className="inline-flex items-center gap-1.5 text-micro text-ink-4">
            <span aria-hidden="true" className="h-1 w-4 rounded-full bg-live" />
            Containers
          </span>
        </Tooltip>
      }
      className="min-h-0"
    >
      <div className="flex min-h-0 flex-col gap-1 overflow-auto rounded-lg border border-seam bg-fabric p-2">
        {ranked.length === 0 ? (
          <p className="px-1 py-3 text-small text-ink-3">No schedulable node is carrying containers.</p>
        ) : (
          ranked.map((node, i) => {
            const util = utilOf(node);
            const share = busiest > 0 ? (node.numContainers / busiest) * 100 : 0;
            return (
              <Tooltip
                key={node.id}
                label={`${node.nodeHostName} · ${fmtInt(node.numContainers)} running containers (${fmtInt(node.numContainers)} of ${fmtInt(busiest)}; bar is relative to the busiest node). ${fmtMB(node.usedMemoryMB)} physical memory used; ${fmtPct(util.mem)} memory and ${fmtPct(util.cpu)} vCore utilization. Click to open node details.`}
              >
                <button
                  data-testid="top-consumer-row"
                  type="button"
                  onClick={() => onOpen(node)}
                  className="group flex flex-col gap-1 rounded-md px-1.5 py-1 text-start hover:bg-fabric-3"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="w-4 shrink-0 text-micro tnum text-ink-4">{i + 1}</span>
                    <span className="truncate font-mono text-small text-ink-2 group-hover:text-ink">{node.nodeHostName}</span>
                    <span className="ml-auto flex shrink-0 items-baseline gap-1">
                      <Datum
                        field="node.numContainers"
                        raw={node.numContainers}
                        fmt="int"
                        className="text-small font-medium text-ink tnum"
                      />
                      <span className="text-micro text-ink-4">containers</span>
                    </span>
                  </span>
                  <span className="ms-6 flex items-center gap-2">
                    <span aria-hidden="true" className={cn("h-1 flex-1 overflow-hidden rounded-full bg-seam")}>
                      <span
                        className="burrow-bar block h-full w-full rounded-full bg-live"
                        // the 2% floor survives as a scale floor, so a tiny share is still visible
                        style={{ "--fill": Math.max(0.02, share / 100) } as React.CSSProperties}
                      />
                    </span>
                    <span className="shrink-0 text-micro text-ink-4 tnum">
                      <Datum field="node.usedMemoryMB" raw={node.usedMemoryMB} fmt="mb" />
                      {` · ${fmtInt(Math.trunc(util.max))}%`}
                    </span>
                  </span>
                </button>
              </Tooltip>
            );
          })
        )}
      </div>
    </Section>
  );
}
