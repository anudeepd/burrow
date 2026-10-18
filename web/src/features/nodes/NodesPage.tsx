/**
 * Nodes list — the modern replacement for `/cluster/nodes`.
 *
 * Layout: summary stats · legacy state tabs · filters · (table | rack heatmap) · top-consumers rail.
 * Every filter, the sort, the visible columns, the view and the selected node live in the URL.
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { LayoutGrid, Rows3 } from "lucide-react";
import { useMemo, useState } from "react";
import { nq } from "~/api/queries/nodes";
import { fmtClock, fmtMB } from "~/lib/format";
import { utilizationTone } from "~/lib/progress-tone";
import { usePref } from "~/state/prefs";
import { DataTable } from "~/ui/data-table/data-table";
import { CenteredPageState, EmptyState, ErrorState, StaleErrorBanner } from "~/ui/feedback";
import { ProgressBar } from "~/ui/progress-bar";
import { Select } from "~/ui/select";
import { StatusDot } from "~/ui/status";
import { Tab, TabContent, TabsList, TabsRoot } from "~/ui/tabs";
import { Ticker } from "~/ui/ticker";
import { Segmented } from "~/ui/toggles";
import { defaultVisibility, nodeColumns, nodeRowVersion } from "./columns";
import { countByTab, customResourceNames, inTab, matchesFilter, NODE_STATE_TABS, rackOf, summarize, type NodeStateTab } from "./domain";
import { PageHead, SearchField, Stat, Unavailable } from "./page";
import { RackHeatmap } from "./RackHeatmap";
import { TopConsumers } from "./TopConsumers";
import { formatCols, formatSort, parseCols, parseSort } from "./search";

const route = getRouteApi("/nodes/");

export function NodesPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [searchResetSignal, setSearchResetSignal] = useState(0);
  const paused = usePref("livePaused");
  const { data: nodes, error, isPending, isFetching, dataUpdatedAt, refetch } = useQuery(nq.nodes());

  const tab = (search.state ?? "ALL") as NodeStateTab;
  const view = search.view ?? "table";

  const byTab = useMemo(() => (nodes ?? []).filter((n) => inTab(n, tab)), [nodes, tab]);
  const filtered = useMemo(
    () => byTab.filter((n) => matchesFilter(n, { label: search.label, rack: search.rack, q: search.q })),
    [byTab, search.label, search.rack, search.q],
  );
  const summary = useMemo(() => summarize(nodes ?? []), [nodes]);
  const racks = useMemo(() => [...new Set((nodes ?? []).map(rackOf))].sort(), [nodes]);
  const labels = useMemo(() => [...new Set((nodes ?? []).flatMap((n) => n.nodeLabels ?? []))].sort(), [nodes]);
  const anyUnlabelled = useMemo(() => (nodes ?? []).some((n) => (n.nodeLabels ?? []).length === 0), [nodes]);

  const setSearch = (patch: Partial<typeof search>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  const sorting = useMemo(() => parseSort(search.sort), [search.sort]);
  const visibility = useMemo(() => parseCols(search.cols) ?? defaultVisibility(nodes ?? []), [search.cols, nodes]);
  // Key by the type names (not the nodes array, which changes every poll) so the column defs stay referentially stable.
  const customTypeKey = customResourceNames(nodes ?? []).join("\n");
  const cols = useMemo(() => nodeColumns(customTypeKey ? customTypeKey.split("\n") : []), [customTypeKey]);

  const stale = isFetching && dataUpdatedAt > 0 && Date.now() - dataUpdatedAt > 15_000;
  const memPct = summary.memTotalMB > 0 ? (summary.memUsedMB / summary.memTotalMB) * 100 : 0;
  const vcorePct = summary.vcoresTotal > 0 ? (summary.vcoresUsed / summary.vcoresTotal) * 100 : 0;

  return (
    <div className="burrow-scroll burrow-page-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-6">
      <PageHead
        title="Nodes"
        description="Review node health, resource capacity, and utilization across the cluster."
        actions={
          <>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-small leading-none text-ink-3">
              <StatusDot domain="service" state={paused ? "unconfigured" : "reachable"} label={false} />
              {paused ? "live paused" : stale ? "stale" : `updated ${fmtClock(dataUpdatedAt)}`}
            </span>
            <Segmented
              label="View"
              value={view}
              onValueChange={(v) => setSearch({ view: v })}
              options={[
                {
                  value: "table",
                  label: <Rows3 className="size-3.5" />,
                  aria: "Table view",
                  hint: "Show nodes in a sortable table with configurable columns.",
                },
                {
                  value: "heatmap",
                  label: <LayoutGrid className="size-3.5" />,
                  aria: "Rack heatmap view",
                  hint: "Group nodes by rack and compare memory and vCore usage.",
                },
              ]}
            />
          </>
        }
      />

      {error && !nodes ? (
        <CenteredPageState>
          <ErrorState
            title="Cannot read the node list"
            message={error instanceof Error ? error.message : String(error)}
            hint="Burrow proxies /ws/v1/cluster/nodes from the active ResourceManager."
            onRetry={() => void refetch()}
          />
        </CenteredPageState>
      ) : (
        <>
          {error && (
            <StaleErrorBanner title="Node list refresh failed; showing the last loaded rows" error={error} onRetry={() => void refetch()} />
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-page-motion="cards">
            <Stat
              label="Running"
              value={<Ticker value={summary.running} />}
              sub={`of ${summary.total} nodes`}
              tone={summary.running > 0 ? "ok" : "fail"}
            />
            <Stat
              label="Unhealthy"
              value={<Ticker value={summary.unhealthy} />}
              sub={summary.lost > 0 ? `${summary.lost} lost` : "health checks passing"}
              tone={summary.unhealthy > 0 ? "warn" : undefined}
            />
            <Stat label="Containers" value={<Ticker value={summary.containers} />} sub="allocated on all nodes" />
            <Stat
              label="Memory"
              value={
                <span className="flex items-baseline gap-1">
                  {fmtMB(summary.memUsedMB)}
                  <span className="text-small font-normal text-ink-3">of {fmtMB(summary.memTotalMB)}</span>
                </span>
              }
              sub={<ProgressBar percent={memPct} label="Cluster memory used" tone={utilizationTone(memPct)} className="mt-1" />}
            />
            <Stat
              label="vCores"
              value={
                <span className="flex items-baseline gap-1">
                  <Ticker value={summary.vcoresUsed} />
                  <span className="text-small font-normal text-ink-3">of {summary.vcoresTotal}</span>
                </span>
              }
              sub={<ProgressBar percent={vcorePct} label="Cluster vCores used" tone={utilizationTone(vcorePct)} className="mt-1" />}
            />
          </div>

          <TabsRoot value={tab} onValueChange={(v) => setSearch({ state: v as NodeStateTab })}>
            <TabsList label="Node state filter" overflowFade>
              {NODE_STATE_TABS.map((t) => (
                <Tab key={t.id} value={t.id} badge={countByTab(nodes ?? [], t.id)} field={`node.state.${t.id}`}>
                  {t.label}
                </Tab>
              ))}
            </TabsList>
          </TabsRoot>

          <TabContent value={tab} className="flex shrink-0 flex-col gap-4">
            <div className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
              <TabContent value={view} className="flex min-h-0 flex-col gap-3">
                {view === "table" ? (
                  <DataTable
                    data={filtered}
                    columns={cols}
                    getRowId={(n) => n.id}
                    entityKey={(n) => n.id}
                    label="Cluster nodes"
                    storageKey="burrow.nodes"
                    sorting={sorting}
                    onSortingChange={(s) => setSearch({ sort: formatSort(s) })}
                    columnVisibility={visibility}
                    onColumnVisibilityChange={(v) => setSearch({ cols: formatCols(v) })}
                    defaultVisibility={defaultVisibility(nodes ?? [])}
                    rowVersion={nodeRowVersion}
                    onRowActivate={(n) => void navigate({ to: "/nodes/$nodeId", params: { nodeId: n.id } })}
                    loading={isPending}
                    totalCount={byTab.length}
                    exportName="nodes"
                    toolbar={
                      <>
                        <SearchField
                          value={search.q ?? ""}
                          resetSignal={searchResetSignal}
                          onChange={(q) => setSearch({ q: q || undefined })}
                          label="Search nodes"
                          placeholder="host, rack, label, version…"
                          className="w-64"
                        />
                        <Select
                          label="Label filter"
                          value={search.label ?? null}
                          onValueChange={(v) => setSearch({ label: v || undefined })}
                          placeholder="All labels"
                          options={[
                            { value: "", label: "All labels" },
                            ...(anyUnlabelled ? [{ value: "(none)", label: "No label" }] : []),
                            ...labels.map((l) => ({ value: l, label: l })),
                          ]}
                          className="w-40"
                        />
                        <Select
                          label="Rack filter"
                          value={search.rack ?? null}
                          onValueChange={(v) => setSearch({ rack: v || undefined })}
                          placeholder="All racks"
                          options={[{ value: "", label: "All racks" }, ...racks.map((r) => ({ value: r, label: r }))]}
                          className="w-40"
                        />
                        {(search.q || search.label || search.rack) && (
                          <button
                            type="button"
                            className="burrow-touch-target inline-flex items-center justify-center rounded-md px-2 text-small text-ink-3 underline-offset-2 hover:bg-fabric-3 hover:text-ink hover:underline"
                            onClick={() => {
                              setSearchResetSignal((signal) => signal + 1);
                              setSearch({ q: undefined, label: undefined, rack: undefined });
                            }}
                          >
                            Clear filters
                          </button>
                        )}
                      </>
                    }
                    empty={
                      <EmptyState title="No node matches these filters">
                        Widen the state tab, or clear the label, rack and text filters.
                      </EmptyState>
                    }
                    className="min-h-[24rem] max-h-[min(52dvh,520px)]"
                  />
                ) : (
                  <RackHeatmap
                    nodes={filtered}
                    selected={search.sel}
                    onSelect={(n) => setSearch({ sel: n.id })}
                    onOpen={(n) => void navigate({ to: "/nodes/$nodeId", params: { nodeId: n.id } })}
                  />
                )}
              </TabContent>

              <TopConsumers nodes={byTab} onOpen={(n) => void navigate({ to: "/nodes/$nodeId", params: { nodeId: n.id } })} />
            </div>

            {view === "heatmap" && (
              <Unavailable
                title="Heatmap colours are physical utilisation"
                reason="Each cell is the worse of the NodeManager's physical memory and vCore utilisation (nodeUtilization — the same numbers the NM exposes over JMX). Rows group nodes by rack."
                hint="Click a cell to select it; press Enter to open the node."
              />
            )}
          </TabContent>
        </>
      )}
    </div>
  );
}
