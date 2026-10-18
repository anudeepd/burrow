/**
 * Scheduler activities — `GET /api/yarn/scheduler/activities[?nodeId=&groupBy=DIAGNOSTIC]`.
 *
 * The legacy scheduler page has no activities table (it renders the health block instead); this is an addition driven by
 * the assignment. The payload is the latest allocation activity of one NodeManager, as a queue→app→request→node tree, so
 * the table is a flattened tree (indentation in the Queue column) with the container/node identity per row.
 */
import { useEffect, useMemo, useRef } from "react";
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import type { Activities } from "~/api/schemas";
import { activityField, activityRows, type ActivityRow } from "./model";
import { Button } from "~/ui/button";
import { Select } from "~/ui/select";
import { motionAllowed } from "~/lib/motion";
import { onUserScrollIntent } from "~/lib/reveal";
import { partitionText } from "./format";

const DEFAULT_VISIBILITY: ColumnVisibilityState = {};

/** the "no node filter" item in the NodeManager select (Base UI keeps `null` for "nothing chosen", so "" needs a stand-in) */
const ANY_NODE = "__any";

export function ActivitiesTable({
  activities,
  loading,
  fetching,
  error,
  sorting,
  onSortingChange,
  columnVisibility,
  onColumnVisibilityChange,
  nodeId,
  onNodeIdChange,
  nodeOptions,
  groupBy,
  onGroupByChange,
  queueFilter,
  onClearQueueFilter,
  className,
  stableViewport = false,
}: {
  activities: Activities | undefined;
  loading?: boolean;
  /** true for a background request that may replace cached rows after the selected filter changes */
  fetching?: boolean;
  error?: React.ReactNode;
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  columnVisibility: ColumnVisibilityState;
  onColumnVisibilityChange: (v: ColumnVisibilityState) => void;
  nodeId: string;
  onNodeIdChange: (id: string) => void;
  nodeOptions: string[];
  groupBy: string;
  onGroupByChange: (g: string) => void;
  /** when set, only rows at/below this queue are shown (used by the queue detail page) */
  queueFilter?: string;
  onClearQueueFilter?: () => void;
  className?: string;
  stableViewport?: boolean;
}) {
  const tableRegionRef = useRef<HTMLDivElement>(null);
  const previousFilters = useRef({ nodeId, groupBy });
  const revealPending = useRef(false);
  const activeRevealCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    const scroller = tableRegionRef.current?.closest<HTMLElement>(".burrow-page-scroll");
    if (!scroller) return;
    return onUserScrollIntent(scroller, () => {
      if (!revealPending.current) return;
      revealPending.current = false;
      activeRevealCleanup.current?.();
    });
  }, []);

  // On short screens controls may be visible while the table panel's tail is below the fold. Reveal the whole panel
  // when it fits, otherwise reveal its tail, and keep watching until the selected query settles.
  useEffect(() => {
    const previous = previousFilters.current;
    const filtersChanged = previous.nodeId !== nodeId || previous.groupBy !== groupBy;
    previousFilters.current = { nodeId, groupBy };
    if (filtersChanged) revealPending.current = true;
    if (!revealPending.current || loading) return;

    const region = tableRegionRef.current;
    const table = region?.querySelector<HTMLElement>("[data-burrow-table]");
    const pageScroller = region?.closest<HTMLElement>(".burrow-page-scroll");
    if (!region || !table || !pageScroller) return;
    const scroller = pageScroller;

    const reveal = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      const visibleTop = scrollerRect.top + scroller.clientTop;
      const visibleBottom = visibleTop + scroller.clientHeight;
      const regionRect = region.getBoundingClientRect();
      const availableHeight = visibleBottom - visibleTop - 16;
      const regionFits = regionRect.height <= availableHeight;
      const regionFullyVisible = regionRect.top >= visibleTop && regionRect.bottom <= visibleBottom;
      const tailVisible = regionRect.bottom <= visibleBottom;
      if ((regionFits && regionFullyVisible) || (!regionFits && tailVisible)) {
        if (!fetching) revealPending.current = false;
        return true;
      }

      const currentScrollTop = scroller.scrollTop;
      // Fit the entire panel when possible. If it is taller than the page viewport, prioritize its
      // tail (table footer and row count) so the user can see where the table ends.
      const delta = regionFits
        ? regionRect.top < visibleTop + 8
          ? regionRect.top - visibleTop - 8
          : regionRect.bottom - visibleBottom + 8
        : regionRect.bottom - visibleBottom + 8;
      const desiredScrollTop = currentScrollTop + delta;
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const nextScrollTop = Math.max(0, Math.min(maxScrollTop, desiredScrollTop));
      const scrollDelta = nextScrollTop - currentScrollTop;
      const nextTop = regionRect.top - scrollDelta;
      const nextBottom = regionRect.bottom - scrollDelta;
      const willBeVisible = regionFits ? nextTop >= visibleTop && nextBottom <= visibleBottom : nextBottom <= visibleBottom;
      scroller.scrollTo({
        top: nextScrollTop,
        behavior: motionAllowed() ? "smooth" : "auto",
      });
      if (willBeVisible && !fetching) revealPending.current = false;
      return willBeVisible;
    };

    let frame: number | undefined;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleReveal);
    const rowsObserver = new MutationObserver(scheduleReveal);
    function stopWatching() {
      observer?.disconnect();
      rowsObserver.disconnect();
      scroller.removeEventListener("scrollend", scheduleReveal);
      if (activeRevealCleanup.current === stopWatching) activeRevealCleanup.current = null;
    }
    function scheduleReveal() {
      if (!revealPending.current) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (!revealPending.current) return;
        if (reveal() && !revealPending.current) stopWatching();
      });
    }
    // Recheck after smooth scrolling finishes. A clamped scroll may miss the preferred 8px inset
    // while still fitting the panel exactly; only the settled geometry can confirm that case.
    activeRevealCleanup.current = stopWatching;
    scroller.addEventListener("scrollend", scheduleReveal);

    observer?.observe(region);
    observer?.observe(table);
    rowsObserver.observe(table, { attributes: true, attributeFilter: ["data-burrow-rows"] });
    scheduleReveal();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      stopWatching();
    };
  }, [activities, fetching, loading, nodeId, groupBy]);

  const rows = useMemo(() => {
    const all = activityRows(activities);
    if (!queueFilter) return all;
    return all.filter((r) => r.queue === queueFilter || r.queue.startsWith(`${queueFilter}.`));
  }, [activities, queueFilter]);

  const columns = useMemo<ColDef<ActivityRow>[]>(
    () => [
      {
        id: "time",
        meta: { label: "Time", hint: "activities.timestamp — the snapshot's time" },
        size: 165,
        cell: () => <Datum field="activities.timestamp" raw={activities?.timestamp} fmt="epoch" className="tnum text-ink-2" />,
      },
      {
        id: "container",
        meta: { label: "Container Id" },
        size: 150,
        cell: ({ row }) => (
          <Datum field="activities.allocations.updatedContainerId" raw={row.original.containerId} className="font-mono text-caption">
            {row.original.containerId ?? "—"}
          </Datum>
        ),
      },
      {
        id: "node",
        meta: { label: "Node Id" },
        size: 130,
        cell: ({ row }) => {
          const raw = row.original.raw;
          const fromList = (raw.nodeIds ?? []).length > 0;
          return (
            <Datum
              field={activityField(row.original.depth, fromList ? "nodeIds" : "nodeId")}
              raw={fromList ? raw.nodeIds?.[0] : raw.nodeId}
              className="font-mono text-caption"
            >
              {row.original.nodeId ?? "—"}
            </Datum>
          );
        },
      },
      {
        id: "queue",
        meta: { label: "Queue / node", pinned: true },
        size: 140,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center" style={{ paddingLeft: row.original.depth * 14 }}>
            <Datum field={activityField(row.original.depth, "name")} raw={row.original.raw.name} className="truncate font-medium">
              {row.original.queue || "—"}
            </Datum>
          </span>
        ),
      },
      {
        id: "state",
        meta: { label: "Allocation state" },
        size: 130,
        cell: ({ row }) => (
          <Datum field={activityField(row.original.depth, "allocationState")} raw={row.original.raw.allocationState} className="tnum">
            {row.original.state ?? "—"}
          </Datum>
        ),
      },
      {
        id: "final",
        meta: { label: "Final allocation state" },
        size: 150,
        cell: ({ row }) => (
          <Datum field="activities.allocations.finalAllocationState" raw={row.original.finalState} className="tnum">
            {row.original.finalState ?? "—"}
          </Datum>
        ),
      },
      {
        id: "partition",
        meta: { label: "Partition" },
        size: 90,
        cell: ({ row }) => (
          <Datum field="activities.allocations.partition" raw={row.original.partition} className="text-caption">
            {partitionText(row.original.partition)}
          </Datum>
        ),
      },
      {
        id: "count",
        meta: { label: "Count" },
        size: 80,
        cell: ({ row }) => (
          <Datum field={activityField(row.original.depth, "count")} raw={row.original.raw.count} fmt="int" className="tnum">
            {row.original.raw.count == null ? "—" : String(row.original.raw.count)}
          </Datum>
        ),
      },
      {
        id: "diagnostic",
        meta: { label: "Diagnostic" },
        size: 250,
        cell: ({ row }) => (
          <Datum
            field={activityField(row.original.depth, "diagnostic")}
            raw={row.original.raw.diagnostic}
            className="truncate text-small text-ink-3"
          >
            {row.original.diagnostic ?? "—"}
          </Datum>
        ),
      },
    ],
    [activities?.timestamp],
  );

  return (
    <div ref={tableRegionRef} className={className} data-burrow-activities-region="1">
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => `${r.queue}|${r.depth}|${r.containerId ?? ""}|${r.nodeId ?? ""}`}
        entityKey={() => "_"}
        label="Scheduler allocation activities"
        storageKey="scheduler-activities"
        sorting={sorting}
        onSortingChange={onSortingChange}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={onColumnVisibilityChange}
        defaultVisibility={DEFAULT_VISIBILITY}
        loading={loading}
        error={error}
        empty={
          <div className="px-4 py-10 text-center text-body text-ink-3">
            {activities?.diagnostic ?? "No allocation activity for this node."}
            <p className="mt-1 text-small text-ink-4">
              The RM keeps the most recent allocation activity per NodeManager; pick a node or wait for the scheduler's next heartbeat.
            </p>
          </div>
        }
        exportName="scheduler-activities"
        totalCount={rows.length}
        className="h-[min(52dvh,520px)]"
        stableViewport={stableViewport}
        toolbar={
          <>
            <span className="flex items-center gap-1.5 text-small text-ink-3">
              NodeManager
              <Select
                label="NodeManager"
                value={nodeId === "" ? ANY_NODE : nodeId}
                onValueChange={(v) => onNodeIdChange(v == null || v === ANY_NODE ? "" : v)}
                options={[{ value: ANY_NODE, label: "latest (any node)" }, ...nodeOptions.map((n) => ({ value: n, label: n }))]}
              />
            </span>
            <div className="flex items-center gap-0.5" role="group" aria-label="Grouping">
              <Button
                size="sm"
                variant={groupBy === "" ? "default" : "ghost"}
                aria-pressed={groupBy === ""}
                onClick={() => onGroupByChange("")}
              >
                Detailed
              </Button>
              <Button
                size="sm"
                variant={groupBy === "DIAGNOSTIC" ? "default" : "ghost"}
                aria-pressed={groupBy === "DIAGNOSTIC"}
                onClick={() => onGroupByChange("DIAGNOSTIC")}
              >
                Group by diagnostic
              </Button>
            </div>
            {queueFilter && onClearQueueFilter && (
              <Button size="sm" variant="quiet" onClick={onClearQueueFilter}>
                Queue filter: {queueFilter} ✕
              </Button>
            )}
          </>
        }
      />
    </div>
  );
}
