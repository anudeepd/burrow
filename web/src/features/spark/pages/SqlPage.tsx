/**
 * Spark SQL list — the native replacement for `/SQL/` in Spark's tracking UI.
 *
 * One row per SQL execution. Spark's REST SQL schema has no result-row/result-size field, so this page says so instead
 * of inventing columns; the plan is deep-linked to the execution detail. Sorting / visible columns / status / search /
 * paging all live in the URL. When `?size=` is set the list is fetched with Spark's `offset`/`length` server paging.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { ListTree } from "lucide-react";
import { useMemo } from "react";
import { fmtEpoch, fmtInt } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Button } from "~/ui/button";
import { Datum } from "~/ui/datum";
import { Select } from "~/ui/select";
import { StatusPill } from "~/ui/status";
import { parseSparkTime, sqlDurationMs } from "../data/format";
import { sp } from "../data/queries";
import type { SparkSqlExecution } from "../data/schemas";
import { compact, intParam, matchesQuery, parseColumns, parseSort, serializeColumns, serializeSort } from "../data/search";
import { PageHeader } from "../ui/PageHeader";
import { SparkEmpty, SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { useSpark } from "../ui/context";
import { useNow } from "../ui/use-now";
import { OptionalTooltip } from "~/ui/tooltip";

const route = getRouteApi("/apps/$appId/spark/sql/");

const DEFAULT_VISIBILITY = {
  description: true,
  submitted: true,
  duration: true,
  running: true,
  success: true,
  failed: true,
  errors: true,
  plan: true,
};

const PAGE_SIZES = [25, 50, 100];

/**
 * The legacy SQL tab opens newest-first (DataTables' `ID ▾`), but Spark's REST `sql` list is ascending — jobs and stages
 * arrive descending already, so SQL is the one list whose default order has to be applied here. Server-paged pages sort
 * the same way the legacy page's table does: the loaded page only.
 */
const SQL_DEFAULT_SORTING: SortingState = [{ id: "id", desc: true }];

function SqlStatus({ status }: { status: string | null | undefined }) {
  return (
    <StatusPill domain="spark.sql" state={status} field="spark.sql.status" size="sm">
      {status ?? "UNKNOWN"}
    </StatusPill>
  );
}

function JobIdLinks({
  appId,
  ids,
  field,
  attempt,
}: {
  appId: string;
  ids: number[] | null | undefined;
  field: string;
  attempt: string | null;
}) {
  if (!ids || ids.length === 0) return <span className="text-ink-4">—</span>;
  return (
    <OptionalTooltip label={`${ids.length} job id(s)`}>
      <span className="flex flex-wrap items-center gap-1">
        <span className="tnum text-small text-ink-3">{ids.length}</span>
        {ids.map((id) => (
          <Link
            key={id}
            to="/apps/$appId/spark/jobs/$jobId"
            params={{ appId, jobId: String(id) }}
            search={{ attempt: attempt ?? undefined }}
            className="text-live underline-offset-2 hover:underline"
          >
            <Datum field={field} raw={id} fmt="int" className="font-mono text-micro">
              {id}
            </Datum>
          </Link>
        ))}
      </span>
    </OptionalTooltip>
  );
}

export function SqlPage() {
  const { appId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind, attempt } = useSpark();
  const now = useNow();
  const tz = usePref("tz");

  const parsedSize = intParam(search.size);
  const limit = parsedSize != null && parsedSize > 0 ? parsedSize : null;
  const page = Math.max(0, intParam(search.page, 0) ?? 0);
  const status = typeof search.status === "string" && search.status !== "" ? search.status : undefined;
  const q = typeof search.q === "string" ? search.q : "";

  const sqlQ = useQuery(sp.sql(appId, limit != null ? { offset: page * limit, length: limit, kind, attempt } : { kind, attempt }));
  const rows = useMemo(() => sqlQ.data ?? [], [sqlQ.data]);

  const filtering = useMemo(
    () =>
      rows.filter(
        (e) => (!status || e.status === status) && (!q || matchesQuery([e.id, e.description, e.status, e.queryId, e.errorMessage], q)),
      ),
    [rows, status, q],
  );

  /* the legacy tab's newest-first default applies when the URL carries no sort */
  const parsedSort = parseSort(search);
  const sorting = parsedSort.length ? parsedSort : SQL_DEFAULT_SORTING;
  const columnVisibility = parseColumns(search);
  const patch = (p: Record<string, unknown>) => void navigate({ search: (prev) => compact({ ...prev, ...p }) });
  const setSize = (v: string | null) => patch({ size: v || undefined, page: v ? "0" : undefined });

  const columns = useMemo<ColDef<SparkSqlExecution>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        size: 64,
        meta: { label: "ID", pinned: true, align: "start", exportValue: (r: SparkSqlExecution) => r.id },
        header: "ID",
        cell: (info) => (
          <Link
            to="/apps/$appId/spark/sql/$executionId"
            params={{ appId, executionId: String(info.row.original.id) }}
            search={{ attempt: attempt ?? undefined }}
            className="font-medium text-live underline-offset-2 hover:underline"
          >
            <Datum field="spark.sql.id" raw={info.row.original.id} fmt="int">
              {String(info.row.original.id)}
            </Datum>
          </Link>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        size: 120,
        meta: { label: "Status", exportValue: (r: SparkSqlExecution) => r.status },
        header: "Status",
        cell: (info) => <SqlStatus status={info.row.original.status} />,
      },
      {
        id: "description",
        accessorKey: "description",
        meta: { label: "Description", exportValue: (r: SparkSqlExecution) => r.description },
        header: "Description",
        cell: (info) => (
          <Datum
            field="spark.sql.description"
            raw={info.row.original.description}
            className="truncate"
            title={info.row.original.description ?? undefined}
          />
        ),
      },
      {
        id: "submitted",
        accessorKey: "submissionTime",
        meta: { label: "Submitted", exportValue: (r: SparkSqlExecution) => r.submissionTime },
        header: "Submitted",
        cell: (info) => (
          <Datum
            field="spark.sql.submissionTime"
            raw={info.row.original.submissionTime}
            fmt="text"
            className="whitespace-nowrap text-ink-3"
          >
            {fmtEpoch(parseSparkTime(info.row.original.submissionTime), tz)}
          </Datum>
        ),
      },
      {
        id: "duration",
        sortFn: "basic",
        accessorFn: (e) => sqlDurationMs(e, now) ?? -1,
        meta: { label: "Duration", align: "end", exportValue: (r: SparkSqlExecution) => sqlDurationMs(r, now) },
        header: "Duration",
        cell: (info) => (
          <Datum field="spark.sql.derived.durationMs" raw={sqlDurationMs(info.row.original, now)} fmt="dur" className="whitespace-nowrap" />
        ),
      },
      {
        id: "running",
        enableSorting: false,
        meta: { label: "Running jobs" },
        header: "Running Jobs",
        cell: (info) => (
          <JobIdLinks appId={appId} ids={info.row.original.runningJobIds} field="spark.sql.runningJobIds" attempt={attempt} />
        ),
      },
      {
        id: "success",
        enableSorting: false,
        meta: { label: "Success jobs" },
        header: "Success Jobs",
        cell: (info) => (
          <JobIdLinks appId={appId} ids={info.row.original.successJobIds} field="spark.sql.successJobIds" attempt={attempt} />
        ),
      },
      {
        id: "failed",
        enableSorting: false,
        meta: { label: "Failed jobs" },
        header: "Failed Jobs",
        cell: (info) => <JobIdLinks appId={appId} ids={info.row.original.failedJobIds} field="spark.sql.failedJobIds" attempt={attempt} />,
      },
      {
        id: "errors",
        enableSorting: false,
        meta: { label: "Error" },
        header: "Errors",
        cell: (info) => {
          const msg = info.row.original.errorMessage;
          if (!msg) return <span className="text-ink-4">—</span>;
          return (
            <Link
              to="/apps/$appId/spark/sql/$executionId"
              params={{ appId, executionId: String(info.row.original.id) }}
              search={{ attempt: attempt ?? undefined }}
              hash="error"
              aria-label={msg}
              className="block min-w-0"
            >
              <Datum field="spark.sql.errorMessage" raw={msg} className="truncate text-fail">
                {msg.length > 60 ? `${msg.slice(0, 60)}…` : msg}
              </Datum>
            </Link>
          );
        },
      },
      {
        id: "plan",
        enableSorting: false,
        meta: { label: "Plan" },
        header: "Plan",
        cell: (info) => (
          <Link
            to="/apps/$appId/spark/sql/$executionId"
            params={{ appId, executionId: String(info.row.original.id) }}
            search={{ attempt: attempt ?? undefined }}
            hash="plan"
            className="inline-flex items-center gap-1 text-live underline-offset-2 hover:underline"
          >
            <ListTree className="size-3.5" aria-hidden="true" />
            <Datum field="spark.sql.planDescription" raw={info.row.original.planDescription}>
              Plan
            </Datum>
          </Link>
        ),
      },
    ],
    [appId, now, tz, attempt],
  );

  const firstRow = limit != null ? page * limit + 1 : 1;
  const lastRow = limit != null ? page * limit + rows.length : rows.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader title="SQL" hideTitle />
      {sqlQ.error && sqlQ.data !== undefined && (
        <SparkStaleErrorBanner error={sqlQ.error} subject="the SQL execution list" onRetry={() => void sqlQ.refetch()} />
      )}
      {sqlQ.isPending ? (
        <SparkLoading rows={8} cols={8} />
      ) : sqlQ.error && sqlQ.data === undefined ? (
        <SparkFailureState error={sqlQ.error} subject="the SQL execution list" onRetry={() => void sqlQ.refetch()} />
      ) : rows.length === 0 && limit == null ? (
        <SparkEmpty title="No SQL executions" />
      ) : (
        <DataTable<SparkSqlExecution>
          className="min-h-[24rem]"
          data={filtering}
          columns={columns}
          getRowId={(e) => String(e.id)}
          entityKey={(e) => String(e.id)}
          label="Spark SQL executions"
          storageKey="spark-sql"
          sorting={sorting}
          defaultSorting={SQL_DEFAULT_SORTING}
          onSortingChange={(s: SortingState) => patch(serializeSort(s))}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={(v) => patch(serializeColumns(v))}
          defaultVisibility={DEFAULT_VISIBILITY}
          onRowActivate={(e) =>
            void navigate({
              to: "/apps/$appId/spark/sql/$executionId",
              params: { appId, executionId: String(e.id) },
              search: { attempt: attempt ?? undefined },
            })
          }
          rowVersion={(e) => `${e.status}:${(e.runningJobIds ?? []).length}`}
          totalCount={rows.length}
          exportName={`spark-sql-${appId}`}
          toolbar={
            <>
              <Select
                label="SQL status filter"
                value={status ?? ""}
                onValueChange={(v) => patch({ status: v === "" ? undefined : v })}
                options={[
                  { value: "", label: "All statuses" },
                  { value: "COMPLETED", label: "Completed" },
                  { value: "RUNNING", label: "Running" },
                  { value: "FAILED", label: "Failed" },
                ]}
              />
              <label className="flex items-center gap-1.5 text-small text-ink-3">
                <span className="sr-only">Filter SQL executions</span>
                <input
                  type="search"
                  value={q}
                  onChange={(e) => patch({ q: e.target.value || undefined })}
                  placeholder="Filter description / id…"
                  className="h-(--ctl-h) w-52 rounded-md border border-seam-strong bg-well px-2 text-body text-ink placeholder:text-ink-4"
                />
              </label>
              <Select
                label="Rows per page"
                value={limit != null ? String(limit) : ""}
                onValueChange={setSize}
                options={[{ value: "", label: "All rows" }, ...PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} / page` }))]}
              />
              {limit != null && (
                <span className="flex items-center gap-1.5">
                  <Button variant="quiet" size="sm" disabled={page === 0} onClick={() => patch({ page: String(page - 1) })}>
                    ← Prev
                  </Button>
                  <span className="text-small text-ink-4 tnum">
                    {fmtInt(firstRow)}–{fmtInt(lastRow)}
                  </span>
                  <Button variant="quiet" size="sm" disabled={rows.length < limit} onClick={() => patch({ page: String(page + 1) })}>
                    Next →
                  </Button>
                </span>
              )}
              <span className="text-small text-ink-4">
                {filtering.length === rows.length ? (
                  <>{fmtInt(rows.length)} shown</>
                ) : (
                  <>
                    {fmtInt(filtering.length)} of {fmtInt(rows.length)}
                  </>
                )}
              </span>
            </>
          }
        />
      )}
    </div>
  );
}
