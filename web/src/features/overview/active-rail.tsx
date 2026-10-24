/**
 * (e) "Now active" rail — the running and pending applications, from one server-filtered request:
 * `GET /api/yarn/apps?states=NEW,NEW_SAVING,SUBMITTED,ACCEPTED,RUNNING`.
 *
 * This is the part of the Overview that should feel alive: progress advances, elapsed time is computed against the
 * shell's clock (skew-corrected from `/api/meta`), and each row opens Burrow's application detail.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { ov } from "~/api/queries/overview";
import { cn } from "~/lib/cn";
import { fmtInt, fmtMB, type Fmt } from "~/lib/format";
import { Datum, Entity, datumAttrs } from "~/ui/datum";
import { EmptyState, ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { ProgressBar } from "~/ui/progress-bar";
import { StatusPill } from "~/ui/status";
import { Tooltip } from "~/ui/tooltip";
import { Ticker } from "~/ui/ticker";
import type { App } from "~/api/schemas";
import { appPhase } from "./derive";
import { CrossLink, Unavailable, useStale } from "./ui";

function AppFact({
  label,
  field,
  raw,
  fmt,
  valueClassName,
  factClassName,
  truncate = true,
  children,
}: {
  label: string;
  field: string;
  raw: unknown;
  fmt?: Fmt;
  valueClassName?: string;
  factClassName?: string;
  truncate?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 items-baseline gap-1", factClassName)}>
      <span className="shrink-0 text-ink-3">{label}</span>
      <Datum field={field} raw={raw} fmt={fmt} className={cn("min-w-0 text-ink-2", truncate && "truncate", valueClassName)}>
        {children}
      </Datum>
    </div>
  );
}

/** Longest-running first, running before queued; the rail is about work in flight. */
function rankApps(apps: App[]): App[] {
  return [...apps].sort((a, b) => {
    const pa = appPhase(a.state);
    const pb = appPhase(b.state);
    if (pa !== pb) return pa === "running" ? -1 : 1;
    return (a.startedTime ?? 0) - (b.startedTime ?? 0);
  });
}

function AppRow({ app, stale }: { app: App; stale: boolean }) {
  const phase = appPhase(app.state);
  const progress = typeof app.progress === "number" ? app.progress : 0;
  return (
    <Entity id={app.id} as="li" className="group border-b border-seam-soft last:border-b-0" data-testid={`app-row-${app.id}`}>
      <div className="burrow-active-app-row grid min-w-0 grid-cols-1 gap-y-3 px-3 py-2.5 transition-colors duration-(--dur-fast) ease-(--ease-out) group-hover:bg-fabric-2 group-focus-within:bg-fabric-2 lg:grid-cols-[minmax(12rem,1.2fr)_minmax(7rem,0.8fr)_minmax(15rem,1.5fr)] lg:items-center lg:gap-x-5">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
            <StatusPill domain="app.state" state={app.state} field="app.state" size="sm" />
            <Tooltip label={`Open ${app.name} in Burrow`} align="center">
              <CrossLink
                href={`/apps/${encodeURIComponent(app.id)}`}
                className="min-w-0 whitespace-normal rounded-sm text-body font-medium hover:text-live hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live [overflow-wrap:anywhere]"
                aria-label={`Open application ${app.name}`}
                data-testid={`app-link-${app.id}`}
              >
                <Datum field="app.name" raw={app.name} fmt="text">
                  {app.name}
                </Datum>
              </CrossLink>
            </Tooltip>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <ProgressBar
            percent={progress}
            tone={phase === "running" ? "live" : "wait"}
            live={phase === "running"}
            label={`${app.name}: ${progress.toFixed(1)}% complete`}
            datum={datumAttrs("app.progress", app.progress ?? null, "pct")}
            className="min-w-8 flex-1"
          />
          <Ticker
            value={progress}
            field="app.progress"
            fmt="pct"
            format={(n) => `${n.toFixed(1)}%`}
            className="burrow-progress-value text-caption text-ink-2"
          />
        </div>

        <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-1 text-caption xl:grid-cols-3" data-testid="app-row-facts">
          <AppFact label="User" field="app.user" raw={app.user} fmt="text" />
          <AppFact
            label="Queue"
            field="app.queue"
            raw={app.queue}
            fmt="text"
            factClassName="col-span-full xl:col-span-2"
            truncate={false}
            valueClassName="font-mono whitespace-normal [overflow-wrap:anywhere]"
          />
          <AppFact
            label="Started"
            field="app.startedTime"
            raw={app.startedTime}
            fmt="epoch"
            factClassName="col-span-full xl:col-span-2"
            truncate={false}
            valueClassName="tabular-nums whitespace-nowrap"
          />
          <AppFact label="Type" field="app.applicationType" raw={app.applicationType ?? null} fmt="text">
            {app.applicationType ?? "—"}
          </AppFact>
          <AppFact label="Containers" field="app.runningContainers" raw={app.runningContainers} fmt="int" />
          <AppFact label="Memory" field="app.allocatedMB" raw={app.allocatedMB} fmt="mb">
            {fmtMB(app.allocatedMB)}
          </AppFact>
          <AppFact label="vCores" field="app.allocatedVCores" raw={app.allocatedVCores} fmt="int" />
          <AppFact label="Elapsed" field="app.elapsedTime" raw={app.elapsedTime ?? null} fmt="dur" />
          <AppFact label="Priority" field="app.priority" raw={app.priority} fmt="int" />
          {stale && (
            <div className="col-span-full">
              <Unavailable variant="info" reason="Values may be out of date." />
            </div>
          )}
        </div>
      </div>
    </Entity>
  );
}

/** Keep Overview to a first-pass sample; the applications view holds the full live list. */
const RAIL_LIMIT = 5;

export function ActiveRail({ parity, bordered = false }: { parity: boolean; bordered?: boolean }) {
  const apps = useQuery(ov.appsActive());
  const stale = useStale();

  const list: App[] = useMemo(() => (apps.data ? rankApps(apps.data) : []), [apps.data]);
  const shown = parity ? list : list.slice(0, RAIL_LIMIT);

  if (apps.isPending) {
    return (
      <div className="divide-y divide-seam-soft border-y border-seam-soft" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <div
            key={i}
            className="grid gap-3 px-3 py-2.5 lg:grid-cols-[minmax(12rem,1.2fr)_minmax(7rem,0.8fr)_minmax(15rem,1.5fr)] lg:items-center lg:gap-x-5"
          >
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-1.5 w-full" />
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 xl:grid-cols-3">
              {Array.from({ length: 9 }, (_, fact) => (
                <Skeleton key={fact} className="h-3 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (apps.isError && apps.data === undefined) {
    return (
      <ErrorState
        title="The active applications could not be read"
        message={
          apps.error instanceof Error ? apps.error.message : String(apps.error ?? "The ResourceManager did not return active applications.")
        }
        hint="Cluster metrics above may still show active application counts."
        onRetry={() => void apps.refetch()}
      />
    );
  }
  if (list.length === 0) {
    return (
      <div className="flex flex-col gap-[var(--gap-card)]">
        {apps.isError && (
          <StaleErrorBanner
            title="Active applications refresh failed; showing the last loaded result"
            error={apps.error}
            onRetry={() => void apps.refetch()}
          />
        )}
        <EmptyState title="Nothing is running right now">
          The ResourceManager reports no application in NEW, NEW_SAVING, SUBMITTED, ACCEPTED or RUNNING.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[var(--gap-card)]">
      {apps.isError && list.length > 0 && (
        <StaleErrorBanner
          title="Active applications refresh failed; showing the last loaded rows"
          error={apps.error}
          onRetry={() => void apps.refetch()}
        />
      )}
      <div
        className={cn(
          "relative min-w-0 overflow-hidden rounded-md",
          bordered ? "border border-seam bg-fabric" : "border-y border-seam-soft",
        )}
      >
        <ul className="m-0 divide-y divide-seam-soft p-0" data-testid="active-rail" aria-label="Active applications">
          {shown.map((a) => (
            <AppRow key={a.id} app={a} stale={stale} />
          ))}
        </ul>
        <div className="flex h-7 shrink-0 items-center border-t border-seam-soft bg-fabric-2 px-3 text-small text-ink-3">
          <span className="tnum">
            {fmtInt(shown.length)} shown{shown.length !== list.length ? ` of ${fmtInt(list.length)}` : ""} active applications
          </span>
        </div>
      </div>
      {shown.length < list.length && (
        <CrossLink
          href="/apps?states=NEW,NEW_SAVING,SUBMITTED,ACCEPTED,RUNNING"
          className="self-start text-small text-live hover:underline"
        >
          {`View all ${fmtInt(list.length)} active applications →`}
        </CrossLink>
      )}
    </div>
  );
}
