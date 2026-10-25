import { useQuery } from "@tanstack/react-query";
import { Boxes, RotateCw } from "lucide-react";
import { useMemo } from "react";
import { q } from "~/api/queries";
import type { App } from "~/api/schemas";
import { useConnection } from "~/api/connection";
import { useElementWidth } from "~/lib/size";
import { cn } from "~/lib/cn";
import { useParity } from "~/state/parity";
import { Button } from "~/ui/button";
import { DataTable } from "~/ui/data-table/data-table";
import { EmptyState, ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { Tab, TabContent, TabsList, TabsRoot } from "~/ui/tabs";
import { Toggle } from "~/ui/toggles";
import { Select } from "~/ui/select";
import { HelpTip, Tooltip } from "~/ui/tooltip";
import { APPS_COLUMNS, APPS_COLUMN_IDS } from "./columns";
import { AppFilters, type Patch } from "./filters";
import {
  APP_TABS,
  DEFAULT_SORT,
  DEFAULT_SORTING,
  colsToParam,
  filterCount,
  finalStatusLabel,
  hiddenFromParam,
  sortFromParam,
  sortToParam,
  tabOf,
  visibilityOf,
  type AppTabId,
  type AppsSearch,
} from "./search";
import { useNow } from "~/features/shell/use-now";
import { computeFacets, filterApps, NO_FACETS } from "./view";

const EMPTY_APPS: App[] = [];
const DEFAULT_VISIBLE_IDS = new Set(["id", "name", "state", "user", "queue", "starttime", "progress"]);
const DEFAULT_VISIBILITY: Record<string, boolean> = Object.fromEntries(APPS_COLUMN_IDS.map((id) => [id, DEFAULT_VISIBLE_IDS.has(id)]));
const DEFAULT_HIDDEN = new Set(APPS_COLUMN_IDS.filter((id) => !DEFAULT_VISIBLE_IDS.has(id)));
const APPS_SCAN_ORDER = ["id", "name", "state", "finalstatus"];
const LEGACY_COLUMN_ORDER: string[] = [];
const APPS_COMPACT_CONTENT_WIDTH = 900;

function columnsParam(visibility: Record<string, boolean>): string | undefined {
  const matchesDefault = APPS_COLUMN_IDS.every((id) => (visibility[id] ?? true) === DEFAULT_VISIBILITY[id]);
  return matchesDefault ? undefined : colsToParam(visibility);
}

function statesParam(tab: AppTabId): string | undefined {
  const spec = APP_TABS.find((t) => t.id === tab);
  return spec?.states ? spec.states.join(",") : undefined;
}

/**
 * `/apps` — the reference feature. One cached request feeds the tabs, the facets, the filters and the table; the URL is
 * the only state. Every cell is a `<Datum>` inside the row's `<Entity>` (the DataTable does the latter), so the parity
 * harness can read the whole table from the DOM.
 */
export type AppsPreviewState = "loaded" | "loading" | "unavailable";

export function AppsPage({
  search,
  patch,
  onOpenApp,
  renderVersion,
  previewState = "loaded",
  previewApps,
}: {
  search: AppsSearch;
  patch: Patch;
  onOpenApp: (appId: string) => void;
  renderVersion?: "pre" | "post";
  previewState?: AppsPreviewState;
  previewApps?: App[];
}) {
  const parity = useParity();
  const [pageRef, pageWidth] = useElementWidth<HTMLDivElement>(0);
  const compact = pageWidth > 0 && pageWidth <= APPS_COMPACT_CONTENT_WIDTH;
  const now = useNow(15_000);
  const inReview = renderVersion !== undefined;
  const appsQuery = useQuery({ ...q.apps(), enabled: !inReview });
  const lastCache = useConnection((s) => s.lastCache);

  const reviewLoading = inReview && previewState === "loading";
  const reviewUnavailable = inReview && previewState === "unavailable";
  const apps = inReview ? (previewState === "loaded" ? (previewApps ?? EMPTY_APPS) : EMPTY_APPS) : (appsQuery.data ?? EMPTY_APPS);
  const hasData = inReview ? previewState === "loaded" : appsQuery.data !== undefined;
  const initialLoading = inReview ? reviewLoading : appsQuery.isLoading && !hasData;
  const loading = inReview ? reviewLoading : appsQuery.isLoading;
  const facets = useMemo(() => (apps.length ? computeFacets(apps) : NO_FACETS), [apps]);
  const rows = useMemo(() => filterApps(apps, search), [apps, search]);
  const sorting = useMemo(() => sortFromParam(search.sort), [search.sort]);
  const hidden = useMemo(() => (search.cols === undefined ? DEFAULT_HIDDEN : hiddenFromParam(search.cols)), [search.cols]);
  const visibility = useMemo(() => visibilityOf(APPS_COLUMN_IDS, hidden), [hidden]);
  const tab = tabOf(search.states);
  const hasCustomView = filterCount(search) > 0 || (search.sort !== undefined && search.sort !== DEFAULT_SORT) || search.cols !== undefined;
  const stale = !inReview && hasData && (appsQuery.isError || lastCache === "stale");

  const counts = useMemo(() => {
    const map = new Map<AppTabId, number>();
    for (const t of APP_TABS) map.set(t.id, t.states ? t.states.reduce((sum, s) => sum + (facets.byState[s] ?? 0), 0) : facets.total);
    return map;
  }, [facets]);
  const stateOptions = useMemo(
    () =>
      APP_TABS.map((t) => ({
        value: t.id,
        label: hasData ? `${t.label} · ${(counts.get(t.id) ?? 0).toLocaleString("en-US")}` : t.label,
      })),
    [counts, hasData],
  );

  const error = reviewUnavailable
    ? {
        message: "Cannot reach the ResourceManager at http://resource-manager.example.internal:8088/ws/v1/cluster/apps",
        hint: "Check the configured ResourceManager address and network access, then retry the request.",
      }
    : inReview
      ? null
      : (appsQuery.error as { message?: string; hint?: string | null } | null);

  return (
    <div ref={pageRef} className="burrow-scroll burrow-page-scroll burrow-apps-page flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-seam pb-3">
        <div className="min-w-0">
          <h1 className="text-h1 font-semibold text-ink text-balance">Applications</h1>
          <p className="mt-1 max-w-3xl text-pretty text-body text-ink-3">
            YARN state tracks the application lifecycle; final status is a separate outcome.
          </p>
        </div>
        {(hasCustomView || stale || (inReview && (hasData || (initialLoading && renderVersion === "pre")))) && (
          <div className="ml-auto inline-flex min-h-7 shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 text-small text-ink-3">
            {hasCustomView && (
              <Button
                size="sm"
                variant="quiet"
                onClick={() =>
                  patch({
                    states: undefined,
                    final: undefined,
                    user: undefined,
                    queue: undefined,
                    type: undefined,
                    tag: undefined,
                    name: undefined,
                    startedAfter: undefined,
                    startedBefore: undefined,
                    finishedAfter: undefined,
                    finishedBefore: undefined,
                    sort: undefined,
                    cols: undefined,
                  })
                }
              >
                Reset view
              </Button>
            )}
            {stale && (
              <Tooltip label="The ResourceManager did not answer; these rows are the last data Burrow received">
                <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklch,var(--warn)_45%,transparent)] bg-[color-mix(in_oklch,var(--warn)_12%,transparent)] px-2 text-micro text-warn">
                  <RotateCw className="size-3" aria-hidden="true" />
                  stale
                </span>
              </Tooltip>
            )}
            {inReview && hasData && <span className="text-ink-3">Sample data</span>}
            {inReview && initialLoading && renderVersion === "pre" && <span>Loading…</span>}
          </div>
        )}
      </div>

      {compact ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-small font-medium text-ink-2">Lifecycle state</span>
          <Select
            label="Lifecycle state"
            value={tab}
            options={stateOptions}
            onValueChange={(value) => {
              if (value !== null) patch({ states: statesParam(value) });
            }}
            className="min-w-0 flex-1"
          />
        </div>
      ) : (
        <TabsRoot value={tab} onValueChange={(v) => patch({ states: statesParam(v as AppTabId) })}>
          <TabsList label="Lifecycle state" overflowFade>
            {APP_TABS.map((t) => (
              <Tab
                key={t.id}
                value={t.id}
                badge={hasData ? (counts.get(t.id) ?? 0).toLocaleString("en-US") : undefined}
                field={`app.tab.${t.id}`}
              >
                {t.label}
              </Tab>
            ))}
          </TabsList>
        </TabsRoot>
      )}

      {(initialLoading || (hasData && apps.length > 0)) && (
        <div className="flex min-h-6 flex-wrap items-center gap-1.5 max-sm:min-h-12" aria-busy={initialLoading || undefined}>
          <span className="mr-1 inline-flex items-center gap-1 text-small font-medium text-ink-2">
            Final outcome
            <HelpTip label="Final outcome">The ApplicationMaster reports final status. Not set means no outcome has been reported.</HelpTip>
          </span>
          {initialLoading ? (
            <Skeleton className="h-6 w-64 max-w-full" />
          ) : (
            (["UNDEFINED", "SUCCEEDED", "FAILED", "KILLED", "ENDED"] as const).map((status) => {
              const count = facets.byFinal[status] ?? 0;
              if (count === 0 && search.final !== status) return null;
              const label = finalStatusLabel(status);
              return (
                <Toggle
                  key={status}
                  pressed={search.final === status}
                  onPressedChange={(pressed) => patch({ final: pressed ? status : undefined })}
                  label={`Filter by final status: ${label}`}
                  className={cn("h-6 px-2 text-micro", search.final === status && "border-seam bg-fabric-3 text-ink")}
                >
                  {label} <span className="text-ink-3 tnum">{count.toLocaleString("en-US")}</span>
                </Toggle>
              );
            })
          )}
        </div>
      )}

      <TabContent value={tab} className="flex min-h-0 flex-1 flex-col">
        {appsQuery.error && hasData && !inReview && (
          <StaleErrorBanner
            title={
              apps.length > 0
                ? "Applications refresh failed; showing the last loaded rows"
                : "Applications refresh failed; showing the last loaded result"
            }
            error={appsQuery.error}
            onRetry={() => void appsQuery.refetch()}
          />
        )}
        <DataTable
          data={rows}
          columns={APPS_COLUMNS}
          columnOrder={parity || search.cols === "all" ? LEGACY_COLUMN_ORDER : APPS_SCAN_ORDER}
          toolbar={
            <AppFilters
              search={search}
              facets={facets}
              patch={patch}
              now={now}
              compact={compact}
              showLegacyFinishedLabel={renderVersion === "pre"}
            />
          }
          getRowId={(app) => app.id}
          entityKey={(app) => app.id}
          label="Applications"
          storageKey="apps"
          sorting={sorting}
          onSortingChange={(s) => patch({ sort: sortToParam(s) })}
          defaultSorting={DEFAULT_SORTING}
          columnVisibility={visibility}
          onColumnVisibilityChange={(v) => patch({ cols: columnsParam(v) })}
          defaultVisibility={DEFAULT_VISIBILITY}
          onRowActivate={(app) => onOpenApp(app.id)}
          totalCount={apps.length}
          loading={loading}
          error={
            error && !hasData ? (
              <ErrorState
                title="Cannot load applications"
                message={
                  error.message ? renderVersion === "pre" ? error.message : <span className="break-words">{error.message}</span> : undefined
                }
                hint={error.hint ? renderVersion === "pre" ? error.hint : <span className="break-words">{error.hint}</span> : undefined}
                onRetry={() => void appsQuery.refetch()}
                className={renderVersion === "pre" ? undefined : "max-w-lg min-w-0"}
              />
            ) : undefined
          }
          empty={
            apps.length === 0 ? (
              <EmptyState title="No applications" icon={<Boxes className="size-5" aria-hidden="true" />}>
                The ResourceManager reported no applications at all.
              </EmptyState>
            ) : (
              <EmptyState
                title="No applications match these filters"
                action={
                  <Button
                    onClick={() =>
                      patch({
                        states: undefined,
                        final: undefined,
                        user: undefined,
                        queue: undefined,
                        type: undefined,
                        tag: undefined,
                        name: undefined,
                        startedAfter: undefined,
                        startedBefore: undefined,
                        finishedAfter: undefined,
                        finishedBefore: undefined,
                      })
                    }
                  >
                    Clear filters
                  </Button>
                }
              >
                {parity ? "Parity mode keeps the URL filters; clear them to see every row." : "Relax a filter to widen the view."}
              </EmptyState>
            )
          }
          exportName="Burrow-applications"
        />
      </TabContent>
    </div>
  );
}
