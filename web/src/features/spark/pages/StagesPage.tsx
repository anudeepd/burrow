/**
 * Spark stages list — the native replacement for `/stages/` in Spark's tracking UI.
 *
 * Default: one row per stage **attempt**, which is what Spark's REST `/stages` returns (a retried stage appears several
 * times). `?agg=1` groups by stage id and shows the latest attempt with an attempt picker — Spark's UI does the same with
 * its "aggregated" view. Status filtering happens through the REST `status` parameter; the text filter is client-side.
 *
 * Task-aggregate metrics come from Spark only when the stage actually has task metrics; a skipped/reused stage reports
 * zeros or nothing, and those cells render as "—" rather than a fabricated number.
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";
import { fmtInt } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import { Select } from "~/ui/select";
import { Switch } from "~/ui/toggles";
import { sp } from "../data/queries";
import type { SparkStage } from "../data/schemas";
import { boolParam, compact, matchesQuery, parseColumns, parseSort, serializeColumns, serializeSort, strParam } from "../data/search";
import { PageHeader } from "../ui/PageHeader";
import { SparkEmpty, SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { stageColumns } from "../ui/StageTable";
import { useSpark } from "../ui/context";
import { useNow } from "../ui/use-now";

const route = getRouteApi("/apps/$appId/spark/stages/");

const STAGE_STATUSES = ["ACTIVE", "COMPLETE", "FAILED", "PENDING", "SKIPPED"] as const;

const DEFAULT_VISIBILITY = {
  status: true,
  name: true,
  submitted: true,
  duration: true,
  tasks: true,
  progress: true,
  failureReason: true,
  spill: true,
  jvmGcTime: true,
};

export function StagesPage() {
  const { appId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind, attempt } = useSpark();
  const now = useNow();
  const tz = usePref("tz");

  const status = strParam(search.status);
  const q = strParam(search.q) ?? "";
  const grouped = boolParam(search.agg) === true;

  const qStages = useQuery(sp.stages(appId, { status, kind, attempt }));
  const stages = useMemo(() => qStages.data ?? [], [qStages.data]);

  const matching = useMemo(
    () => (q ? stages.filter((s) => matchesQuery([s.stageId, s.name, s.description, s.status], q)) : stages),
    [stages, q],
  );

  const attemptsByStage = useMemo(() => {
    const m = new Map<number, SparkStage[]>();
    for (const s of stages) {
      const list = m.get(s.stageId);
      if (list) list.push(s);
      else m.set(s.stageId, [s]);
    }
    for (const list of m.values()) list.sort((a, b) => (a.attemptId ?? 0) - (b.attemptId ?? 0));
    return m;
  }, [stages]);

  const rows = useMemo(() => {
    if (!grouped) return matching;
    const latest = new Map<number, SparkStage>();
    for (const s of matching) {
      const cur = latest.get(s.stageId);
      if (!cur || (s.attemptId ?? 0) > (cur.attemptId ?? 0)) latest.set(s.stageId, s);
    }
    return [...latest.values()].sort((a, b) => a.stageId - b.stageId);
  }, [matching, grouped]);

  const sorting = parseSort(search);
  const columnVisibility = parseColumns(search);
  const patch = (p: Record<string, unknown>) => void navigate({ search: (prev) => compact({ ...prev, ...p }) });

  const columns = useMemo<ColDef<SparkStage>[]>(() => {
    const base = stageColumns({ appId, now, tz, attempt, showAttempt: true, showAdvanced: true, showFailureReason: true });
    if (!grouped) return base;
    return [
      ...base,
      {
        id: "attemptPicker",
        enableSorting: false,
        meta: { label: "Switch attempt" },
        header: "Switch attempt",
        cell: (info) => {
          const s = info.row.original;
          const list = attemptsByStage.get(s.stageId) ?? [];
          if (list.length <= 1) return <span className="text-ink-4">—</span>;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only stop for the row-click; the Select trigger itself is focusable and keyboard-operable.
            <span onClick={(e) => e.stopPropagation()}>
              <Select
                label={`Attempts of stage ${s.stageId}`}
                value={String(s.attemptId ?? 0)}
                onValueChange={(v) => {
                  if (v) {
                    void navigate({
                      to: "/apps/$appId/spark/stages/$stageId/$attemptId",
                      params: { appId, stageId: String(s.stageId), attemptId: v },
                      search: { attempt: attempt ?? undefined },
                    });
                  }
                }}
                options={list.map((a) => ({ value: String(a.attemptId ?? 0), label: `Attempt ${a.attemptId ?? 0} · ${a.status ?? "?"}` }))}
              />
            </span>
          );
        },
      },
      {
        id: "attemptCount",
        accessorFn: (s) => attemptsByStage.get(s.stageId)?.length ?? 1,
        sortFn: "basic",
        meta: { label: "Attempts", align: "end", exportValue: (s: SparkStage) => attemptsByStage.get(s.stageId)?.length ?? 1 },
        header: "Attempts",
        cell: (info) => (
          <Datum
            field="spark.stage.derived.attemptCount"
            raw={attemptsByStage.get(info.row.original.stageId)?.length ?? 1}
            fmt="int"
            className="tnum"
          />
        ),
      },
    ];
  }, [appId, now, tz, attempt, grouped, attemptsByStage, navigate]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader title="Stages" hideTitle />

      {qStages.error && qStages.data !== undefined && (
        <SparkStaleErrorBanner error={qStages.error} subject="the stage list" onRetry={() => void qStages.refetch()} />
      )}
      {qStages.isPending ? (
        <SparkLoading rows={12} cols={9} />
      ) : qStages.error && qStages.data === undefined ? (
        <SparkFailureState error={qStages.error} subject="the stage list" onRetry={() => void qStages.refetch()} />
      ) : stages.length === 0 ? (
        <SparkEmpty title={status ? `No ${status.toLowerCase()} stages` : "No stages yet"}>
          {status ? "Clear the status filter to see every stage." : "Stages appear as soon as a job schedules them."}
        </SparkEmpty>
      ) : (
        <DataTable<SparkStage>
          className="min-h-[24rem]"
          data={rows}
          columns={columns}
          getRowId={(s) => (grouped ? String(s.stageId) : `${s.stageId}/${s.attemptId ?? 0}`)}
          entityKey={(s) => `${s.stageId}/${s.attemptId ?? 0}`}
          label="Spark stages"
          storageKey="spark-stages"
          sorting={sorting}
          onSortingChange={(s: SortingState) => patch(serializeSort(s))}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={(v) => patch(serializeColumns(v))}
          defaultVisibility={DEFAULT_VISIBILITY}
          onRowActivate={(s) =>
            void navigate({
              to: "/apps/$appId/spark/stages/$stageId/$attemptId",
              params: { appId, stageId: String(s.stageId), attemptId: String(s.attemptId ?? 0) },
              search: { attempt: attempt ?? undefined },
            })
          }
          rowVersion={(s) => `${s.status}:${s.numActiveTasks ?? 0}:${s.numCompleteTasks ?? 0}`}
          totalCount={stages.length}
          exportName={`spark-stages-${appId}`}
          toolbar={
            <>
              <Select
                label="Stage status filter"
                value={status ?? ""}
                onValueChange={(v) => patch({ status: v === "" ? undefined : v })}
                options={[
                  { value: "", label: "All statuses" },
                  ...STAGE_STATUSES.map((s): { value: string; label: string } => ({
                    value: s,
                    label: s.charAt(0) + s.slice(1).toLowerCase(),
                  })),
                ]}
              />
              <label className="flex items-center gap-1.5 text-small text-ink-3">
                <span className="sr-only">Filter stages by id, name or description</span>
                <input
                  type="search"
                  value={q}
                  onChange={(e) => patch({ q: e.target.value || undefined })}
                  placeholder="Filter id / name…"
                  className="h-(--ctl-h) w-52 rounded-md border border-seam-strong bg-well px-2 text-body text-ink placeholder:text-ink-4"
                />
              </label>
              <span className="flex items-center gap-1.5 text-small text-ink-3">
                <Switch
                  checked={grouped}
                  onCheckedChange={(v) => patch({ agg: v ? "1" : undefined })}
                  label="Group attempts of the same stage"
                />
                <span>One row per stage</span>
              </span>
              <span className="text-small text-ink-4">
                {rows.length === stages.length ? (
                  <>{fmtInt(rows.length)} shown</>
                ) : (
                  <>
                    {fmtInt(rows.length)} of {fmtInt(stages.length)}
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
