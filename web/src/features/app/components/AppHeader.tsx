/**
 * Application header: identity, status, and the legacy "Tracking URL" actions.
 *
 * Everything the legacy page prints for User/Name/Type/Tags/Priority/State/Queue/FinalStatus lives here (once) and is
 * repeated nowhere else except the overview tab's labelled InfoBlock rows — both carry the same field ids, which the
 * parity contract explicitly allows (rule 1: every occurrence must agree with the upstream value).
 */
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { ExternalLink, Tag } from "lucide-react";
import type { App, AppAttempt } from "~/api/schemas";
import { q } from "~/api/queries";
import { fmtDuration } from "~/lib/format";
import { cn } from "~/lib/cn";
import { rewriteUpstreamUrl, useUpstreamBases } from "~/lib/upstream-url";
import { ACTION_LINK_CLASS } from "~/ui/button";
import { Datum } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { Tooltip, OptionalTooltip } from "~/ui/tooltip";
import { CopyButton } from "./Field";
import { SparkAffordance } from "./SparkAffordance";
import { appSparkSource } from "../queries";
import { elapsedMs, isAppFinal, priorityText, trackingKind, trackingLabel } from "../model";

function tags(app: App): string[] {
  return app.applicationTags
    ? app.applicationTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
}

function appPageDescription(pathname: string, appId: string): string {
  const appPath = `/apps/${appId}`;
  const suffix = pathname.startsWith(appPath) ? pathname.slice(appPath.length) : "";
  if (suffix.startsWith("/spark")) return "Spark application activity, execution plans, and runtime details.";
  if (suffix.startsWith("/attempts/")) return "Inspect this attempt’s lifecycle, resource requests, and allocated containers.";
  if (suffix === "/attempts") return "Review attempt history, assigned nodes, and container totals.";
  if (suffix.startsWith("/containers/")) return "Inspect this container’s assignment, resource use, logs, and execution state.";
  if (suffix.startsWith("/logs")) return "Read container log output and choose the stream to inspect.";
  return "Application state, lifecycle, and resource usage reported by YARN.";
}

export function AppHeader({
  app,
  attempts,
  now,
  insideSpark = false,
  className,
}: {
  app: App;
  attempts: readonly AppAttempt[];
  now: number;
  insideSpark?: boolean;
  className?: string;
}) {
  const meta = useQuery(q.meta());
  const { pathname } = useLocation();
  // SparkAffordance reads this same cached query. Resolve it here too so we can show one history action
  // when YARN's tracking link and the direct Spark History link lead to the same Spark application.
  const sparkSource = useQuery(appSparkSource(app.id));
  const bases = useUpstreamBases();
  // The RM advertises its own hostname in `trackingUrl` (live: http://<host>:8088/proxy/<app>/); rewrite the target
  // to the base the operator configured for Burrow. The raw value is untouched — it stays in `data-yv`.
  const tracking = rewriteUpstreamUrl(app.trackingUrl, bases);
  const kind = trackingKind(app);
  const live = !isAppFinal(app.state);
  const elapsed = elapsedMs(app.startedTime, app.finishedTime, now);
  const hasFinalVerdict = isAppFinal(app.state) && app.finalStatus !== "UNDEFINED";
  const finalStatusUnreported = isAppFinal(app.state) && app.finalStatus === "UNDEFINED";
  const rmBase = meta.data?.rm.active ?? meta.data?.rm.urls?.[0];
  const rawYarnHref = rmBase ? `${rmBase.replace(/\/$/, "")}/cluster/app/${app.id}` : null;
  const appTags = tags(app);
  const sparkHistoryTracking =
    !insideSpark && app.applicationType?.toUpperCase() === "SPARK" && isAppFinal(app.state) && kind === "history";
  const useDirectSparkHistory =
    sparkHistoryTracking && sparkSource.data?.mode === "history" && sparkSource.data.available && !!sparkSource.data.baseUrl;
  // While the direct target is loading, let its skeleton stand in for the generic History link.
  // Fall back to the YARN-provided link if resolution fails or Spark History is unavailable.
  const showTrackingLink = !sparkHistoryTracking || (!sparkSource.isPending && !useDirectSparkHistory);
  const description = appPageDescription(pathname, app.id);

  return (
    <header className={cn("flex flex-col gap-4", className)} data-burrow-app-header={insideSpark ? "spark" : "yarn"}>
      <div className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          {!insideSpark && <p className="mb-1 text-caption font-semibold tracking-[0.1em] text-live uppercase">YARN application</p>}
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-h1 font-semibold text-ink">
              <Datum field="app.name" raw={app.name} as="span" />
            </h1>
            {hasFinalVerdict ? (
              <>
                <StatusPill domain="app.finalStatus" state={app.finalStatus} field="app.finalStatus" size="sm" />
                <Datum field="app.state" raw={app.state} as="span" className="sr-only" />
              </>
            ) : (
              <>
                <StatusPill domain="app.state" state={app.state} field="app.state" />
                <Datum field="app.finalStatus" raw={app.finalStatus} as="span" bare aria-hidden="true" className="sr-only" />
                {finalStatusUnreported && <span className="text-small text-ink-3">Final status unreported</span>}
              </>
            )}
          </div>
          {!insideSpark && <p className="mt-1 max-w-3xl text-pretty text-body text-ink-3">{description}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-small text-ink-3" data-burrow-app-header-meta>
            <span className="flex items-center gap-1 font-mono" data-burrow-app-header-id>
              <Datum field="app.id" raw={app.id} as="span" />
              <CopyButton text={app.id} label="Copy application ID" iconOnly />
            </span>
            <span aria-hidden="true" data-burrow-app-header-secondary>
              ·
            </span>
            <span data-burrow-app-header-secondary>
              <span className="text-ink-4">User </span>
              <Datum field="app.user" raw={app.user} as="span" className="text-ink-2" />
            </span>
            <span aria-hidden="true" data-burrow-app-header-secondary>
              ·
            </span>
            <span data-burrow-app-header-secondary>
              <span className="text-ink-4">Type </span>
              <Datum field="app.applicationType" raw={app.applicationType} as="span" className="text-ink-2" />
            </span>
            <span aria-hidden="true" data-burrow-app-header-secondary>
              ·
            </span>
            <span data-burrow-app-header-secondary>
              <span className="text-ink-4">Queue </span>
              <Datum field="app.queue" raw={app.queue} as="span" className="text-ink-2" />
            </span>
            <span aria-hidden="true" data-burrow-app-header-secondary>
              ·
            </span>
            <span data-burrow-app-header-secondary>
              <span className="text-ink-4">Priority </span>
              <Tooltip label="Higher Integer value indicates higher priority">
                <Datum
                  field="app.priority"
                  raw={app.priority}
                  fmt="int"
                  as="span"
                  className="text-ink-2 tabular-nums"
                  title={priorityText(app.priority)}
                />
              </Tooltip>
            </span>
            <span aria-hidden="true" data-burrow-app-header-secondary>
              ·
            </span>
            <span className="flex items-center gap-1" data-burrow-app-header-secondary>
              <span className="text-ink-4">{live ? "elapsed" : "took"}</span>
              <Datum field="app.elapsedTime" raw={elapsed} fmt="ms" as="span" className="text-ink-2 tabular-nums">
                {fmtDuration(elapsed)}
              </Datum>
            </span>
          </div>
          {appTags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1" data-burrow-app-header-secondary>
              <Tag className="size-3 text-ink-4" aria-hidden="true" />
              {appTags.map((tag) => (
                <span key={tag} className="rounded-full bg-fabric-3 px-1.5 py-0.5 text-micro text-ink-2">
                  {tag}
                </span>
              ))}
              {/* the joined REST string stays available to the harness even though the chips are the display form */}
              <Datum field="app.applicationTags" raw={app.applicationTags} as="span" className="sr-only" />
            </div>
          )}
        </div>

        <div className="flex w-full min-w-0 flex-col items-start gap-1.5 xl:w-auto xl:items-end" data-burrow-app-header-secondary>
          <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1.5 xl:justify-end">
            {showTrackingLink ? (
              <Datum field="app.trackingUrl" raw={app.trackingUrl} as="span" className="inline-flex">
                {kind === "unassigned" || !app.trackingUrl ? (
                  <span className="inline-flex items-center gap-1.5 text-small text-ink-4">
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                    {trackingLabel(app)}
                  </span>
                ) : (
                  <OptionalTooltip
                    label={
                      tracking.internal ? "Reachable from the cluster network only — Burrow does not proxy the NodeManager UI" : undefined
                    }
                  >
                    <a href={tracking.href} target="_blank" rel="noreferrer noopener" className={cn(ACTION_LINK_CLASS, "text-live")}>
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                      {trackingLabel(app)}
                    </a>
                  </OptionalTooltip>
                )}
              </Datum>
            ) : (
              <Datum field="app.trackingUrl" raw={app.trackingUrl} as="span" bare className="sr-only" />
            )}
            {rawYarnHref && (
              <a href={rawYarnHref} target="_blank" rel="noreferrer noopener" className={cn(ACTION_LINK_CLASS, "text-live")}>
                <ExternalLink className="size-3.5" aria-hidden="true" />
                YARN application page
              </a>
            )}
          </div>
          <SparkAffordance appId={app.id} className="w-full xl:justify-end" insideSpark={insideSpark} />
        </div>
      </div>
      {attempts.length > 1 && (
        <p className="text-small text-ink-4">
          {attempts.length} attempts — the application was retried{" "}
          {attempts.filter((a) => a.appAttemptState === "FAILED").length > 0 ? "after failures" : "by the cluster"}.
        </p>
      )}
    </header>
  );
}
