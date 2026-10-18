/**
 * Treemap section: leaf queues as tiles, sized by used memory or by guaranteed share, dyed by pressure.
 * Leaf granularity on purpose — a parent's usage is the sum of its children, so including both would double-count.
 */
import { useEffect, useMemo, useState } from "react";
import { CircleHelp } from "lucide-react";
import { Button } from "~/ui/button";
import { fmtMB } from "~/lib/format";
import { TabContent } from "~/ui/tabs";
import { Tooltip } from "~/ui/tooltip";
import { QueueTreemap, TreemapList, type TreemapItem } from "./Treemap";
import { leafNodes, metricsOf, partitionOf, pressurePctOf, type QueueNode } from "./model";
import { Section } from "./Chrome";

export type TreemapBasis = "used" | "capacity";

export function treemapItems(root: QueueNode, basis: TreemapBasis, partition = ""): TreemapItem[] {
  const isDefault = partition === "";
  return leafNodes(root).map((node) => {
    const m = metricsOf(node, partition);
    const { cap: pcap, res: pres } = partitionOf(node, partition);
    const cap = node.capacity;
    const fair = node.fair;
    const usedMb = m.usedMb;
    const guaranteedMb = m.minMb;
    const usedPct = pressurePctOf(node, m);
    const value = basis === "used" ? (usedMb ?? 0) : (guaranteedMb ?? 0);
    const field = node.capacity
      ? basis === "used"
        ? isDefault
          ? "queue.resourcesUsed.memory"
          : "queue.resources.resourceUsagesByPartition.used.memory"
        : isDefault
          ? "queue.minEffectiveCapacity.memory"
          : "queue.capacities.queueCapacitiesByPartition.effectiveMinResource.memory"
      : basis === "used"
        ? "queue.usedResources.memory"
        : "queue.minResources.memory";
    const raw = node.capacity
      ? basis === "used"
        ? isDefault
          ? cap?.resourcesUsed?.memory
          : pres?.used?.memory
        : isDefault
          ? cap?.minEffectiveCapacity?.memory
          : pcap?.effectiveMinResource?.memory
      : basis === "used"
        ? fair?.usedResources?.memory
        : fair?.minResources?.memory;
    return {
      key: node.id,
      value,
      field,
      raw,
      usedPct,
      sub:
        basis === "used"
          ? `${fmtMB(usedMb)} used${guaranteedMb != null ? ` of ${fmtMB(guaranteedMb)} guaranteed` : ""}`
          : `guaranteed ${fmtMB(guaranteedMb)}${usedMb != null ? `, ${fmtMB(usedMb)} used` : ""}`,
    };
  });
}

export function TreemapSection({
  root,
  basis,
  partition = "",
  onBasisChange,
  className,
}: {
  root: QueueNode;
  basis: TreemapBasis;
  /** selected node-label partition ("" = default partition) */
  partition?: string;
  onBasisChange: (b: TreemapBasis) => void;
  className?: string;
}) {
  const items = useMemo(() => treemapItems(root, basis, partition), [root, basis, partition]);
  const totalUsed = items.reduce((a, b) => a + (b.value > 0 ? b.value : 0), 0);
  const [animateGeometry, setAnimateGeometry] = useState(false);
  useEffect(() => {
    if (!animateGeometry) return;
    // Start the timeout after the updated treemap has committed with its transition class. Starting it in the
    // click handler can let a slow CI render consume the whole transition window before the new geometry appears.
    const timer = window.setTimeout(() => setAnimateGeometry(false), 500);
    return () => window.clearTimeout(timer);
  }, [animateGeometry]);
  const changeBasis = (next: TreemapBasis) => {
    if (next === basis) return;
    setAnimateGeometry(true);
    onBasisChange(next);
  };
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-1.5">
          Queue resource map
          <Tooltip label="Leaf queues only. Parent totals include their children, so parent queues are omitted to avoid double-counting.">
            <button
              type="button"
              aria-label="Why are only leaf queues shown?"
              className="burrow-help inline-grid size-5 place-items-center rounded text-ink-4 hover:text-ink-2"
            >
              <CircleHelp className="size-3.5" aria-hidden="true" />
            </button>
          </Tooltip>
        </span>
      }
      hint={
        basis === "used"
          ? "Tile area shows used memory; color shows usage against the queue’s guaranteed share."
          : "Tile area shows guaranteed share; color shows usage against that share."
      }
      actions={
        <div className="flex items-center gap-1" role="group" aria-label="Size queues by">
          <span className="text-small text-ink-4">Size by</span>
          <Button
            size="sm"
            variant={basis === "used" ? "default" : "ghost"}
            aria-pressed={basis === "used"}
            onClick={() => changeBasis("used")}
          >
            Used memory
          </Button>
          <Button
            size="sm"
            variant={basis === "capacity" ? "default" : "ghost"}
            aria-pressed={basis === "capacity"}
            onClick={() => changeBasis("capacity")}
          >
            Guaranteed share
          </Button>
        </div>
      }
      className={className}
    >
      {/* The figure renders in both states so the pane keeps its height (and its legend, which belongs to it): the
          empty case overlays the message inside the same frame instead of swapping a shorter box in. */}
      <TabContent value={basis} className="relative">
        <QueueTreemap items={items} basis={basis} label="Queue resource map" animateGeometry={animateGeometry} />
        {basis === "used" && totalUsed === 0 && (
          <div className="absolute inset-0 grid place-items-center px-4 text-center">
            <div className="burrow-enter-pop max-w-sm">
              <p className="text-body font-medium text-ink">No memory in use</p>
              <p className="mt-1 text-small text-ink-3">View guaranteed shares to see how capacity is divided.</p>
              <Button size="sm" variant="quiet" className="mt-3" onClick={() => changeBasis("capacity")}>
                View guaranteed shares
              </Button>
            </div>
          </div>
        )}
      </TabContent>
      <TreemapList items={items} />
    </Section>
  );
}
