import { useQuery } from "@tanstack/react-query";
import { ov } from "~/api/queries/overview";
import { useConnection } from "~/api/connection";
import type { Meta, MetaService } from "~/api/schemas";
import { fmtEpoch, fmtRelative } from "~/lib/format";
import { PREF_DEFAULTS, usePref } from "~/state/prefs";
import { useMounted } from "~/lib/use-mounted";
import { ErrorState } from "~/ui/feedback";
import { StatusPill } from "~/ui/status";
import { HelpTip } from "~/ui/tooltip";

const FEATURES = [
  { key: "sparkLive", label: "Live Spark UI" },
  { key: "sparkHistory", label: "Spark history support" },
  { key: "aggregatedLogs", label: "Aggregated container logs" },
  { key: "nodeLogs", label: "NodeManager logs" },
  { key: "events", label: "Live updates" },
  { key: "kerberos", label: "Kerberos authentication" },
] as const satisfies readonly { key: keyof Meta["features"]; label: string }[];

const SERVICES = [
  { key: "sparkHistory", label: "Spark History Server" },
  { key: "jobHistory", label: "Job History Server" },
  { key: "timeline", label: "Timeline Service" },
] as const satisfies readonly { key: keyof Meta["services"]; label: string }[];

function serviceState(service: MetaService): "configured" | "reachable" | "unreachable" | "unconfigured" {
  if (!service.configured) return "unconfigured";
  if (service.reachable === false) return "unreachable";
  if (service.reachable === true) return "reachable";
  return "configured";
}

export function BurrowCapabilities() {
  const meta = useQuery(ov.meta());
  const lastOkAt = useConnection((state) => state.lastOkAt);
  const failures = useConnection((state) => state.consecutiveFailures);
  const lastError = useConnection((state) => state.lastError);
  const mounted = useMounted();
  const storedTz = usePref("tz");
  const tz = mounted ? storedTz : PREF_DEFAULTS.tz;
  const capabilities = meta.data;
  const apiStatus =
    failures > 0 ? `${failures} failed requests` : lastOkAt == null ? "Waiting for response" : `OK ${fmtRelative(lastOkAt, Date.now())}`;

  return (
    <section
      id="Burrow-capabilities"
      className="order-1 flex flex-col gap-2 rounded-lg border border-seam-soft bg-well p-3 md:order-1"
      data-testid="Burrow-capabilities"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="m-0 text-h3">Capabilities</h2>
        <dl className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-small">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-3">Access</dt>
            <dd className="m-0 text-ink-2">{capabilities ? (capabilities.readOnly ? "Read-only" : "Read/write") : "Unknown"}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="flex items-center gap-1 text-ink-3">
              Connection
              <HelpTip label="Connection status">
                {lastError ??
                  (lastOkAt != null
                    ? `Last successful API response at ${fmtEpoch(lastOkAt, tz)}.`
                    : "Burrow has not received a successful API response yet.")}
              </HelpTip>
            </dt>
            <dd className={failures > 0 ? "m-0 text-fail" : "m-0 text-ink-2"}>{apiStatus}</dd>
          </div>
        </dl>
      </div>
      {meta.error && (
        <ErrorState
          compact
          title={capabilities ? "Capability refresh failed; showing the last loaded data" : "Could not load Burrow capabilities"}
          message={meta.error instanceof Error ? meta.error.message : String(meta.error)}
          onRetry={() => void meta.refetch()}
        />
      )}
      {capabilities ? (
        <>
          <h3 className="m-0 text-micro font-medium tracking-wide text-ink-3 uppercase">Features</h3>
          <ul className="m-0 grid list-none grid-cols-1 gap-x-5 gap-y-1 p-0 text-small sm:grid-cols-2 xl:grid-cols-3">
            {FEATURES.map(({ key, label }) => {
              const available = capabilities.features[key];
              return (
                <li key={key} className="flex min-w-0 items-center justify-between gap-3">
                  <span className="truncate text-ink-2">{label}</span>
                  <span className={available ? "shrink-0 text-live" : "shrink-0 text-ink-4"}>
                    {available ? "Supported" : "Not supported"}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-seam-soft pt-3">
            <h3 className="mb-2 mt-0 text-micro font-medium tracking-wide text-ink-3 uppercase">Service endpoints</h3>
            <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-3">
              {SERVICES.map(({ key, label }) => {
                const service = capabilities.services[key];
                const status = serviceState(service);
                const detail =
                  service.urls?.join(", ") ||
                  service.url ||
                  service.reason ||
                  (service.configured ? "No endpoint reported" : "No URL configured or discovered");
                const probeDetails = service.candidates?.length
                  ? service.candidates
                      .map((candidate) => `${candidate.url}: ${candidate.reachable ? "reachable" : (candidate.reason ?? "unreachable")}`)
                      .join("\n")
                  : detail;
                return (
                  <li key={key} className="min-w-0 rounded-md border border-seam-soft bg-fabric px-2.5 py-2">
                    <div className="flex min-w-0 items-center justify-between gap-2 text-small">
                      <span className="truncate text-ink-2">{label}</span>
                      <StatusPill domain="service" state={status} size="sm" />
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1">
                      <div className="min-w-0 truncate font-mono text-micro text-ink-4">{detail}</div>
                      <HelpTip label={`${label} endpoint probes`}>{probeDetails}</HelpTip>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      ) : (
        !meta.error && <p className="m-0 text-small text-ink-3">Capability details are unavailable.</p>
      )}
    </section>
  );
}
