import { useQuery } from "@tanstack/react-query";
import { ov } from "~/api/queries/overview";
import { useConnection } from "~/api/connection";
import type { Meta, MetaService } from "~/api/schemas";
import { fmtRelative } from "~/lib/format";
import { ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { StatusPill } from "~/ui/status";
import { Tooltip } from "~/ui/tooltip";

/** `reachable: null` means configured but not probed yet; absent means not configured. */
function serviceState(service: MetaService | undefined): "reachable" | "unreachable" | "unconfigured" {
  if (!service?.configured) return "unconfigured";
  return service.reachable === false ? "unreachable" : "reachable";
}

function serviceAddresses(service: MetaService): string {
  return service.urls?.join(", ") || service.url || "";
}

function serviceDetails(service: MetaService): string {
  if (service.candidates?.length) {
    return service.candidates
      .map((candidate) => `${candidate.url}: ${candidate.reachable ? "reachable" : (candidate.reason ?? "unreachable")}`)
      .join("\n");
  }
  return serviceAddresses(service) || service.reason || "No URL configured or discovered.";
}

const AUXILIARY_SERVICES = [
  { key: "sparkHistory", label: "Spark History" },
  { key: "jobHistory", label: "Job History" },
  { key: "timeline", label: "Timeline Service" },
] as const satisfies readonly { key: keyof Meta["services"]; label: string }[];

const CAPABILITIES = [
  { key: "sparkLive", label: "sparkLive", description: "Live Spark integration" },
  { key: "sparkHistory", label: "sparkHistory", description: "Spark History integration" },
  { key: "aggregatedLogs", label: "aggregatedLogs", description: "YARN aggregated logs" },
  { key: "nodeLogs", label: "nodeLogs", description: "NodeManager logs" },
  { key: "events", label: "events", description: "YARN application events" },
  { key: "kerberos", label: "kerberos", description: "Kerberos authentication" },
] as const satisfies readonly { key: keyof Meta["features"]; label: string; description: string }[];

export function ServicesHealthSection({ renderVersion = "post" }: { renderVersion?: "pre" | "post" }) {
  const meta = useQuery(ov.meta());
  const lastOkAt = useConnection((state) => state.lastOkAt);
  const failures = useConnection((state) => state.consecutiveFailures);

  if (meta.isPending) {
    return (
      <div
        className="grid grid-cols-1 divide-y divide-seam-soft rounded-lg border border-seam-soft bg-well sm:grid-cols-3 sm:divide-y-0 sm:divide-x"
        aria-busy="true"
      >
        {AUXILIARY_SERVICES.map((service) => (
          <div key={service.key} className="flex items-center justify-between gap-3 p-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    );
  }
  if (!meta.data) {
    return (
      <ErrorState
        title="Service status is unavailable"
        message={
          meta.error instanceof Error ? meta.error.message : String(meta.error ?? "The ResourceManager did not return service details.")
        }
        hint="Try again in a moment."
        onRetry={() => void meta.refetch()}
      />
    );
  }
  const m: Meta = meta.data;

  if (renderVersion === "pre") {
    return (
      <div className="flex flex-col gap-3">
        {meta.isError && (
          <StaleErrorBanner
            title="Service status refresh failed; showing the last loaded values"
            error={meta.error}
            onRetry={() => void meta.refetch()}
          />
        )}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-seam bg-fabric p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-micro tracking-wide text-ink-3 uppercase">ResourceManager</span>
              <StatusPill domain="service" state={m.rm.reachable ? "reachable" : "unreachable"} size="sm" />
            </div>
            <Tooltip label={m.rm.active ?? m.rm.urls[0] ?? "No ResourceManager URL reported."}>
              <p className="m-0 truncate font-mono text-small text-ink-2">{m.rm.active ?? m.rm.urls[0] ?? "—"}</p>
            </Tooltip>
            <div className="flex flex-wrap items-center gap-2 text-micro text-ink-3">
              <StatusPill domain="rm.haState" state={m.rm.haState} size="sm" />
              <span>hadoop {m.rm.hadoopVersion ?? "—"}</span>
              <span>Burrow {m.version}</span>
            </div>
          </section>
          {AUXILIARY_SERVICES.map(({ key, label }) => {
            const service = m.services[key];
            return (
              <section key={key} className="flex min-w-0 flex-col gap-2 rounded-lg border border-seam bg-fabric p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-micro tracking-wide text-ink-3 uppercase">{label}</span>
                  <StatusPill domain="service" state={serviceState(service)} size="sm" />
                </div>
                <Tooltip label={service.configured ? serviceDetails(service) : "No URL configured or discovered."}>
                  <p className="m-0 truncate text-small text-ink-2">
                    {service.configured ? serviceAddresses(service) || service.reason || "configured" : "no URL configured or discovered"}
                  </p>
                </Tooltip>
              </section>
            );
          })}
        </div>

        <section className="flex flex-col gap-2 rounded-lg border border-seam-soft bg-well px-3 py-2" aria-label="Capabilities">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-ink-3">
            <span className="tracking-wide uppercase">Capabilities</span>
            {CAPABILITIES.map(({ key, label, description }) => (
              <Tooltip key={key} label={`${description}: ${m.features[key] ? "available" : "not available"} on this cluster.`}>
                <span className="inline-flex items-center gap-1.5">
                  <span className={m.features[key] ? "text-live" : "text-ink-4"} aria-hidden="true">
                    {m.features[key] ? "●" : "○"}
                  </span>
                  {label}
                </span>
              </Tooltip>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-micro text-ink-3">
            <Tooltip label="Scheduler implementation reported by YARN.">
              <span>scheduler {m.yarn.scheduler ?? "—"}</span>
            </Tooltip>
            <Tooltip
              label={`The ResourceManager web endpoint uses ${m.yarn.httpPolicy === "HTTP_ONLY" ? "HTTP only" : m.yarn.httpPolicy}.`}
            >
              <span>http {m.yarn.httpPolicy}</span>
            </Tooltip>
            <Tooltip
              label={
                m.readOnly
                  ? "Burrow can inspect this cluster; write operations are disabled."
                  : "Burrow can perform configured write operations."
              }
            >
              <span>{m.readOnly ? "read-only" : "read/write"}</span>
            </Tooltip>
            <Tooltip label="Time since Burrow last received a successful API response.">
              <span className={failures ? "text-fail" : "text-ink-3"}>
                API {failures ? `${failures} failed` : lastOkAt == null ? "waiting" : `ok ${fmtRelative(lastOkAt, Date.now())}`}
              </span>
            </Tooltip>
            <Tooltip label="Open Configuration to review YARN and Burrow integration settings.">
              <a href="/tools/conf" aria-label="Open Configuration" className="text-live hover:underline">
                conf →
              </a>
            </Tooltip>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {meta.isError && (
        <StaleErrorBanner
          title="Service status refresh failed; showing the last loaded values"
          error={meta.error}
          onRetry={() => void meta.refetch()}
        />
      )}
      <dl
        className="m-0 grid grid-cols-1 divide-y divide-seam-soft rounded-lg border border-seam-soft bg-well sm:grid-cols-3 sm:divide-y-0 sm:divide-x"
        data-testid="services"
      >
        {AUXILIARY_SERVICES.map(({ key, label }) => (
          <div
            key={key}
            className="flex items-center justify-between gap-3 p-3"
            data-testid={`service-${label.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <dt className="text-small text-ink-2">{label}</dt>
            <dd className="m-0 shrink-0">
              <StatusPill domain="service" state={serviceState(m.services[key])} size="sm" />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
