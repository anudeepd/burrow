/**
 * Spark storage list — the native replacement for Spark's tracking-UI storage page (`/storage/`).
 *
 * One row per cached RDD. Activating a row opens the RDD detail route; the chevron expands the same detail inline via
 * `?rdd=<id>` (URL state, so it survives reload) using `RddDetailBody` from the detail page — one implementation, no drift.
 *
 * Spark reports an RDD here only while at least one of its blocks is still held; evicted RDDs disappear entirely, and
 * `spark.rdd` partitions are only the blocks Spark currently knows about.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { fmtInt } from "~/lib/format";
import { Button } from "~/ui/button";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import { fmtFraction, fraction } from "../data/format";
import { sp } from "../data/queries";
import type { SparkRdd } from "../data/schemas";
import { compact, intParam, matchesQuery, parseColumns, parseSort, serializeColumns, serializeSort } from "../data/search";
import { PageHeader } from "../ui/PageHeader";
import { InlineNote, SparkEmpty, SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { useSpark } from "../ui/context";
import { RddDetailBody } from "./RddDetailPage";

const route = getRouteApi("/apps/$appId/spark/storage/");

const DEFAULT_VISIBILITY = { name: true, storageLevel: true, cachedPartitions: true, fraction: true, memoryUsed: true, diskUsed: true };

export function StoragePage() {
  const { appId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind, attempt } = useSpark();

  const q = typeof search.q === "string" ? search.q : "";
  const expandedId = intParam(search.rdd);
  const qRdds = useQuery(sp.rdds(appId, kind, attempt));
  const rdds = useMemo(() => qRdds.data ?? [], [qRdds.data]);
  const filtering = useMemo(() => (q ? rdds.filter((r) => matchesQuery([r.id, r.name, r.storageLevel], q)) : rdds), [rdds, q]);
  const expandedRdd = expandedId != null ? rdds.find((r) => r.id === expandedId) : undefined;

  const sorting = parseSort(search);
  const columnVisibility = parseColumns(search);
  const patch = (p: Record<string, unknown>) => void navigate({ search: (prev) => compact({ ...prev, ...p }) });

  const columns = useMemo<ColDef<SparkRdd>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        size: 64,
        meta: { label: "ID", pinned: true, align: "start", exportValue: (r: SparkRdd) => r.id },
        header: "ID",
        cell: (info) => (
          <Link
            to="/apps/$appId/spark/storage/$rddId"
            params={{ appId, rddId: String(info.row.original.id) }}
            search={{ attempt: attempt ?? undefined }}
            className="font-medium text-live underline-offset-2 hover:underline"
          >
            <Datum field="spark.rdd.id" raw={info.row.original.id} fmt="int" />
          </Link>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        size: 240,
        meta: { label: "Name", exportValue: (r: SparkRdd) => r.name },
        header: "Name",
        cell: (info) => (
          <Datum field="spark.rdd.name" raw={info.row.original.name} className="truncate" title={info.row.original.name ?? undefined} />
        ),
      },
      {
        id: "storageLevel",
        accessorKey: "storageLevel",
        meta: { label: "Storage Level", exportValue: (r: SparkRdd) => r.storageLevel },
        header: "Storage Level",
        cell: (info) => <Datum field="spark.rdd.storageLevel" raw={info.row.original.storageLevel} className="whitespace-nowrap" />,
      },
      {
        id: "cachedPartitions",
        enableSorting: false,
        meta: { label: "Cached / total partitions", align: "end" },
        header: "Cached Partitions",
        cell: (info) => (
          <span className="flex items-center gap-1 tnum">
            <Datum field="spark.rdd.numCachedPartitions" raw={info.row.original.numCachedPartitions} fmt="int" />
            <span className="text-ink-4">/</span>
            <Datum field="spark.rdd.numPartitions" raw={info.row.original.numPartitions} fmt="int" className="text-ink-3" />
          </span>
        ),
      },
      {
        id: "fraction",
        sortFn: "basic",
        accessorFn: (r) => fraction(r.numCachedPartitions, r.numPartitions) ?? -1,
        meta: {
          label: "Fraction Cached",
          hint: "Cached partitions divided by total partitions, shown as a percentage.",
          align: "end",
          exportValue: (r: SparkRdd) => fraction(r.numCachedPartitions, r.numPartitions),
        },
        header: "Fraction Cached",
        cell: (info) => (
          <Datum
            field="spark.rdd.derived.fractionCached"
            raw={fraction(info.row.original.numCachedPartitions, info.row.original.numPartitions)}
            fmt="text"
            className="tnum"
          >
            {fmtFraction(info.row.original.numCachedPartitions, info.row.original.numPartitions)}
          </Datum>
        ),
      },
      {
        id: "memoryUsed",
        accessorKey: "memoryUsed",
        meta: { label: "Size in Memory", align: "end", exportValue: (r: SparkRdd) => r.memoryUsed },
        header: "Size in Memory",
        cell: (info) => <Datum field="spark.rdd.memoryUsed" raw={info.row.original.memoryUsed} fmt="bytes" className="tnum" />,
      },
      {
        id: "diskUsed",
        accessorKey: "diskUsed",
        meta: { label: "Size on Disk", align: "end", exportValue: (r: SparkRdd) => r.diskUsed },
        header: "Size on Disk",
        cell: (info) => <Datum field="spark.rdd.diskUsed" raw={info.row.original.diskUsed} fmt="bytes" className="tnum" />,
      },
      {
        id: "expand",
        enableSorting: false,
        meta: { label: "Partitions / distribution" },
        header: "Detail",
        cell: (info) => {
          const id = info.row.original.id;
          const open = id === expandedId;
          return (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${open ? "Hide" : "Show"} partitions and executor distribution of RDD ${id}`}
              title={`${open ? "Hide" : "Show"} partitions and executor distribution of RDD ${id}`}
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                patch({ rdd: open ? undefined : String(id) });
              }}
            >
              {open ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
            </Button>
          );
        },
      },
    ],
    [appId, expandedId, attempt],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader title="Storage" hideTitle>
        <label className="flex items-center gap-1.5 text-small text-ink-3">
          <span className="sr-only">Filter RDDs by name, id or storage level</span>
          <input
            type="search"
            value={q}
            onChange={(e) => patch({ q: e.target.value || undefined })}
            placeholder="Filter name / id…"
            className="h-(--ctl-h) w-52 rounded-md border border-seam-strong bg-well px-2 text-body text-ink placeholder:text-ink-4"
          />
        </label>
      </PageHeader>

      {qRdds.error && qRdds.data !== undefined && (
        <SparkStaleErrorBanner error={qRdds.error} subject="the cached RDD list" onRetry={() => void qRdds.refetch()} />
      )}
      {qRdds.isPending ? (
        <SparkLoading rows={8} cols={7} />
      ) : qRdds.error && qRdds.data === undefined ? (
        <SparkFailureState error={qRdds.error} subject="the cached-RDD list" onRetry={() => void qRdds.refetch()} />
      ) : rdds.length === 0 ? (
        <SparkEmpty title="No RDD is cached in this application">
          Spark lists an RDD here only while a block is still held in memory or on disk; evicted RDDs disappear from this list.
        </SparkEmpty>
      ) : (
        <DataTable<SparkRdd>
          className="min-h-[24rem]"
          data={filtering}
          columns={columns}
          getRowId={(r) => String(r.id)}
          entityKey={(r) => String(r.id)}
          label="Cached RDDs"
          storageKey="spark-storage"
          sorting={sorting}
          onSortingChange={(s: SortingState) => patch(serializeSort(s))}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={(v) => patch(serializeColumns(v))}
          defaultVisibility={DEFAULT_VISIBILITY}
          onRowActivate={(r) =>
            void navigate({
              to: "/apps/$appId/spark/storage/$rddId",
              params: { appId, rddId: String(r.id) },
              search: { attempt: attempt ?? undefined },
            })
          }
          rowVersion={(r) => `${r.memoryUsed ?? 0}:${r.diskUsed ?? 0}:${r.numCachedPartitions ?? 0}`}
          totalCount={rdds.length}
          exportName={`spark-storage-${appId}`}
          toolbar={
            <span className="text-small text-ink-4">
              {filtering.length === rdds.length ? (
                <>{fmtInt(rdds.length)} shown</>
              ) : (
                <>
                  {fmtInt(filtering.length)} of {fmtInt(rdds.length)}
                </>
              )}
            </span>
          }
        />
      )}

      {expandedId != null && (
        <section aria-label={`RDD ${expandedId} detail`} className="flex flex-col gap-2 rounded-lg border border-seam bg-fabric-2 p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-body font-semibold text-ink">RDD {expandedId} — partitions and executor distribution</h3>
            <Button variant="ghost" size="sm" onClick={() => patch({ rdd: undefined })} aria-label={`Collapse RDD ${expandedId}`}>
              Collapse
            </Button>
          </div>
          {expandedRdd ? (
            <RddDetailBody appId={appId} rdd={expandedRdd} />
          ) : (
            <InlineNote>RDD {expandedId} is not in this list — Spark reports blocks only while they are still held.</InlineNote>
          )}
        </section>
      )}
    </div>
  );
}
