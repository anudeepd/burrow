import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CircleCheck, CircleX, Minus } from "lucide-react";
import { q } from "~/api/queries";
import { useConnection } from "~/api/connection";
import { cn } from "~/lib/cn";
import { type Theme, type TimeZoneMode, setPrefs, usePref } from "~/state/prefs";
import { Datum, Entity, SINGLETON } from "~/ui/datum";
import { useMounted } from "~/lib/use-mounted";
import { Select } from "~/ui/select";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "~/ui/popover";
import { StatusDot, StatusPill } from "~/ui/status";
import { Tooltip } from "~/ui/tooltip";
import { Button } from "~/ui/button";

function Row({ label, children, ok }: { label: string; children: React.ReactNode; ok?: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="flex items-center gap-1.5 text-small text-ink-3">
        {ok === true && <CircleCheck className="size-3.5 text-ok" aria-hidden="true" />}
        {ok === false && <CircleX className="size-3.5 text-fail" aria-hidden="true" />}
        {ok == null && <Minus className="size-3.5 text-idle" aria-hidden="true" />}
        {label}
      </span>
      <span className="min-w-0 truncate text-small text-ink">{children}</span>
    </div>
  );
}

/**
 * Connection details for upstream services. Burrow's API and access mode are summarized in Capabilities.
 */
export function ConnectionPopover() {
  const queryClient = useQueryClient();
  const metaQ = useQuery(q.meta());
  const infoQ = useQuery(q.info());
  const metricsQ = useQuery(q.metrics());
  const { data: meta } = metaQ;
  const { data: info } = infoQ;
  const failures = useConnection((s) => s.consecutiveFailures);
  const lastError = useConnection((s) => s.lastError);
  const lastCache = useConnection((s) => s.lastCache);
  const lastUpstream = useConnection((s) => s.lastUpstream);
  const skew = useConnection((s) => s.clockSkewMs);
  const tz = usePref("tz");
  const theme = usePref("theme");
  const mounted = useMounted();
  const queryErrors = [
    metaQ.error && { label: "Burrow service metadata", error: metaQ.error },
    infoQ.error && { label: "ResourceManager cluster info", error: infoQ.error },
    metricsQ.error && { label: "ResourceManager cluster metrics", error: metricsQ.error },
  ].filter((entry): entry is { label: string; error: Error } => entry != null);
  const visibleFailures = Math.max(failures, queryErrors.length);
  const cache = lastCache ?? "miss";
  const health = visibleFailures > 0 ? "down" : "ok";

  return (
    <PopoverRoot>
      <Tooltip label="Connection, services and view settings">
        <PopoverTrigger
          data-testid="connection"
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Connection: ${health === "ok" ? "healthy" : `${visibleFailures} failed request(s)`}`}
              className="relative"
            />
          }
        >
          <Activity className={cn("size-4", health === "ok" ? "text-ok" : "text-fail")} aria-hidden="true" />
          {visibleFailures > 0 && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-fail" aria-hidden="true" />}
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent title="Connection" className="w-[22rem]">
        <Entity id={SINGLETON} className="flex flex-col divide-y divide-seam-soft">
          <div className="pb-1">
            <Row label="Cache">{cache}</Row>
            <Row label="Served by">{lastUpstream ?? "cache"}</Row>
            <Row label="Clock skew">{`${skew >= 0 ? "+" : ""}${Math.round(skew / 1000)}s`}</Row>
          </div>

          <div className="py-1">
            <Row label="ResourceManager" ok={meta?.rm.reachable ?? null}>
              {meta?.rm.active ?? "—"}
            </Row>
            <Row label="HA state">
              <StatusPill domain="rm.haState" state={info?.haState} field="cluster.info.haState" size="sm" />
            </Row>
            <Row label="Hadoop">
              <Datum field="cluster.info.hadoopVersion" raw={info?.hadoopVersion} />
            </Row>
          </div>

          <div className="pt-1">
            {(["sparkHistory", "jobHistory", "timeline"] as const).map((key) => {
              const svc = meta?.services[key];
              const label =
                key === "sparkHistory" ? "Spark History Server" : key === "jobHistory" ? "JobHistory Server" : "Timeline Service";
              return (
                <Row key={key} label={label} ok={svc?.configured ? (svc.reachable ?? null) : null}>
                  <span className="flex items-center gap-1.5">
                    <StatusDot domain="service" state={!svc?.configured ? "unconfigured" : svc.reachable ? "reachable" : "unreachable"} />
                    <span className="truncate">{svc?.configured ? svc.urls?.join(", ") || svc.url || "configured" : "not configured"}</span>
                  </span>
                </Row>
              );
            })}
          </div>

          {(queryErrors.length > 0 || (failures > 0 && lastError)) && (
            <div className="flex flex-col items-start gap-2 pt-2">
              {queryErrors.length > 0 ? (
                queryErrors.map(({ label, error }) => (
                  <p key={label} className="m-0 text-small text-fail" role="alert">
                    {label} failed: {error instanceof Error ? error.message : String(error)}
                  </p>
                ))
              ) : (
                <p className="m-0 text-small text-fail" role="alert">
                  {lastError}
                </p>
              )}
              <Button
                variant="quiet"
                size="sm"
                onClick={() =>
                  void queryClient.refetchQueries({
                    type: "active",
                    predicate: (query) => query.state.status === "error",
                  })
                }
              >
                Retry failed requests on this page
              </Button>
            </div>
          )}
          <div className="flex flex-col gap-2 pt-3 xl:hidden">
            <h3 className="text-small font-semibold">View settings</h3>
            <div className="flex items-center justify-between gap-2 text-small text-ink-3">
              Theme
              <Select<Theme>
                label="Theme"
                value={mounted ? theme : "system"}
                onValueChange={(value) => value && setPrefs({ theme: value })}
                options={[
                  { value: "system", label: "Follow system" },
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
              />
            </div>
            <div className="flex items-center justify-between gap-2 text-small text-ink-3">
              Time zone
              <Select<TimeZoneMode>
                label="Time zone"
                value={mounted ? tz : "local"}
                onValueChange={(value) => value && setPrefs({ tz: value })}
                options={[
                  { value: "local", label: "Local" },
                  { value: "utc", label: "UTC" },
                ]}
              />
            </div>
            <p className="text-micro leading-relaxed text-ink-4">
              Theme changes appearance. Local converts displayed timestamps to this browser’s time zone; UTC keeps them in Coordinated
              Universal Time.
            </p>
          </div>
          <p className="pt-2 text-micro text-ink-4">Times shown in {tz === "utc" ? "UTC" : "local time"}.</p>
        </Entity>
      </PopoverContent>
    </PopoverRoot>
  );
}
