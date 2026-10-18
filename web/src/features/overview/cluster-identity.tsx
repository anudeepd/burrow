/**
 * (a) Cluster identity & state strip — the legacy `/cluster/cluster` "Cluster overview" block (AboutBlock.java:43-53),
 * field for field, from `GET /api/yarn/info`.
 */
import { useQuery } from "@tanstack/react-query";
import { ov } from "~/api/queries/overview";
import { fmtEpoch, fmtIsoTimestamp } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { Datum, Entity, SINGLETON } from "~/ui/datum";
import { ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { StatusPill } from "~/ui/status";
import { StaleTag, useStale } from "./ui";
import { Tooltip } from "~/ui/tooltip";

/** `org.apache.hadoop.yarn.server.resourcemanager.recovery.NullRMStateStore` -> `NullRMStateStore`. */
function shortClassName(fqcn: string): string {
  const i = fqcn.lastIndexOf(".");
  return i < 0 ? fqcn : fqcn.slice(i + 1);
}

export function ClusterIdentity({ showUpstreamAnswer = false }: { showUpstreamAnswer?: boolean }) {
  const info = useQuery(ov.info());
  const stale = useStale();
  const tz = usePref("tz");

  if (info.isPending) {
    return (
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4" data-testid="identity-skeleton">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-2 w-24" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        ))}
      </div>
    );
  }
  if (info.isError && !info.data) {
    return (
      <ErrorState
        title="Cannot read the ResourceManager identity"
        message={info.error instanceof Error ? info.error.message : String(info.error ?? "The ResourceManager did not respond.")}
        hint="Try again in a moment. Other Overview sections remain available."
        onRetry={() => void info.refetch()}
      />
    );
  }

  const c = info.data;
  if (!c) return null;
  const rmVersionText = `${c.resourceManagerBuildVersion} on ${c.resourceManagerVersionBuiltOn}`;
  const hadoopVersionText = `${c.hadoopBuildVersion} on ${c.hadoopVersionBuiltOn}`;
  const rmVersionBuiltOn = fmtIsoTimestamp(c.resourceManagerVersionBuiltOn, tz);
  const hadoopVersionBuiltOn = fmtIsoTimestamp(c.hadoopVersionBuiltOn, tz);
  const rmVersionDisplayText = `${c.resourceManagerBuildVersion} on ${rmVersionBuiltOn}`;
  const hadoopVersionDisplayText = `${c.hadoopBuildVersion} on ${hadoopVersionBuiltOn}`;

  return (
    <>
      <Entity id={SINGLETON} as="dl" className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4" data-testid="identity">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-small tracking-wide text-ink-2 uppercase">Cluster ID</dt>
          <dd className="m-0">
            <Datum field="cluster.info.id" raw={c.id} fmt="id" className="mono text-body" />
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-small tracking-wide text-ink-2 uppercase">ResourceManager state</dt>
          <dd className="m-0 flex items-center gap-1.5">
            <Datum field="cluster.info.state" raw={c.state} fmt="text" className="text-body" />
            {stale && <StaleTag ageMs={info.dataUpdatedAt ? Date.now() - info.dataUpdatedAt : null} />}
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-small tracking-wide text-ink-2 uppercase">HA state</dt>
          <dd className="m-0">
            <StatusPill domain="rm.haState" state={c.haState} field="cluster.info.haState" size="sm" />
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-small tracking-wide text-ink-2 uppercase">HA zookeeper connection state</dt>
          <dd className="m-0 min-w-0">
            <Datum
              field="cluster.info.haZooKeeperConnectionState"
              raw={c.haZooKeeperConnectionState ?? null}
              fmt="text"
              className="block min-w-0 whitespace-normal break-words text-body"
            />
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-small tracking-wide text-ink-2 uppercase">RMStateStore</dt>
          <dd className="m-0 min-w-0">
            <Tooltip label={c.rmStateStoreName}>
              <Datum
                field="cluster.info.rmStateStoreName"
                raw={c.rmStateStoreName}
                fmt="text"
                className="block truncate text-body"
                aria-label={c.rmStateStoreName}
              >
                {shortClassName(c.rmStateStoreName)}
              </Datum>
            </Tooltip>
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-small tracking-wide text-ink-2 uppercase">Started on</dt>
          <dd className="m-0">
            <Datum field="cluster.info.startedOn" raw={c.startedOn} fmt="epoch" className="text-body" />
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-small tracking-wide text-ink-2 uppercase">ResourceManager version</dt>
          <dd className="m-0 min-w-0">
            {/* The visible value is the legacy "build on …" string; the two primitives it is derived from are nested. */}
            <Tooltip label={rmVersionDisplayText}>
              <Datum
                field="cluster.info.derived.rmVersionText"
                raw={rmVersionText}
                fmt="text"
                className="block whitespace-normal text-body [overflow-wrap:anywhere]"
              >
                <span className="font-medium">
                  <Datum field="cluster.info.resourceManagerVersion" raw={c.resourceManagerVersion} fmt="text">
                    {c.resourceManagerVersion}
                  </Datum>
                </span>
                <span className="text-ink-3"> on </span>
                <Datum
                  field="cluster.info.resourceManagerVersionBuiltOn"
                  raw={c.resourceManagerVersionBuiltOn}
                  fmt="text"
                  className="text-ink-3"
                >
                  {rmVersionBuiltOn}
                </Datum>
              </Datum>
            </Tooltip>
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-small tracking-wide text-ink-2 uppercase">Hadoop version</dt>
          <dd className="m-0 min-w-0">
            <Tooltip label={hadoopVersionDisplayText}>
              <Datum
                field="cluster.info.derived.hadoopVersionText"
                raw={hadoopVersionText}
                fmt="text"
                className="block whitespace-normal text-body [overflow-wrap:anywhere]"
              >
                <span className="font-medium">
                  <Datum field="cluster.info.hadoopVersion" raw={c.hadoopVersion} fmt="text">
                    {c.hadoopVersion}
                  </Datum>
                </span>
                <span className="text-ink-3"> on </span>
                <Datum field="cluster.info.hadoopVersionBuiltOn" raw={c.hadoopVersionBuiltOn} fmt="text" className="text-ink-3">
                  {hadoopVersionBuiltOn}
                </Datum>
              </Datum>
            </Tooltip>
          </dd>
        </div>
      </Entity>
      {info.isError && (
        <StaleErrorBanner
          title="Cluster identity refresh failed; showing the last loaded values"
          error={info.error}
          onRetry={() => void info.refetch()}
        />
      )}
      {showUpstreamAnswer && info.dataUpdatedAt > 0 && (
        <p className="m-0 mt-2 text-micro text-ink-4">last upstream answer {fmtEpoch(info.dataUpdatedAt, tz)}</p>
      )}
    </>
  );
}
