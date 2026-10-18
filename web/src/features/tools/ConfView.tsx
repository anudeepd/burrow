/**
 * `/tools/conf` — the daemon configuration page (legacy YARN "Tools → Configuration").
 *
 * The RM (or, with `?host=`, a NodeManager) dumps every property it loaded: 1 709 of them for the RM, ~205 KB of JSON.
 * `DataTable` virtualizes that, filters + sort + visible columns + the expanded property all live in the URL, and every
 * cell that shows an upstream datum goes through `<Datum>` (entity `conf`, key = the property name).
 *
 * There is no defaults endpoint to diff against, so the page states exactly what "overridden" means here and colours it:
 * a property loaded from a `*-site.xml` (or set programmatically) is overridden; everything else is a Hadoop default.
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ArrowLeft, ArrowUpRight, CircleHelp, Lock, RotateCw, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { nq } from "~/api/queries/nodes";
import { tq } from "~/api/queries/tools";
import type { ConfProperty } from "~/api/schemas";
import { CopyButton, FieldLabel, PageHead, SearchField, Stat } from "~/features/nodes/page";
import { formatCols, formatSort, parseCols, parseSort } from "~/features/nodes/search";
import { cn } from "~/lib/cn";
import { CenteredPageState, EmptyState, ErrorState, StaleErrorBanner } from "~/ui/feedback";
import { useParity } from "~/state/parity";
import { BurrowCapabilities } from "~/features/tools/BurrowCapabilities";
import { revealDetail } from "~/lib/reveal";
import { ACTION_LINK_CLASS, Button } from "~/ui/button";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum, Entity } from "~/ui/datum";
import { Select } from "~/ui/select";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "~/ui/popover";
import { Toggle } from "~/ui/toggles";
import {
  confMatches,
  confRowVersion,
  isOverridden,
  isRedacted,
  lineCount,
  NO_VIEW,
  REDACTED,
  resourceFacets,
  resourceKind,
  resourceName,
  summarizeConf,
  usedIn,
} from "./conf";
import { OptionalTooltip, Tooltip } from "~/ui/tooltip";

const route = getRouteApi("/tools/conf");

/** The "$" default sort: a 1 709-row dump is only usable sorted by name. */
const DEFAULT_SORT = [{ id: "key", desc: false }];
const DEFAULT_VISIBILITY: Record<string, boolean> = { key: true, value: true, resource: true, final: true, used: true };

const CHIP =
  "inline-flex max-w-full items-center gap-1 rounded-full border border-seam-strong bg-well px-1.5 text-micro text-ink-2 hover:text-live";
const BADGE = "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-micro";
const OVERRIDDEN_TINT = "bg-[color-mix(in_oklch,var(--live)_8%,transparent)]";

function Badge({ tone, children, title }: { tone: "live" | "ink" | "fail" | "warn"; children: React.ReactNode; title?: string }) {
  return (
    <OptionalTooltip label={title}>
      <span
        className={cn(
          BADGE,
          tone === "live" && "border-[color-mix(in_oklch,var(--live)_35%,transparent)] text-live",
          tone === "ink" && "border-seam-strong text-ink-4",
          tone === "warn" && "border-[color-mix(in_oklch,var(--warn)_35%,transparent)] text-warn",
          tone === "fail" && "border-[color-mix(in_oklch,var(--fail)_35%,transparent)] text-fail",
        )}
      >
        {children}
      </span>
    </OptionalTooltip>
  );
}

/** Property key: the row's left accent + tint mark an overridden value, and carry its badge. */
function KeyCell({ p, selected }: { p: ConfProperty; selected: boolean }) {
  const over = isOverridden(p);
  return (
    <span className={cn("relative flex min-w-0 items-center gap-1.5 py-0.5", over && OVERRIDDEN_TINT)}>
      {over && <span aria-hidden="true" className="absolute inset-y-0 left-[calc(var(--cell-px)*-1)] w-[3px] rounded-full bg-live" />}
      <Datum
        field="conf.key"
        raw={p.key}
        fmt="text"
        className={cn(
          "truncate font-mono text-small transition-colors duration-(--dur-fast) ease-(--ease-out)",
          selected ? "text-live" : "text-ink",
        )}
        title={p.key}
      >
        {p.key}
      </Datum>
      {over && (
        <Badge tone="live" title={`overridden: loaded from ${resourceName(p)}`}>
          overridden
        </Badge>
      )}
    </span>
  );
}

function ValueCell({ p }: { p: ConfProperty }) {
  const redacted = isRedacted(p);
  const lines = lineCount(p.value);
  const first = (p.value ?? "").trim().split("\n")[0] ?? "";
  return (
    <Datum
      field="conf.value"
      raw={p.value}
      fmt="text"
      className={cn("flex min-w-0 items-center gap-1.5 text-small", redacted ? "text-ink-4 italic" : "font-mono text-ink-2")}
      title={p.value ?? ""}
    >
      <span className="truncate">{first || "—"}</span>
      {lines > 1 && (
        <Badge tone="ink" title={`${lines} lines — open the row for the full value`}>
          {lines} lines
        </Badge>
      )}
      {redacted && (
        <Badge tone="warn" title="Hadoop masks sensitive keys in the dump">
          {REDACTED}
        </Badge>
      )}
    </Datum>
  );
}

function confColumns(selectedKey: string | undefined): ColDef<ConfProperty>[] {
  return [
    {
      id: "key",
      accessorFn: (p) => p.key,
      size: 190,
      meta: { label: "Property", pinned: true, exportValue: (p) => (p as ConfProperty).key },
      cell: ({ row }) => <KeyCell p={row.original} selected={row.original.key === selectedKey} />,
    },
    {
      id: "value",
      accessorFn: (p) => p.value ?? "",
      size: 170,
      meta: { label: "Value", exportValue: (p) => (p as ConfProperty).value },
      cell: ({ row }) => <ValueCell p={row.original} />,
    },
    {
      id: "resource",
      accessorFn: (p) => resourceName(p),
      size: 190,
      meta: {
        label: "Source",
        hint: "the file the daemon loaded this value from (or `programmatically`)",
        exportValue: (p) => (p as ConfProperty).resource,
      },
      cell: ({ row }) => (
        <Datum
          field="conf.resource"
          raw={row.original.resource}
          fmt="text"
          className={cn("truncate text-small", resourceKind(row.original.resource) === "unknown" ? "text-ink-4" : "text-ink-2")}
          title={resourceName(row.original)}
        >
          {resourceName(row.original)}
        </Datum>
      ),
    },
    {
      id: "final",
      accessorFn: (p) => (p.isFinal ? 1 : 0),
      size: 92,
      meta: {
        label: "Final",
        hint: "declared <final> in a site file: locked, and it cannot be overridden further",
        exportValue: (p) => (p as ConfProperty).isFinal,
      },
      cell: ({ row }) =>
        row.original.isFinal ? (
          <Datum field="conf.isFinal" raw={true} fmt="text" className="flex items-center gap-1 text-small text-warn">
            <Lock className="size-3" aria-hidden="true" />
            final
          </Datum>
        ) : (
          <Datum field="conf.isFinal" raw={false} fmt="text" className="text-small text-ink-4">
            —
          </Datum>
        ),
    },
    {
      id: "used",
      accessorFn: (p) => usedIn(p.key)?.label ?? "",
      size: 140,
      meta: {
        label: "Used in the UI",
        hint: "the Burrow view that renders this key (curated; empty when nothing does)",
        exportValue: (p) => usedIn((p as ConfProperty).key)?.to ?? null,
      },
      cell: ({ row }) => {
        const used = usedIn(row.original.key);
        if (!used) return null;
        return (
          <OptionalTooltip label={`affects the ${used.label} view — ${used.why}`}>
            <a href={used.to} className={CHIP} onClick={(e) => e.stopPropagation()}>
              <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{used.label}</span>
            </a>
          </OptionalTooltip>
        );
      },
    },
  ];
}

/** The expanded property (`?open=<key>`): full value, still unformatted, with copy affordances. */
function PropertyDetail({ p, host, onClose }: { p: ConfProperty; host: string | undefined; onClose: () => void }) {
  const used = usedIn(p.key);
  const noView = NO_VIEW[p.key];
  const lines = lineCount(p.value);
  return (
    <Entity
      id={p.key}
      data-burrow-conf-detail={p.key}
      data-burrow-detail="1"
      // selecting a row mounts this pane: it arrives with a 4px rise instead of appearing mid-list (the grid change
      // itself stays instant — animating grid-template-columns would re-lay the table out on every frame)
      className="burrow-enter flex min-h-0 flex-col gap-3 self-start rounded-lg border border-seam bg-fabric p-3 xl:sticky xl:top-0 xl:max-h-[calc(100dvh-8rem)] xl:overflow-auto"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-micro uppercase tracking-wide text-ink-4">Property</div>
          <div className="mt-0.5 flex min-w-0 items-start gap-1">
            <Datum field="conf.key" raw={p.key} fmt="text" className="min-w-0 break-all font-mono text-small text-ink">
              {p.key}
            </Datum>
            <CopyButton value={p.key} label="Copy the property name" />
          </div>
        </div>
        <Button variant="quiet" size="icon-sm" aria-label="Close the property detail" title="Close property details" onClick={onClose}>
          <X className="size-3.5" aria-hidden="true" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {isOverridden(p) ? (
          <Badge tone="live">overridden</Badge>
        ) : (
          <Badge tone="ink" title="came from a Hadoop default file">
            hadoop default
          </Badge>
        )}
        {p.isFinal && (
          <Badge tone="warn">
            <Lock className="size-3" aria-hidden="true" />
            final
          </Badge>
        )}
        {isRedacted(p) && <Badge tone="warn">redacted by Hadoop</Badge>}
        {used && (
          <OptionalTooltip label={`affects the ${used.label} view — ${used.why}`}>
            <a href={used.to} className={CHIP}>
              <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
              {used.label}
            </a>
          </OptionalTooltip>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-3 text-small">
        <div className="min-w-0">
          <dt className="text-micro uppercase tracking-wide text-ink-4">Source</dt>
          <dd>
            <Datum field="conf.resource" raw={p.resource} fmt="text" className="break-all text-ink-2">
              {resourceName(p)}
            </Datum>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro uppercase tracking-wide text-ink-4">Value size</dt>
          <dd className="text-ink-2 tnum">
            {p.value ? `${p.value.length} chars` : "—"}
            {lines > 1 && ` · ${lines} lines`}
          </dd>
        </div>
      </dl>

      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <FieldLabel>Value as the daemon dumped it</FieldLabel>
          <CopyButton value={p.value ?? ""} label="Copy the value" />
        </div>
        <Datum
          field="conf.value"
          raw={p.value}
          fmt="text"
          as="pre"
          className="burrow-scroll max-h-72 overflow-auto rounded-md border border-seam bg-well p-2 font-mono text-small whitespace-pre-wrap break-words text-ink"
        />
      </div>

      {(noView || host) && (
        <p className="text-micro text-ink-4" role="note">
          {noView && `${p.key} — ${noView}.`}
          {noView && host && " "}
          {host && "Read from the NodeManager."}
        </p>
      )}
    </Entity>
  );
}

export function ConfView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const parity = useParity();
  const host = search.host;

  const rmConf = useQuery({ ...tq.conf(), enabled: !host });
  const nmConf = useQuery({
    ...nq.nmConf(host ?? "-"),
    enabled: !!host,
    select: (r: { properties: ConfProperty[] }): ConfProperty[] => r.properties,
  });
  // Both queries answer with the same shape, so the page reads one set of flags whichever daemon it is pointed at.
  const properties = (host ? nmConf.data : rmConf.data) ?? [];
  const isPending = host ? nmConf.isPending : rmConf.isPending;
  const error = host ? nmConf.error : rmConf.error;
  const hasData = (host ? nmConf.data : rmConf.data) !== undefined;
  const reload = host ? () => void nmConf.refetch() : () => void rmConf.refetch();

  const setSearch = (patch: Partial<typeof search>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  const summary = useMemo(() => summarizeConf(properties), [properties]);
  const facets = useMemo(() => resourceFacets(properties), [properties]);
  const rows = useMemo(
    () =>
      properties.filter((p) =>
        confMatches(p, { q: search.q, overridden: search.overridden, final: search.final, resource: search.resource }),
      ),
    [properties, search.q, search.overridden, search.final, search.resource],
  );

  const parsedSort = parseSort(search.sort);
  const sorting = parsedSort.length ? parsedSort : DEFAULT_SORT;
  const visibility = parseCols(search.cols) ?? DEFAULT_VISIBILITY;

  const openKey = search.open ?? (parity && rows[0] ? rows[0].key : undefined);
  const open = useMemo(() => (openKey ? (properties.find((p) => p.key === openKey) ?? null) : null), [properties, openKey]);
  /* opening a property on a narrow screen should show the pane it opened, not leave it below the fold */
  useEffect(() => {
    if (open) revealDetail();
  }, [open]);
  const columns = useMemo(() => confColumns(openKey), [openKey]);

  const filtered = !!(search.q || search.overridden || search.final || search.resource);
  const overriddenPct = summary.total ? Math.round((summary.overridden / summary.total) * 100) : 0;

  return (
    <div className="burrow-scroll burrow-page-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-6">
      <PageHead
        title={
          <span className="inline-flex items-center gap-1.5">
            {host ? `NodeManager ${host} configuration` : "Configuration"}
            <PopoverRoot>
              <Tooltip label="Learn what overridden and final configuration values mean">
                <PopoverTrigger
                  aria-label="About overridden and final configuration values"
                  render={<Button variant="ghost" size="icon-sm" className="text-ink-4 hover:text-live" />}
                >
                  <CircleHelp className="size-4" aria-hidden="true" />
                </PopoverTrigger>
              </Tooltip>
              <PopoverContent title="About configuration values" align="start" className="w-[20rem] text-small leading-relaxed">
                <p className="m-0">
                  Overridden values come from a site configuration file or are set programmatically. Final values are locked by Hadoop.
                  Default values aren’t included, so this view can’t compare a setting with the default it replaced.
                </p>
              </PopoverContent>
            </PopoverRoot>
          </span>
        }
        description="Search and compare configuration values reported by the selected Hadoop daemon."
        actions={
          <>
            {host && (
              <a href="/tools/conf" className={ACTION_LINK_CLASS}>
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                ResourceManager configuration
              </a>
            )}
            <Button variant="quiet" size="sm" onClick={reload}>
              <RotateCw className="size-3.5" aria-hidden="true" />
              Reload
            </Button>
          </>
        }
      />

      {!host && <BurrowCapabilities />}

      {error && hasData && <StaleErrorBanner title="Could not refresh configuration" error={error} onRetry={reload} />}
      {error && !hasData ? (
        <CenteredPageState>
          <ErrorState
            title={host ? `Cannot read the NodeManager configuration at ${host}` : "Cannot read the ResourceManager configuration"}
            message={error instanceof Error ? error.message : String(error)}
            hint={
              host
                ? "Check that this NodeManager is running and still registered with the ResourceManager."
                : "Check that the ResourceManager is running and reachable, then try again."
            }
            onRetry={reload}
          />
        </CenteredPageState>
      ) : (
        <>
          <div className="order-2 grid grid-cols-2 gap-2 md:order-2 lg:grid-cols-4">
            <Stat label="Properties" value={summary.total.toLocaleString("en-US")} sub={`from ${summary.sources} sources`} />
            <Stat
              label="Overridden"
              value={summary.overridden}
              sub={`${overriddenPct}% come from a *-site.xml or code`}
              tone={summary.overridden > 0 ? "live" : undefined}
            />
            <Stat
              label="Final"
              value={summary.final}
              sub="locked by <final>, cannot be overridden"
              tone={summary.final > 0 ? "warn" : undefined}
            />
            <Stat
              label="Redacted"
              value={summary.redacted}
              sub="sensitive keys masked by Hadoop"
              tone={summary.redacted > 0 ? "warn" : undefined}
            />
          </div>

          <div
            className={cn(
              "order-3 grid min-h-0 flex-none grid-cols-[minmax(0,1fr)] gap-4 md:order-3 md:min-h-[26rem] md:flex-1",
              open && "xl:grid-cols-[minmax(0,1fr)_24rem]",
            )}
          >
            <DataTable
              data={rows}
              columns={columns}
              getRowId={(p) => p.key}
              entityKey={(p) => p.key}
              label="Configuration properties"
              storageKey="burrow.tools.conf"
              sorting={sorting}
              onSortingChange={(s) => setSearch({ sort: formatSort(s) })}
              columnVisibility={visibility}
              onColumnVisibilityChange={(v) => setSearch({ cols: formatCols(v) })}
              defaultVisibility={DEFAULT_VISIBILITY}
              rowVersion={confRowVersion}
              onRowActivate={(p) => setSearch({ open: search.open === p.key ? undefined : p.key })}
              loading={isPending}
              totalCount={properties.length}
              exportName={host ? `nm-conf-${host.replace(/[^A-Za-z0-9.-]/g, "_")}` : "rm-conf"}
              className="h-[26rem] md:h-full"
              toolbar={
                <>
                  <SearchField
                    value={search.q ?? ""}
                    onChange={(q) => setSearch({ q: q || undefined })}
                    label="Search configuration"
                    placeholder="key or value…"
                    className="w-72"
                  />
                  <Toggle
                    pressed={!!search.overridden}
                    onPressedChange={(v) => setSearch({ overridden: v || undefined })}
                    label="Show only overridden properties"
                  >
                    overridden
                  </Toggle>
                  <Toggle
                    pressed={!!search.final}
                    onPressedChange={(v) => setSearch({ final: v || undefined })}
                    label="Show only final properties"
                  >
                    <Lock className="size-3" aria-hidden="true" />
                    final only
                  </Toggle>
                  <Select
                    label="Source filter"
                    value={search.resource ?? null}
                    onValueChange={(v) => setSearch({ resource: v || undefined })}
                    placeholder="All sources"
                    options={[
                      { value: "", label: `All sources (${summary.total})` },
                      ...facets.map((f) => ({ value: f.value, label: `${f.value} (${f.count.toLocaleString("en-US")})` })),
                    ]}
                    className="w-56"
                  />
                  {filtered && (
                    <button
                      type="button"
                      className="text-small text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                      onClick={() => setSearch({ q: undefined, overridden: undefined, final: undefined, resource: undefined })}
                    >
                      Clear filters
                    </button>
                  )}
                </>
              }
              empty={
                <EmptyState title="No property matches these filters">
                  Widen the search, or clear the overridden / final / source filters to see all {summary.total.toLocaleString("en-US")}{" "}
                  properties.
                  {filtered && (
                    <button
                      type="button"
                      className="text-live underline-offset-2 hover:underline"
                      onClick={() => setSearch({ q: undefined, overridden: undefined, final: undefined, resource: undefined })}
                    >
                      Clear filters
                    </button>
                  )}
                </EmptyState>
              }
            />
            {open && <PropertyDetail p={open} host={host} onClose={() => setSearch({ open: undefined })} />}
          </div>
        </>
      )}
    </div>
  );
}
