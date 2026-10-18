/**
 * Overview tab — every datum the legacy `/cluster/app/{id}` page prints, plus a timeline and a diagnostics reader.
 *
 * Legacy labels are reproduced verbatim as the row headings (that is the parity mapping); the *presentation* is the
 * improvement: status timeline with gaps, a progress ring, monospace diagnostics with a copy button, and explicit
 * "not exposed" states for the two attempt-preemption fields RM REST does not serve (see CONTRACT CHANGE REQUESTS in
 * docs/contracts/api.md — the legacy page reads them from RMAppAttemptMetrics, which has no REST projection).
 */
import { ChevronDown, Clock, Info } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { rewriteUpstreamUrl, useUpstreamBases } from "~/lib/upstream-url";
import type { App, AppAttempt } from "~/api/schemas";
import { fmtDuration } from "~/lib/format";
import { cn } from "~/lib/cn";
import { trackingHref, trackingUiText } from "~/features/overview/derive";
import { Button } from "~/ui/button";
import { datumAttrs, Datum } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { Tooltip } from "~/ui/tooltip";
import { useParity } from "~/state/parity";
import { CopyButton, Field, FieldShell, ResourcePair, Section, UnavailableField } from "./Field";
import { StatusTimeline } from "./Timeline";
import { useNow } from "../use-now";
import {
  clarifyAppState,
  elapsedMs,
  finalStatusText,
  isAppFinal,
  labelExpressionText,
  priorityText,
  resourceSecondsText,
  timeoutCountdownText,
  timeoutRemainingText,
} from "../model";

/** Diagnostics can be megabytes; the reader keeps it monospace, full text, with an explicit expand control. */
function Diagnostics({ text }: { text: string }) {
  const parity = useParity();
  const [expanded, setExpanded] = useState(false);
  const open = parity || expanded;
  const lines = text.split("\n");
  return (
    <div className="min-w-0">
      {/* the count and the two controls share one line when there is room and wrap when there is not — on a phone the
          buttons would otherwise push the whole app page sideways */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pb-1">
        <span className="text-small text-ink-4">
          {text.length.toLocaleString("en-US")} characters · {lines.length.toLocaleString("en-US")} lines
        </span>
        <div className="flex items-center gap-1">
          <CopyButton text={text} label="Copy diagnostics" />
          {!parity && (
            <Button variant="quiet" size="sm" onClick={() => setExpanded((v) => !v)} aria-expanded={open}>
              <ChevronDown
                className={cn("size-3.5 transition-transform duration-(--dur-fast) ease-(--ease-out)", open && "rotate-180")}
                aria-hidden="true"
              />
              {open ? "Collapse" : "Show all"}
            </Button>
          )}
        </div>
      </div>
      {/* the <pre> IS the datum: data-yv's textContent is exactly the RM diagnostics string */}
      <Datum
        as="pre"
        field="app.diagnostics"
        raw={text}
        data-burrow="app-diagnostics"
        className={cn(
          "burrow-scroll overflow-auto rounded-md border border-seam-soft bg-well p-2.5 font-mono text-micro leading-relaxed whitespace-pre-wrap text-ink-2",
          open ? "max-h-[32rem]" : "max-h-32",
        )}
      >
        {text}
      </Datum>
    </div>
  );
}

export function OverviewTab({
  app,
  attempts,
  attemptTrackingUrl,
}: {
  app: App;
  attempts: readonly AppAttempt[];
  /**
   * The current attempt's tracking URL, for an app the RM still reports as `UNASSIGNED` (ACCEPTED: `AppInfo` withholds
   * the URL, while the legacy page's report already carries the attempt's proxy URL and prints "ApplicationMaster").
   */
  attemptTrackingUrl?: string | null;
}) {
  // The RM advertises its own hostname in `trackingUrl`; the link target uses the configured base (raw stays in data-yv).
  const bases = useUpstreamBases();
  const now = useNow(!isAppFinal(app.state));
  const timeouts = app.timeouts?.timeout ?? [];
  const lifetime = timeouts.find((t) => t.type === "LIFETIME") ?? timeouts[0];
  const remainingSeconds = lifetime?.remainingTimeInSeconds;
  const trackingUrl = app.trackingUrl ?? attemptTrackingUrl ?? undefined;
  // Legacy label (`RMAppsBlock.java:207-212`): state-derived, never the REST `trackingUI` key, which says `UNASSIGNED`
  // for an ACCEPTED app the legacy page labels `ApplicationMaster`.
  const trackingText = trackingUiText(app);
  // The anchor target: `trackingUrl`, else the RM's own `/proxy/<appId>/` for a live app past NEW. `data-yv` keeps the
  // URL used (the raw upstream value) while the link target is rewritten to the operator-configured RM base.
  const trackingLink = trackingHref({ id: app.id, state: app.state, trackingUrl }, bases.rm);
  const elapsed = elapsedMs(app.startedTime, app.finishedTime, now);

  return (
    // The application layout owns the page scroller; this content stays in normal flow below its header and tabs.
    <div className="flex flex-col gap-4 pb-6">
      <Section title="Status timeline" id="app-timeline">
        <StatusTimeline app={app} attempts={attempts} now={now} />
      </Section>

      <Section title="Application Overview">
        <dl className="grid grid-cols-1 lg:grid-cols-2 lg:gap-x-8">
          <Field label="User:" field="app.user" raw={app.user} />
          <Field label="Name:" field="app.name" raw={app.name} />
          <Field label="Application Type:" field="app.applicationType" raw={app.applicationType} />
          <Field label="Application Tags:" field="app.applicationTags" raw={app.applicationTags}>
            {app.applicationTags ? <span className="text-ink-2">{app.applicationTags}</span> : <span className="text-ink-4">no tags</span>}
          </Field>
          <Field
            label="Application Priority:"
            field="app.priority"
            raw={app.priority}
            fmt="int"
            hint="Higher Integer value indicates higher priority"
          >
            {priorityText(app.priority)}
          </Field>
          <Field
            label="YarnApplicationState:"
            field="app.state"
            raw={app.state}
            hint={clarifyAppState(app.state)}
            valueClassName="flex flex-wrap items-center gap-2"
          >
            <StatusPill domain="app.state" state={app.state} />
            {clarifyAppState(app.state) !== app.state && (
              <span className="text-small text-ink-3">{clarifyAppState(app.state).replace(`${app.state}: `, "")}</span>
            )}
          </Field>
          <Field label="Queue:" field="app.queue" raw={app.queue}>
            {/* the queue lives at `/scheduler/$queue` (a path param); `?queue=` is not a scheduler param and only ever
                landed on the freeness index */}
            <Link
              to="/scheduler/$queue"
              params={{ queue: app.queue }}
              className="burrow-touch-link text-live outline-offset-2 underline-offset-2 hover:underline"
            >
              {app.queue}
            </Link>
          </Field>
          <Field
            label="FinalStatus Reported by AM:"
            field="app.finalStatus"
            raw={app.finalStatus}
            hint={finalStatusText(app.finalStatus) === app.finalStatus ? undefined : finalStatusText(app.finalStatus)}
            valueClassName="flex flex-wrap items-center gap-2"
          >
            {app.finalStatus === "UNDEFINED" ? (
              <>
                <Datum field="app.finalStatus" raw={app.finalStatus} bare aria-hidden="true" className="sr-only" />
                <span className="text-small text-ink-3">
                  {isAppFinal(app.state) ? "Final status unreported" : finalStatusText(app.finalStatus)}
                </span>
              </>
            ) : (
              <StatusPill domain="app.finalStatus" state={app.finalStatus} size="sm" />
            )}
          </Field>
          <Field label="Started:" field="app.startedTime" raw={app.startedTime} fmt="epoch" />
          <Field label="Launched:" field="app.launchTime" raw={app.launchTime} fmt="epoch" />
          <Field label="Finished:" field="app.finishedTime" raw={app.finishedTime} fmt="epoch" />
          <Field
            label="Elapsed:"
            field="app.elapsedTime"
            raw={elapsed}
            fmt="ms"
            hint={
              app.finishedTime > 0
                ? "Time from application submission to completion."
                : "Time since application submission; updates while the application is unfinished."
            }
          >
            <span className="inline-flex items-center gap-1.5 tabular-nums">
              <Clock className="size-3.5 text-ink-4" aria-hidden="true" />
              {fmtDuration(elapsed)}
            </span>
          </Field>
          <Field
            label="Tracking URL:"
            field="app.trackingUrl"
            raw={app.trackingUrl}
            hint={`Open the application’s ${trackingText.toLowerCase()} interface.`}
          >
            <Datum field="app.derived.trackingUiText" raw={trackingText}>
              {trackingLink ? (
                <a
                  {...datumAttrs("app.trackingUrl", trackingLink)}
                  href={rewriteUpstreamUrl(trackingLink, bases).href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-live underline-offset-2 break-all hover:underline"
                >
                  {trackingText}
                </a>
              ) : (
                trackingText
              )}
            </Datum>
          </Field>
          <FieldShell label="Log Aggregation Status:" valueClassName="flex items-center gap-2">
            <StatusPill
              domain="app.logAggregationStatus"
              state={app.logAggregationStatus}
              field="app.logAggregationStatus"
              raw={app.logAggregationStatus}
              size="sm"
            />
          </FieldShell>
          <Field
            label="Application Timeout (Remaining Time):"
            field="app.timeouts.timeout.remainingTimeInSeconds"
            raw={remainingSeconds}
            fmt="int"
            hint={
              lifetime
                ? `Type ${lifetime.type}, expiry ${lifetime.expiryTime ?? "—"}; server value in data-yv`
                : "The RM reported no application timeouts for this application"
            }
          >
            {timeoutRemainingText(remainingSeconds)}
            {remainingSeconds != null && remainingSeconds > 0 && (
              <span className="ml-2 text-small text-ink-4">{timeoutCountdownText(remainingSeconds)}</span>
            )}
          </Field>
          <Field label="Unmanaged Application:" field="app.unmanagedApplication" raw={app.unmanagedApplication}>
            {app.unmanagedApplication ? "true" : "false"}
          </Field>
          <Field label="Application Node Label expression:" field="app.appNodeLabelExpression" raw={app.appNodeLabelExpression}>
            {labelExpressionText(app.appNodeLabelExpression)}
          </Field>
          <Field label="AM container Node Label expression:" field="app.amNodeLabelExpression" raw={app.amNodeLabelExpression}>
            {labelExpressionText(app.amNodeLabelExpression)}
          </Field>
        </dl>
      </Section>

      <Section
        title="Diagnostics"
        actions={
          <Tooltip label="YARN ResourceManager diagnostics from the live REST app report. Burrow surfaces this field even though the legacy application page does not render it.">
            <Button variant="ghost" size="icon-sm" aria-label="About application diagnostics" className="size-6 text-ink-4">
              <Info className="size-3.5" aria-hidden="true" />
            </Button>
          </Tooltip>
        }
      >
        <Diagnostics text={app.diagnostics ?? ""} />
      </Section>

      <Section title="Application Metrics">
        <dl className="grid grid-cols-1 lg:grid-cols-2 lg:gap-x-8">
          <ResourcePair
            label="Total Resource Preempted:"
            memoryField="app.preemptedResourceMB"
            vcoresField="app.preemptedResourceVCores"
            memoryMB={app.preemptedResourceMB}
            vcores={app.preemptedResourceVCores}
            hint="Memory and virtual CPU cores reclaimed by the scheduler from this application."
          />
          <Field
            label="Total Number of Non-AM Containers Preempted:"
            field="app.numNonAMContainerPreempted"
            raw={app.numNonAMContainerPreempted}
            fmt="int"
          />
          <Field
            label="Total Number of AM Containers Preempted:"
            field="app.numAMContainerPreempted"
            raw={app.numAMContainerPreempted}
            fmt="int"
          />
          <UnavailableField
            label="Resource Preempted from Current Attempt:"
            field="app.derived.currentAttemptResourcePreemptedText"
            reason="YARN reports preempted resources for the application as a whole, but does not expose a resource total for the current attempt."
          />
          <UnavailableField
            label="Number of Non-AM Containers Preempted from Current Attempt:"
            field="app.derived.currentAttemptNumNonAMContainersPreempted"
            reason="YARN reports the application's preempted-container count, but does not expose a separate count for the current attempt."
          />
          <Field
            label="Aggregate Resource Allocation:"
            field="app.derived.resourceSecondsText"
            raw={resourceSecondsText(app.memorySeconds, app.vcoreSeconds, app.resourceSecondsMap)}
            hint="Resources summed over their allocation time. One MiB allocated for one second is one MiB-second; CPU is measured in vCore-seconds."
          >
            {resourceSecondsText(app.memorySeconds, app.vcoreSeconds, app.resourceSecondsMap)}
          </Field>
          <Field
            label="Aggregate Preempted Resource Allocation:"
            field="app.derived.preemptedResourceSecondsText"
            raw={resourceSecondsText(app.preemptedMemorySeconds, app.preemptedVcoreSeconds, app.preemptedResourceSecondsMap)}
            hint="Resource time consumed by containers before the scheduler preempted them."
          >
            {resourceSecondsText(app.preemptedMemorySeconds, app.preemptedVcoreSeconds, app.preemptedResourceSecondsMap)}
          </Field>
        </dl>
        {/* the REST keys behind the two derived aggregate texts (P1 coverage: no key left unrendered) */}
        <div className="sr-only">
          <Datum field="app.memorySeconds" raw={app.memorySeconds} fmt="int" />
          <Datum field="app.vcoreSeconds" raw={app.vcoreSeconds} fmt="int" />
          <Datum field="app.preemptedMemorySeconds" raw={app.preemptedMemorySeconds} fmt="int" />
          <Datum field="app.preemptedVcoreSeconds" raw={app.preemptedVcoreSeconds} fmt="int" />
        </div>
      </Section>

      <Section
        title="Resource usage"
        actions={
          <Tooltip label="Additional application usage values from the live ResourceManager REST response. The legacy application page does not show these fields.">
            <Button variant="ghost" size="icon-sm" aria-label="About resource usage" className="size-6 text-ink-4">
              <Info className="size-3.5" aria-hidden="true" />
            </Button>
          </Tooltip>
        }
      >
        <dl className="grid grid-cols-1 lg:grid-cols-2 lg:gap-x-8" data-burrow="extra-resource-usage">
          <Field label="Running Containers:" field="app.runningContainers" raw={app.runningContainers} fmt="int" />
          <Field label="Allocated Memory MB:" field="app.allocatedMB" raw={app.allocatedMB} fmt="mb" />
          <Field label="Allocated CPU VCores:" field="app.allocatedVCores" raw={app.allocatedVCores} fmt="int" />
          <Field label="Reserved Memory MB:" field="app.reservedMB" raw={app.reservedMB} fmt="mb" />
          <Field label="Reserved CPU VCores:" field="app.reservedVCores" raw={app.reservedVCores} fmt="int" />
          <Field label="% of Queue:" field="app.queueUsagePercentage" raw={app.queueUsagePercentage} fmt="pct" />
          <Field label="% of Cluster:" field="app.clusterUsagePercentage" raw={app.clusterUsagePercentage} fmt="pct" />
          <Field label="Cluster ID:" field="app.clusterId" raw={app.clusterId} fmt="int" />
          <Field label="Master Node ID:" field="app.masterNodeId" raw={app.masterNodeId} />
          <Field label="AM Host HTTP Address:" field="app.amHostHttpAddress" raw={app.amHostHttpAddress} />
          <Field label="AM RPC Address:" field="app.amRPCAddress" raw={app.amRPCAddress} />
          <Field label="RM Cluster ID:" field="app.rmClusterId" raw={app.rmClusterId} />
        </dl>
      </Section>

      <Section
        title="Attempts"
        actions={
          <Link
            to="/apps/$appId/attempts"
            params={{ appId: app.id }}
            className="burrow-touch-link text-small text-live underline-offset-2 hover:underline"
          >
            all attempts
          </Link>
        }
      >
        {attempts.length === 0 ? (
          <p className="text-small text-ink-3">The RM reports no attempts yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {attempts.map((a) => (
              <li key={a.appAttemptId} className="flex items-center gap-2 rounded-md border border-seam px-2 py-1">
                <Link
                  to="/apps/$appId/attempts/$attemptId"
                  params={{ appId: app.id, attemptId: a.appAttemptId }}
                  className="burrow-touch-link font-mono text-small text-live underline-offset-2 hover:underline"
                >
                  #{a.id}
                </Link>
                <StatusPill domain="app.state" state={a.appAttemptState} size="sm" />
                <Datum field="attempt.startTime" raw={a.startTime} fmt="epoch" className="text-micro text-ink-4" />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
