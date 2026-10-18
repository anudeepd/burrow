/**
 * Status timeline + per-attempt bands.
 *
 * The legacy application page prints four timestamps in a flat InfoBlock and leaves the reader to subtract them; the
 * attempt story (submitted -> launched -> running -> finished, with retries) is spread across two tables. This renders
 * the same datums as one readable axis while stamping *every* value with its parity field id, so nothing is lost.
 */
import type { App, AppAttempt } from "~/api/schemas";
import { fmtDuration, fmtEpoch } from "~/lib/format";
import { cn } from "~/lib/cn";
import { usePref } from "~/state/prefs";
import { useInView } from "~/lib/in-view";
import { Datum, Entity } from "~/ui/datum";
import { ResourceRing } from "~/ui/resource-ring";
import { StatusPill } from "~/ui/status";
import { appProgress, appTimeline, attemptBands, hadoopFormatTime, isAppFinal } from "../model";

const BAND_TONE: Record<string, string> = {
  FINISHED: "burrow-tone-ok",
  FAILED: "burrow-tone-fail",
  KILLED: "burrow-tone-idle",
  RUNNING: "burrow-tone-live",
};

/**
 * One step dot. The `burrow-dot-pulse` loop is driven by CSS and gated on `[data-visible="true"]`, which only the shared
 * IntersectionObserver can stamp — the class alone (as it was) never animated at all.
 */
function StepDot({ tone, pulse }: { tone: string; pulse: boolean }) {
  const [ref, visible] = useInView<HTMLSpanElement>();
  return (
    <span
      ref={ref}
      data-visible={visible}
      aria-hidden="true"
      className={cn(
        "relative z-1 mt-1 size-2.5 shrink-0 rounded-full border-2 border-fabric",
        `burrow-tone-${tone}`,
        "bg-(--tone)",
        pulse && "burrow-dot-pulse",
      )}
    />
  );
}

export function StatusTimeline({ app, attempts, now }: { app: App; attempts: readonly AppAttempt[]; now: number }) {
  const tz = usePref("tz");
  const steps = appTimeline(app, attempts, now);
  const bands = attemptBands(attempts, now);
  const progress = appProgress(app);
  const live = !isAppFinal(app.state);
  const first = steps.find((s) => s.at != null)?.at ?? null;
  const last = app.finishedTime > 0 ? app.finishedTime : now;
  const span = Math.max(1, last - (first ?? last));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
      <ol className="min-w-0">
        {steps.map((step, i) => (
          <li key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 && <span aria-hidden="true" className="absolute top-3.5 left-[5px] h-full w-px bg-seam" />}
            <StepDot tone={step.tone} pulse={step.tone === "live" && live} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-body font-medium text-ink">{step.label}</span>
                <Datum field={step.field} raw={step.at} fmt="epoch" className="text-small text-ink-2 tabular-nums" />
                {step.durationMs != null && (
                  <Datum
                    field={step.durationField}
                    raw={step.durationMs}
                    fmt="ms"
                    title={`Phase duration (legacy format: ${hadoopFormatTime(step.durationMs)})`}
                    className="rounded-sm bg-fabric-3 px-1.5 text-micro text-ink-3 tabular-nums"
                  >
                    +{fmtDuration(step.durationMs)}
                  </Datum>
                )}
              </div>
              {step.detail && <p className="mt-0.5 text-small text-ink-3">{step.detail}</p>}
            </div>
          </li>
        ))}
      </ol>

      <div className="flex items-start gap-4">
        <div className="flex flex-col items-center gap-1">
          <ResourceRing
            used={live ? progress : 100}
            total={100}
            tone={live ? "live" : "ok"}
            label="Application progress"
            centre={
              <Datum field="app.progress" raw={app.progress} fmt="pct" className="text-lead font-semibold tabular-nums text-ink">
                {`${Math.round(progress)}%`}
              </Datum>
            }
          />
          <span className="text-micro text-ink-4">progress</span>
        </div>

        {attempts.length > 0 && (
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-col gap-0.5 text-micro text-ink-4 uppercase sm:flex-row sm:items-center sm:justify-between sm:gap-2">
              <span>Attempts</span>
              <span className="normal-case sm:normal-case">
                {(() => {
                  const startText = fmtEpoch(first ?? undefined, tz);
                  if (!(app.finishedTime > 0)) return `${startText} → now`;
                  const endText = fmtEpoch(app.finishedTime, tz);
                  /* same calendar day: the repeated date is what forces the wrap on a phone, and it adds nothing */
                  const sameDay = first != null && startText.slice(0, 10) === endText.slice(0, 10);
                  return `${startText} → ${sameDay ? (endText.split(" ")[1] ?? endText) : endText}`;
                })()}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {bands.map((band) => {
                const left = ((band.startMs - (first ?? band.startMs)) / span) * 100;
                const width = ((band.durationMs ?? 0) / span) * 100;
                return (
                  <Entity
                    key={band.attemptId}
                    id={band.attemptId}
                    as="div"
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2"
                  >
                    <Datum field="attempt.id" raw={band.num} fmt="int" as="span" className="text-micro text-ink-3 tabular-nums">
                      #{band.num}
                    </Datum>
                    <span
                      role="img"
                      aria-label={`Attempt ${band.num}: ${band.state}, ${fmtDuration(band.durationMs ?? 0)}`}
                      className="relative h-1.5 min-w-0 overflow-hidden rounded-full bg-well"
                    >
                      <span
                        className={cn("absolute inset-y-0 rounded-full", `burrow-tone-${BAND_TONE[band.state] ?? "idle"}`, "bg-(--tone)")}
                        style={{ left: `${Math.max(0, Math.min(100, left))}%`, width: `${Math.max(2, Math.min(100 - left, width))}%` }}
                      />
                    </span>
                    <span className="flex items-center gap-1.5">
                      <StatusPill domain="app.state" state={band.state} size="sm" />
                      <Datum field="attempt.startTime" raw={band.startMs} fmt="epoch" as="span" className="sr-only" />
                    </span>
                  </Entity>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
