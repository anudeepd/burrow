/**
 * Node labels — the modern `/cluster/nodelabels`.
 *
 * Legacy page (`NodeLabelsPage.java`, Hadoop 3.4.3) has four columns: Label Name · Label Type · Num Of Active NMs ·
 * Total Resource (the partition's `Resource.toFormattedString()`). Two of them are not directly in the REST payload:
 *
 *  - **Num Of Active NMs** comes from `RMNodeLabel.getNumActiveNMs()`, which `/ws/v1/cluster/get-node-labels` does not
 *    serialise. It is derived here from `/nodes` (a node counts when it is in the label's partition), and the derivation is
 *    labelled as such in the UI.
 *  - The **DEFAULT** partition (label name `""`, rendered "DEFAULT") only exists in `pullRMNodeLabelsInfo()`; when the REST
 *    list omits it, it is derived from the nodes that carry no label at all.
 *
 * Two views: the label catalogue, and a read-only mapping "editor" (write actions are an explicit v1 non-goal).
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Network, Table2 } from "lucide-react";
import { useMemo } from "react";
import { nq } from "~/api/queries/nodes";
import type { Node } from "~/api/schemas";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum, Entity } from "~/ui/datum";
import { CenteredPageState, EmptyState, ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { StatusPill } from "~/ui/status";
import { TabContent } from "~/ui/tabs";
import { Segmented } from "~/ui/toggles";
import { Tooltip } from "~/ui/tooltip";
import { buildLabelRows, DEFAULT_LABEL, labelNameText, labelTypeText, type LabelRow, resourceText } from "./domain";
import { hideFromVisibility, parseSorting, serializeSorting, visibilityFromHide } from "~/features/scheduler/search";
import { PageHead, SearchField, Section } from "./page";

const route = getRouteApi("/node-labels");

export function NodeLabelsPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const view = search.view ?? "labels";

  const labelsQ = useQuery(nq.nodeLabels());
  const nodesQ = useQuery(nq.nodes());

  const nodes = nodesQ.data ?? [];
  const labelNames = useMemo(() => (labelsQ.data ?? []).map((l) => l.name), [labelsQ.data]);

  const rows = useMemo(() => buildLabelRows(labelsQ.data ?? [], nodes), [labelsQ.data, nodes]);

  const filtered = useMemo(() => {
    const q = search.q?.trim().toLowerCase();
    return q ? rows.filter((r) => `${r.label.name || "default"} ${labelTypeText(r.label.exclusivity)}`.toLowerCase().includes(q)) : rows;
  }, [rows, search.q]);

  const open = search.open;
  const openRow = rows.find((r) => r.label.name === open);

  if (labelsQ.error && !labelsQ.data) {
    return (
      <CenteredPageState>
        <ErrorState
          title="Cannot read the node labels"
          message={labelsQ.error instanceof Error ? labelsQ.error.message : String(labelsQ.error)}
          hint="Burrow proxies /ws/v1/cluster/get-node-labels; label support requires yarn.node-labels.enabled on the ResourceManager."
          onRetry={() => void labelsQ.refetch()}
        />
      </CenteredPageState>
    );
  }

  if (nodesQ.error && !nodesQ.data) {
    return (
      <CenteredPageState>
        <ErrorState
          title="Cannot read nodes for label membership"
          message={nodesQ.error instanceof Error ? nodesQ.error.message : String(nodesQ.error)}
          hint="Active-node counts, the DEFAULT partition, and node-to-label mappings come from the ResourceManager node list."
          onRetry={() => void nodesQ.refetch()}
        />
      </CenteredPageState>
    );
  }

  if (labelsQ.isPending || nodesQ.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <div className="burrow-scroll burrow-page-scroll flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pb-6 [&>*]:shrink-0">
      <PageHead
        title="Node labels"
        description="Browse YARN partitions and see which nodes belong to each label."
        actions={
          <Segmented
            label="View"
            value={view}
            onValueChange={(v) => navigate({ search: (prev) => ({ ...prev, view: v }), replace: true })}
            options={[
              {
                value: "labels",
                label: <Table2 className="size-3.5" />,
                aria: "Label catalogue",
                hint: "Show each YARN node label and its partition resources.",
              },
              {
                value: "mapping",
                label: <Network className="size-3.5" />,
                aria: "Node to label mapping",
                hint: "Show which nodes belong to each label. This view is read-only.",
              },
            ]}
          />
        }
      />

      {labelsQ.error && (
        <StaleErrorBanner
          title="Node labels refresh failed; showing the last loaded labels"
          error={labelsQ.error}
          onRetry={() => void labelsQ.refetch()}
        />
      )}
      {nodesQ.error && (
        <ErrorState
          compact
          title="Node list refresh failed; showing the last loaded membership data"
          message={nodesQ.error instanceof Error ? nodesQ.error.message : String(nodesQ.error)}
          onRetry={() => void nodesQ.refetch()}
        />
      )}

      <TabContent value={view}>
        {view === "labels" ? (
          <Section>
            {labelsQ.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <DataTable
                data={filtered}
                columns={labelColumns(search.open)}
                getRowId={(r) => r.label.name || "__default__"}
                entityKey={(r) => r.label.name}
                label="Node labels"
                storageKey="burrow.node-labels"
                sorting={parseSorting(search.sort)}
                onSortingChange={(sort) => navigate({ search: (prev) => ({ ...prev, sort: serializeSorting(sort) }), replace: true })}
                columnVisibility={visibilityFromHide(search.hide, {})}
                onColumnVisibilityChange={(visibility) =>
                  navigate({ search: (prev) => ({ ...prev, hide: hideFromVisibility(visibility) }), replace: true })
                }
                defaultVisibility={{ name: true, type: true, activeNMs: true, resource: true, nodes: true }}
                onRowActivate={(r) =>
                  navigate({ search: (prev) => ({ ...prev, open: prev.open === r.label.name ? undefined : r.label.name }), replace: true })
                }
                exportName="node-labels"
                totalCount={rows.length}
                toolbar={
                  <SearchField
                    value={search.q ?? ""}
                    onChange={(q) => navigate({ search: (prev) => ({ ...prev, q: q || undefined }), replace: true })}
                    label="Search labels"
                    placeholder="label name…"
                    className="w-56"
                  />
                }
                empty={<EmptyState title="No node label matches">Clear the search box.</EmptyState>}
              />
            )}

            {openRow && (
              <div className="mt-3 rounded-lg border border-seam bg-fabric p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-lead font-medium text-ink-2">
                    Nodes in <span className="font-mono">{openRow.label.name || "DEFAULT"}</span>
                  </h3>
                  <a
                    href={`/nodes?label=${encodeURIComponent(openRow.label.name === DEFAULT_LABEL ? "(none)" : openRow.label.name)}`}
                    className="text-small text-live underline-offset-2 hover:underline"
                  >
                    Filter the node table by this label
                  </a>
                </div>
                {openRow.nodes.length === 0 ? (
                  <p className="mt-2 text-small text-ink-3">No live node is in this partition right now.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-seam-soft">
                    {openRow.nodes.map((n) => (
                      <li key={n.id} className="flex flex-wrap items-center gap-3 py-1.5">
                        <Entity id={n.id} as="span" className="flex flex-wrap items-center gap-3">
                          <Datum field="node.id" raw={n.id} fmt="text" className="font-mono text-small text-ink" />
                          <Datum field="node.rack" raw={n.rack} fmt="text" className="font-mono text-small text-ink-3" />
                          <StatusPill domain="node.state" state={n.state} field="node.state" size="sm" />
                          <span className="text-small text-ink-3 tnum">
                            <Datum field="node.numContainers" raw={n.numContainers} fmt="int" /> containers ·{" "}
                            <Datum field="node.usedMemoryMB" raw={n.usedMemoryMB} fmt="mb" />
                          </span>
                        </Entity>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Section>
        ) : (
          <MappingView
            nodes={nodes}
            labelNames={labelNames}
            search={search.q ?? ""}
            onSearch={(q) => navigate({ search: (prev) => ({ ...prev, q: q || undefined }), replace: true })}
          />
        )}
      </TabContent>
    </div>
  );
}

function labelColumns(open: string | undefined): ColDef<LabelRow>[] {
  return [
    {
      id: "name",
      accessorFn: (r) => r.label.name || "DEFAULT",
      size: 160,
      meta: { label: "Label Name" },
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Datum
            field="nodelabel.derived.labelNameText"
            raw={row.original.label.name}
            fmt="text"
            className="truncate font-mono text-small text-ink"
          >
            <Datum field="nodelabel.name" raw={row.original.label.name} fmt="text">
              {labelNameText(row.original.label.name)}
            </Datum>
          </Datum>
          {row.original.derived && (
            <Tooltip label="Synthesized from the node list: the REST label catalogue omits the default partition.">
              <span className="rounded-full border border-dashed border-seam-strong px-1 text-micro text-ink-4">derived</span>
            </Tooltip>
          )}
          {open === row.original.label.name && <span className="text-micro text-live">expanded</span>}
        </span>
      ),
    },
    {
      id: "type",
      accessorFn: (r) => (r.label.exclusivity ? "Exclusive Partition" : "Non Exclusive Partition"),
      size: 190,
      meta: { label: "Label Type" },
      cell: ({ row }) => (
        <Datum field="nodelabel.derived.labelTypeText" raw={row.original.label.exclusivity} fmt="text" className="text-small text-ink-2">
          <Datum field="nodelabel.exclusivity" raw={row.original.label.exclusivity} fmt="text">
            {labelTypeText(row.original.label.exclusivity)}
          </Datum>
        </Datum>
      ),
    },
    {
      id: "activeNMs",
      accessorFn: (r) => r.activeNMs,
      size: 150,
      meta: {
        label: "Num Of Active NMs",
        hint: "Running NodeManagers in this partition, counted from the node list.",
        align: "end",
      },
      cell: ({ row }) => (
        <Datum
          field="nodelabel.activeNMs"
          raw={row.original.activeNMs}
          fmt="int"
          className="block text-end text-small tnum"
          title={`${row.original.activeNMs} of ${row.original.nodes.length} mapped node(s) are live`}
        />
      ),
    },
    {
      id: "resource",
      accessorFn: (r) => r.label.partitionInfo?.resourceAvailable?.memory ?? 0,
      size: 200,
      meta: { label: "Partition resources" },
      cell: ({ row }) => {
        const res = row.original.label.partitionInfo?.resourceAvailable;
        if (!res) return <span className="text-small text-ink-4">—</span>;
        return (
          <span className="inline-flex flex-nowrap items-baseline gap-x-1.5 whitespace-nowrap text-small">
            <Datum field="nodelabel.derived.totalResourceText" raw={`${res.memory}/${res.vCores}`} fmt="text" className="sr-only">
              {resourceText(res.memory, res.vCores)}
            </Datum>
            <Datum
              field="nodelabel.partitionInfo.resourceAvailable.memory"
              raw={res.memory}
              fmt="mb"
              className="font-medium text-ink tnum"
            />
            <span className="text-micro text-ink-4">memory</span>
            <span aria-hidden="true" className="text-ink-4">
              ·
            </span>
            <Datum
              field="nodelabel.partitionInfo.resourceAvailable.vCores"
              raw={res.vCores}
              fmt="int"
              className="font-medium text-ink tnum"
            />
            <span className="text-micro text-ink-4">vCores</span>
          </span>
        );
      },
    },
    {
      id: "nodes",
      accessorFn: (r) => r.nodes.length,
      size: 130,
      meta: { label: "Mapped nodes", align: "end" },
      cell: ({ row }) => (
        <Datum field="nodelabel.nodes" raw={row.original.nodes.map((n) => n.id)} fmt="text" className="block text-end text-small tnum">
          {row.original.nodes.length}
        </Datum>
      ),
    },
  ];
}

/**
 * Read-only mapping editor: the node × label matrix with every cell disabled. Making it editable would be a write action
 * (PLAN §1 non-goals); the UI says so instead of pretending.
 */
function MappingView({
  nodes,
  labelNames,
  search,
  onSearch,
}: {
  nodes: Node[];
  labelNames: string[];
  search: string;
  onSearch: (q: string) => void;
}) {
  const q = search.trim().toLowerCase();
  const searchState = route.useSearch();
  const navigate = route.useNavigate();
  const rows = useMemo(
    () => (q ? nodes.filter((n) => `${n.id} ${n.rack} ${(n.nodeLabels ?? []).join(" ")}`.toLowerCase().includes(q)) : nodes),
    [nodes, q],
  );
  const names = useMemo(() => [...labelNames].sort(), [labelNames]);

  const columns = useMemo<ColDef<Node>[]>(() => {
    const base: ColDef<Node>[] = [
      {
        id: "id",
        accessorFn: (n) => n.id,
        size: 200,
        meta: { label: "Node" },
        cell: ({ row }) => <Datum field="node.id" raw={row.original.id} fmt="text" className="truncate font-mono text-small" />,
      },
      {
        id: "rack",
        accessorFn: (n) => n.rack,
        size: 130,
        meta: { label: "Rack" },
        cell: ({ row }) => (
          <Datum field="node.rack" raw={row.original.rack} fmt="text" className="truncate font-mono text-small text-ink-3" />
        ),
      },
      {
        id: "state",
        accessorFn: (n) => n.state,
        size: 140,
        meta: { label: "State" },
        cell: ({ row }) => <StatusPill domain="node.state" state={row.original.state} field="node.state" size="sm" />,
      },
    ];
    return [
      ...base,
      ...names.map<ColDef<Node>>((name) => ({
        id: `label-${name}`,
        accessorFn: (n) => (n.nodeLabels ?? []).includes(name),
        size: 110,
        meta: { label: name },
        cell: ({ row }) => {
          const on = (row.original.nodeLabels ?? []).includes(name);
          return (
            <label className="flex cursor-not-allowed items-center gap-2 text-small text-ink-3">
              <input
                type="checkbox"
                checked={on}
                disabled
                readOnly
                aria-label={`${name} on ${row.original.id} (read-only)`}
                className="size-3.5 accent-(--live)"
              />
              <span>{on ? "yes" : "no"}</span>
            </label>
          );
        },
      })),
    ];
  }, [names]);

  return (
    <Section
      title="Node to label mapping"
      actions={<span className="rounded-full border border-seam px-2 py-0.5 text-micro text-ink-4">Read-only</span>}
    >
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(n) => n.id}
        entityKey={(n) => n.id}
        label="Node to label mapping"
        storageKey="burrow.node-labels.mapping"
        sorting={parseSorting(searchState.mappingSort)}
        onSortingChange={(sort) => navigate({ search: (prev) => ({ ...prev, mappingSort: serializeSorting(sort) }), replace: true })}
        columnVisibility={visibilityFromHide(searchState.mappingHide, {})}
        onColumnVisibilityChange={(visibility) =>
          navigate({ search: (prev) => ({ ...prev, mappingHide: hideFromVisibility(visibility) }), replace: true })
        }
        defaultVisibility={{}}
        exportName="node-label-mapping"
        totalCount={nodes.length}
        toolbar={<SearchField value={search} onChange={onSearch} label="Search nodes" placeholder="host, rack, label…" className="w-64" />}
        empty={<EmptyState title="No node matches">Clear the search box.</EmptyState>}
        className="min-h-[20rem]"
      />
    </Section>
  );
}
