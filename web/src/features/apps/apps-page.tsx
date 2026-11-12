import { useQueryClient } from "@tanstack/react-query";
import { Boxes, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { q } from "~/api/queries";
import { useStableQuery } from "~/api/use-stable-query";
import type { App } from "~/api/schemas";
import { useConnection } from "~/api/connection";
import { useElementWidth } from "~/lib/size";
import { cn } from "~/lib/cn";
import { useParity } from "~/state/parity";
import { Button } from "~/ui/button";
import { DataTable } from "~/ui/data-table/data-table";
import { EmptyState, ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { Tab, TabsList, TabsRoot } from "~/ui/tabs";
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
import { computeFacets, filterApps, NO_FACETS, type Facets } from "./view";
import { describeError, simpleErrorText } from "~/lib/error-details";
import { expandWindow, initialWindow, nextWindow, viewKey, windowFilters, type AppWindowState } from "./window";

const EMPTY_APPS: App[] = [];
const DEFAULT_VISIBLE_IDS = new Set(["id", "name", "state", "user", "queue", "starttime", "progress"]);
const DEFAULT_VISIBILITY: Record<string, boolean> = Object.fromEntries(APPS_COLUMN_IDS.map((id) => [id, DEFAULT_VISIBLE_IDS.has(id)]));
const DEFAULT_HIDDEN = new Set(APPS_COLUMN_IDS.filter((id) => !DEFAULT_VISIBLE_IDS.has(id)));
const APPS_SCAN_ORDER = ["id", "name", "state", "finalstatus"];
const LEGACY_COLUMN_ORDER: string[] = [];
const APPS_COMPACT_CONTENT_WIDTH = 900;

export function columnsParam(visibility: Record<string, boolean>): string | undefined {
  const matchesDefault = APPS_COLUMN_IDS.every((id) => (visibility[id] ?? true) === DEFAULT_VISIBILITY[id]);
  return matchesDefault ? undefined : colsToParam(visibility);
}

function statesParam(tab: AppTabId): string | undefined {
  const spec = APP_TABS.find((t) => t.id === tab);
  return spec?.states ? spec.states.join(",") : undefined;
}

export function stateSelectionPatch(value: AppTabId | null): Partial<AppsSearch> | undefined {
  return value === null ? undefined : { states: statesParam(value) };
}

export function applyStateSelection(value: AppTabId | null, patch: Patch): void {
  const update = stateSelectionPatch(value);
  if (update) patch(update);
}

export function errorMessageView(message: string | undefined, renderVersion?: "pre" | "post") {
  if (!message) return undefined;
  const simple = simpleErrorText(message);
  return renderVersion === "pre" ? simple : <span className="wrap-break-word">{simple}</span>;
}

/**
 * `/apps` — the reference feature. One cached request feeds the tabs, the facets, the filters and the table; the URL is
 * the only state. Every cell is a `<Datum>` inside the row's `<Entity>` (the DataTable does the latter), so the parity
 * harness can read the whole table from the DOM.
 */
export type AppsPreviewState = "loaded" | "loading" | "unavailable";

export function AppsPage({
  search,
  patch: patchSearch,
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
  // A clear must cancel a pending name edit even when the URL's name was already absent.
  const [nameResetVersion, setNameResetVersion] = useState(0);
  const patch: Patch = (update) => {
    if ("name" in update && update.name === undefined) setNameResetVersion((version) => version + 1);
    patchSearch(update);
  };
  const [pageRef, pageWidth] = useElementWidth<HTMLDivElement>(0);
  const compact = pageWidth > 0 && pageWidth <= APPS_COMPACT_CONTENT_WIDTH;
  const now = useNow(15_000);
  const inReview = renderVersion !== undefined;
  const parityFull = parity && !inReview;
  const viewIdentity = viewKey(search);
  const [windowState, setWindowState] = useState<AppWindowState>(initialWindow);
  const [windowView, setWindowView] = useState(viewIdentity);
  if (windowView !== viewIdentity) {
    setWindowView(viewIdentity);
    setWindowState(initialWindow());
  }
  const windowQuery = useStableQuery({
    ...q.appsWindow({
      offset: windowState.offset,
      limit: windowState.limit,
      sort: search.sort ?? DEFAULT_SORT,
      filters: windowFilters(search),
    }),
    enabled: !inReview && !parity,
  });
  const fullQuery = useStableQuery({ ...q.apps(), enabled: parityFull });
  const queryClient = useQueryClient();
  const lastCache = useConnection((s) => s.lastCache);

  const reviewLoading = inReview && previewState === "loading";
  const reviewUnavailable = inReview && previewState === "unavailable";
  const windowData = windowQuery.data;
  const windowMeta = windowData?.window;
  const serverMode = !inReview && !parity && windowMeta !== undefined;
  const apps = inReview
    ? previewState === "loaded"
      ? (previewApps ?? EMPTY_APPS)
      : EMPTY_APPS
    : parity
      ? (fullQuery.data ?? EMPTY_APPS)
      : (windowData?.apps ?? EMPTY_APPS);
  const hasData = inReview ? previewState === "loaded" : parity ? fullQuery.data !== undefined : windowData !== undefined;
  const activeQuery = parity ? fullQuery : windowQuery;
  const initialLoading = inReview ? reviewLoading : activeQuery.isLoading && !hasData;
  const countsReady = inReview || parity || !serverMode || windowMeta!.ready;
  const facets = useMemo<Facets>(
    () => (serverMode && windowMeta ? windowMeta.facets : apps.length ? computeFacets(apps) : NO_FACETS),
    [apps, serverMode, windowMeta],
  );
  const rows = useMemo(() => (serverMode ? apps : filterApps(apps, search)), [apps, search, serverMode]);
  const sorting = useMemo(() => sortFromParam(search.sort), [search.sort]);
  const hidden = useMemo(() => (search.cols === undefined ? DEFAULT_HIDDEN : hiddenFromParam(search.cols)), [search.cols]);
  const visibility = useMemo(() => visibilityOf(APPS_COLUMN_IDS, hidden), [hidden]);
  const tab = tabOf(search.states);
  const hasCustomView = filterCount(search) > 0 || (search.sort !== undefined && search.sort !== DEFAULT_SORT) || search.cols !== undefined;
  const stale = !inReview && hasData && (serverMode && windowMeta ? windowMeta.stale : activeQuery.isError || lastCache === "stale");
  const totalCount = serverMode && windowMeta ? (windowMeta.total ?? windowMeta.filteredTotal) : apps.length;
  const filteredTotal = serverMode && windowMeta ? windowMeta.filteredTotal : rows.length;

  useEffect(() => {
    if (!serverMode || !windowMeta) return;
    setWindowState((state) => expandWindow(state, windowMeta.filteredTotal, windowMeta.ready));
  }, [serverMode, windowMeta]);
  const handleVisibleRange = useCallback(
    (start: number, end: number) => {
      setWindowState((state) => nextWindow(state, { start, end }, windowMeta!.filteredTotal));
    },
    [windowMeta?.filteredTotal],
  );
  const exportAll = useCallback(async () => {
    const all = await queryClient.fetchQuery(
      q.appsWindow({
        offset: 0,
        limit: Math.max(1, Math.min(totalCount, 10_000)),
        sort: search.sort ?? DEFAULT_SORT,
        filters: windowFilters(search),
      }),
    );
    return all.apps;
  }, [queryClient, search, totalCount]);

  const counts = useMemo(() => {
    const map = new Map<AppTabId, number>();
    for (const t of APP_TABS) map.set(t.id, t.states ? t.states.reduce((sum, s) => sum + (facets.byState[s] ?? 0), 0) : facets.total);
    return map;
  }, [facets]);
  const stateOptions = useMemo(
    () =>
      APP_TABS.map((t) => ({
        value: t.id,
        label: countsReady ? `${t.label} · ${counts.get(t.id)!.toLocaleString("en-US")}` : t.label,
      })),
    [counts, countsReady],
  );

  const error = reviewUnavailable
    ? {
        message: "Cannot reach the ResourceManager at http://resource-manager.example.internal:8088/ws/v1/cluster/apps",
        hint: "Check the configured ResourceManager address and network access, then retry the request.",
      }
    : inReview
      ? null
      : activeQuery.error;
  const describedError = error ? describeError(error) : null;

  return (
    <div ref={pageRef} className="burrow-scroll burrow-page-scroll burrow-apps-page flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-seam pb-3">
        <div className="min-w-0">
          <h1 className="text-h1 font-semibold text-ink text-balance">Applications</h1>
          <p className="mt-1 max-w-3xl text-pretty text-body text-ink-3">
            YARN state tracks the application lifecycle; final status is a separate outcome.
          </p>
        </div>
        {(hasCustomView ||
          stale ||
          (serverMode && windowMeta && !windowMeta.ready) ||
          (inReview && (hasData || (initialLoading && renderVersion === "pre")))) && (
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
            {serverMode && windowMeta && !windowMeta.ready && (
              <span className="text-ink-3" data-testid="apps-indexing">
                Indexing…
              </span>
            )}
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
              applyStateSelection(value as AppTabId | null, patch);
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
                badge={countsReady ? counts.get(t.id)!.toLocaleString("en-US") : undefined}
                field={`app.tab.${t.id}`}
              >
                {t.label}
              </Tab>
            ))}
          </TabsList>
        </TabsRoot>
      )}

      {(initialLoading || (hasData && (apps.length > 0 || (serverMode && countsReady)))) && (
        <div className="flex min-h-6 flex-wrap items-center gap-1.5 max-sm:min-h-12" aria-busy={initialLoading || undefined}>
          <span className="mr-1 inline-flex items-center gap-1 text-small font-medium text-ink-2">
            Final outcome
            <HelpTip label="Final outcome">The ApplicationMaster reports final status. Not set means no outcome has been reported.</HelpTip>
          </span>
          {initialLoading || (!countsReady && serverMode) ? (
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

      <div data-page-motion="content" className="flex min-h-0 flex-1 flex-col">
        {activeQuery.error && hasData && !inReview && (
          <StaleErrorBanner
            title={
              apps.length > 0
                ? "Applications refresh failed; showing the last loaded rows"
                : "Applications refresh failed; showing the last loaded result"
            }
            error={activeQuery.error}
            onRetry={() => void activeQuery.refetch()}
          />
        )}
        <DataTable
          data={rows}
          contentIdentity={`applications:${tab}`}
          columns={APPS_COLUMNS}
          columnOrder={parity || search.cols === "all" ? LEGACY_COLUMN_ORDER : APPS_SCAN_ORDER}
          toolbar={
            <AppFilters
              search={search}
              facets={facets}
              patch={patch}
              now={now}
              nameResetVersion={nameResetVersion}
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
          manualSorting={serverMode}
          rowCount={serverMode && windowMeta ? windowMeta.filteredTotal : undefined}
          rowOffset={serverMode && windowMeta ? windowMeta.offset : undefined}
          preserveScrollAnchor={serverMode}
          onVisibleRangeChange={serverMode ? handleVisibleRange : undefined}
          scrollResetKey={serverMode ? viewIdentity : undefined}
          exportAll={serverMode ? exportAll : undefined}
          totalCount={totalCount}
          loading={initialLoading}
          error={
            error && !hasData ? (
              <ErrorState
                title="Cannot load applications"
                error={activeQuery.error}
                message={errorMessageView(describedError?.message, renderVersion)}
                hint={errorMessageView(describedError?.hint, renderVersion)}
                onRetry={() => void activeQuery.refetch()}
                className={renderVersion === "pre" ? undefined : "max-w-lg min-w-0"}
              />
            ) : undefined
          }
          empty={
            serverMode && windowMeta && !windowMeta.ready && filteredTotal === 0 ? (
              <EmptyState title="Indexing applications" icon={<Boxes className="size-5" aria-hidden="true" />}>
                The first matching page is on its way; the complete list is still loading.
              </EmptyState>
            ) : totalCount === 0 ? (
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
      </div>
    </div>
  );
}
