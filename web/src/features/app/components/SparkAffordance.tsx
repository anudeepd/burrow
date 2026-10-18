/**
 * The "Spark UI" affordance on the overview tab.
 *
 * Two destinations, never conflated:
 *  - the native Spark tabs inside Burrow (`/apps/$appId/spark/jobs`) when the FE-Spark slice is part of the build;
 *  - the unmodified Spark UI, resolved by the backend (`/api/spark/{appId}/source`): RM web proxy while the app runs,
 *    Spark History Server once it is finished.
 * When the backend cannot resolve a source we say so and why (reason/hint from the API); no guessed URLs.
 */
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Sparkles } from "lucide-react";
import { cn } from "~/lib/cn";
import { ACTION_LINK_CLASS, Button } from "~/ui/button";
import { Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { appSparkSource } from "../queries";
import { appTabs } from "../tabs";
import { HelpTip } from "~/ui/tooltip";

export function SparkAffordance({ appId, className, insideSpark = false }: { appId: string; className?: string; insideSpark?: boolean }) {
  const source = useQuery(appSparkSource(appId));
  const nativeTab = appTabs(appId).find((t) => t.value === "spark");

  const native = insideSpark ? null : nativeTab?.available ? (
    // plain anchor: the Spark routes are contributed by another slice and are not in this build's typed route tree
    <a href={nativeTab.href} className={cn(ACTION_LINK_CLASS, "text-live")}>
      <Sparkles className="size-3.5" aria-hidden="true" />
      Open in Burrow
    </a>
  ) : (
    <span className="inline-flex items-center gap-1">
      <span className="text-small text-ink-4">Native Spark tabs: not in this build</span>
      {nativeTab?.hint && <HelpTip label="Native Spark tabs">{nativeTab.hint}</HelpTip>}
    </span>
  );

  let external: React.ReactNode;
  if (source.isPending) {
    external = <Skeleton className="h-4 w-40" />;
  } else if (!source.data?.available || !source.data.baseUrl) {
    if (insideSpark) {
      external = null;
    } else {
      const reason = source.data?.reason ?? (source.error instanceof Error ? source.error.message : "no Spark source resolved");
      const historyNotConfigured = reason.includes("no Spark History Server is configured");
      const detail = historyNotConfigured ? "This application has finished, so its Spark driver UI is no longer available." : reason;
      const hint = historyNotConfigured
        ? "Configure Burrow with the Spark History Server URL to open the saved application history."
        : source.data?.hint;
      external = (
        <div
          role="status"
          className="flex min-w-0 max-w-2xl items-start gap-2 rounded-md border border-seam-soft bg-fabric-2 px-2.5 py-2 text-small"
          data-burrow="spark-source-unavailable"
        >
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium text-ink-2">Spark UI unavailable</p>
            <p className="mt-0.5 break-words text-caption text-ink-3">{detail}</p>
            {hint && <p className="mt-1 break-words text-caption text-ink-4">Next: {hint}</p>}
            {source.error && source.data && (
              <p className="mt-1 break-words text-caption text-fail">
                Refresh failed: {source.error instanceof Error ? source.error.message : String(source.error)}
              </p>
            )}
          </div>
          {source.isError && (
            <Button variant="quiet" size="sm" className="shrink-0" onClick={() => void source.refetch()}>
              Retry
            </Button>
          )}
        </div>
      );
    }
  } else {
    const historyPath =
      source.data.mode === "history" && source.data.sparkAppId
        ? `/history/${encodeURIComponent(source.data.sparkAppId)}${source.data.attempt ? `/${encodeURIComponent(source.data.attempt)}` : ""}/jobs/`
        : null;
    const href = historyPath ? `${source.data.baseUrl.replace(/\/$/, "")}${historyPath}` : source.data.baseUrl;
    external = (
      <div className="flex min-w-0 flex-col items-start gap-1">
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          // the skeleton above resolves into this link once per app id, so it gets the pop-in rather than a hard swap
          className={cn("burrow-enter-pop", ACTION_LINK_CLASS, "text-live")}
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          {/* the destination differs, so the name does too: the RM proxy while the app runs, the history server after */}
          {source.data.mode === "live-proxy" ? "Spark UI" : "Spark History"}
        </a>
        {source.error && !insideSpark && (
          <StaleErrorBanner
            title="Spark source refresh failed; showing the last loaded link"
            error={source.error}
            onRetry={() => void source.refetch()}
          />
        )}
      </div>
    );
  }

  if (!native && !external) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", className)} data-burrow="spark-affordance">
      {native}
      {external}
    </div>
  );
}
