/**
 * Spark storage detail — the native replacement for Spark's tracking-UI RDD page (`/storage/rdd/?id=N`).
 *
 * `RddDetailBody` is exported because the Storage list renders the same body inline for its `?rdd=` expansion: one
 * implementation for both, so the parity field ids (`spark.rdd.*`, `spark.rdd.partitions.*`, `spark.rdd.dataDistribution.*`)
 * cannot drift between the two entry points.
 *
 * Spark only reports RDDs whose blocks are still held, and it omits a distribution entry for executors holding none —
 * both are stated rather than papered over.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { ACTION_LINK_CLASS } from "~/ui/button";
import { Entity, Datum } from "~/ui/datum";
import { DetailTableScroller } from "~/ui/detail-table-scroller";
import { ProgressBar } from "~/ui/progress-bar";
import { utilizationTone } from "~/lib/progress-tone";
import { fmtFraction, fraction } from "../data/format";
import { sp } from "../data/queries";
import type { SparkRdd } from "../data/schemas";
import { Metric, MetricStrip, PageHeader } from "../ui/PageHeader";
import { InlineNote, SparkEmpty, SparkFailureState, SparkLoading, SparkStaleErrorBanner } from "../ui/StateViews";
import { useSpark } from "../ui/context";

const route = getRouteApi("/apps/$appId/spark/storage/$rddId");

/** Sum a distribution key across executors; null (→ "—") when Spark reported it for none. */
function sumOf(rdd: SparkRdd, pick: (d: SparkRdd["dataDistribution"][number]) => number | null | undefined): number | null {
  let any = false;
  let sum = 0;
  for (const d of rdd.dataDistribution) {
    const v = pick(d);
    if (v != null) {
      any = true;
      sum += v;
    }
  }
  return any ? sum : null;
}

/** Metric strip + partition table + executor distribution for one RDD. Wrapped in the RDD's `<Entity>`. */
export function RddDetailBody({ appId, rdd }: { appId: string; rdd: SparkRdd }) {
  const cached = rdd.numCachedPartitions ?? null;
  const totalParts = rdd.numPartitions ?? null;
  const distMemory = sumOf(rdd, (d) => d.memoryUsed);
  const distRemaining = sumOf(rdd, (d) => d.memoryRemaining);
  const distDisk = sumOf(rdd, (d) => d.diskUsed);

  return (
    <Entity id={String(rdd.id)} className="flex flex-col gap-3">
      <MetricStrip>
        <Metric label="RDD Id">
          <Datum field="spark.rdd.id" raw={rdd.id} fmt="int" />
        </Metric>
        <Metric label="Name">
          <Datum field="spark.rdd.name" raw={rdd.name} title={rdd.name ?? undefined} />
        </Metric>
        <Metric label="Storage Level">
          <Datum field="spark.rdd.storageLevel" raw={rdd.storageLevel} />
        </Metric>
        <Metric label="Cached / total partitions">
          <Datum field="spark.rdd.numCachedPartitions" raw={cached} fmt="int" />
          {" / "}
          <Datum field="spark.rdd.numPartitions" raw={totalParts} fmt="int" />
        </Metric>
        <Metric label="Fraction cached">
          <Datum field="spark.rdd.derived.fractionCached" raw={fraction(cached, totalParts)} fmt="text">
            {fmtFraction(cached, totalParts)}
          </Datum>
        </Metric>
        <Metric label="Size in memory">
          <Datum field="spark.rdd.memoryUsed" raw={rdd.memoryUsed} fmt="bytes" />
        </Metric>
        <Metric label="Size on disk">
          <Datum field="spark.rdd.diskUsed" raw={rdd.diskUsed} fmt="bytes" />
        </Metric>
        <Metric label="Distribution memory used">
          <Datum field="spark.rdd.derived.distributionMemoryUsed" raw={distMemory} fmt="bytes" />
        </Metric>
        <Metric label="Distribution memory remaining">
          <Datum field="spark.rdd.derived.distributionMemoryRemaining" raw={distRemaining} fmt="bytes" />
        </Metric>
        <Metric label="Distribution disk used">
          <Datum field="spark.rdd.derived.distributionDiskUsed" raw={distDisk} fmt="bytes" />
        </Metric>
      </MetricStrip>

      <RddPartitionsTable appId={appId} rdd={rdd} />
      <RddDataDistributionTable rdd={rdd} />
    </Entity>
  );
}

function RddPartitionsTable({ appId, rdd }: { appId: string; rdd: SparkRdd }) {
  const { attempt } = useSpark();
  const partitions = rdd.partitions;
  return (
    <section aria-label={`Partitions of RDD ${rdd.id}`} className="flex flex-col gap-2">
      <h3 className="text-body font-semibold text-ink">Partitions</h3>
      {partitions.length === 0 ? (
        <InlineNote>Spark reports no partitions for RDD {rdd.id} — its blocks are no longer held in memory or on disk.</InlineNote>
      ) : (
        <DetailTableScroller ariaLabel={`Partitions of RDD ${rdd.id}`} className="rounded-lg border border-seam bg-fabric">
          <table className="w-full min-w-[48rem] border-collapse text-small">
            <thead className="bg-fabric-2 text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-1.5 text-left font-medium">
                  Block Name
                </th>
                <th scope="col" className="px-3 py-1.5 text-left font-medium">
                  Storage Level
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Size in Memory
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Size on Disk
                </th>
                <th scope="col" className="px-3 py-1.5 text-left font-medium">
                  Executors
                </th>
              </tr>
            </thead>
            <tbody>
              {partitions.map((p, i) => (
                <tr key={p.blockName ?? `partition-${i}`} className="border-t border-seam-soft">
                  <td className="px-3 py-1.5">
                    <Datum field="spark.rdd.partitions.blockName" raw={p.blockName} className="font-mono text-micro" />
                  </td>
                  <td className="px-3 py-1.5">
                    <Datum field="spark.rdd.partitions.storageLevel" raw={p.storageLevel} />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Datum field="spark.rdd.partitions.memoryUsed" raw={p.memoryUsed} fmt="bytes" className="tnum" />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Datum field="spark.rdd.partitions.diskUsed" raw={p.diskUsed} fmt="bytes" className="tnum" />
                  </td>
                  <td className="px-3 py-1.5">
                    {p.executors.length === 0 ? (
                      <span className="text-ink-4">—</span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {p.executors.map((exec) => (
                          <Link
                            key={exec}
                            to="/apps/$appId/spark/executors"
                            params={{ appId }}
                            search={{ q: exec, attempt: attempt ?? undefined }}
                            className="text-live underline-offset-2 hover:underline"
                          >
                            <Datum field="spark.rdd.partitions.executors" raw={exec} className="font-mono text-micro" />
                          </Link>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DetailTableScroller>
      )}
    </section>
  );
}

function RddDataDistributionTable({ rdd }: { rdd: SparkRdd }) {
  const dist = rdd.dataDistribution;
  return (
    <section aria-label={`Executor distribution of RDD ${rdd.id}`} className="flex flex-col gap-2">
      <h3 className="text-body font-semibold text-ink">Executor distribution</h3>
      {dist.length === 0 ? (
        <InlineNote>Spark reports no per-executor distribution for RDD {rdd.id}.</InlineNote>
      ) : (
        <DetailTableScroller ariaLabel={`Executor distribution of RDD ${rdd.id}`} className="rounded-lg border border-seam bg-fabric">
          <table className="w-full min-w-[54rem] border-collapse text-small">
            <thead className="bg-fabric-2 text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-1.5 text-left font-medium">
                  Address
                </th>
                <th scope="col" className="px-3 py-1.5 text-left font-medium">
                  Memory used / remaining
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Disk used
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  On-heap used
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Off-heap used
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  On-heap remaining
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Off-heap remaining
                </th>
              </tr>
            </thead>
            <tbody>
              {dist.map((d, i) => {
                const used = d.memoryUsed ?? 0;
                const remaining = d.memoryRemaining ?? 0;
                const basis = used + remaining;
                const pct = basis > 0 ? (100 * used) / basis : 0;
                return (
                  <tr key={d.address ?? `executor-${i}`} className="border-t border-seam-soft">
                    <td className="px-3 py-1.5">
                      <Datum field="spark.rdd.dataDistribution.address" raw={d.address} className="font-mono text-micro" />
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="flex min-w-[9rem] items-center gap-1 tnum">
                          <Datum field="spark.rdd.dataDistribution.memoryUsed" raw={d.memoryUsed} fmt="bytes" />
                          <span className="text-ink-4">/</span>
                          <Datum
                            field="spark.rdd.dataDistribution.memoryRemaining"
                            raw={d.memoryRemaining}
                            fmt="bytes"
                            className="text-ink-3"
                          />
                        </span>
                        <ProgressBar
                          percent={pct}
                          tone={utilizationTone(pct)}
                          className="min-w-[64px] flex-1"
                          label={`RDD ${rdd.id} memory used on ${d.address ?? "executor"}: ${pct.toFixed(0)}% of used + remaining`}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Datum field="spark.rdd.dataDistribution.diskUsed" raw={d.diskUsed} fmt="bytes" className="tnum" />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Datum field="spark.rdd.dataDistribution.onHeapMemoryUsed" raw={d.onHeapMemoryUsed} fmt="bytes" className="tnum" />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Datum field="spark.rdd.dataDistribution.offHeapMemoryUsed" raw={d.offHeapMemoryUsed} fmt="bytes" className="tnum" />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Datum
                        field="spark.rdd.dataDistribution.onHeapMemoryRemaining"
                        raw={d.onHeapMemoryRemaining}
                        fmt="bytes"
                        className="tnum"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Datum
                        field="spark.rdd.dataDistribution.offHeapMemoryRemaining"
                        raw={d.offHeapMemoryRemaining}
                        fmt="bytes"
                        className="tnum"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DetailTableScroller>
      )}
    </section>
  );
}

export function RddDetailPage() {
  const { appId, rddId } = route.useParams();
  const { kind, attempt } = useSpark();

  const rddQ = useQuery(sp.rdd(appId, rddId, kind, attempt));
  const rdd = rddQ.data?.rdd;

  if (rddQ.isPending) return <SparkLoading rows={8} cols={8} />;
  if (rddQ.error && !rdd) return <SparkFailureState error={rddQ.error} subject={`RDD ${rddId}`} onRetry={() => void rddQ.refetch()} />;
  if (!rdd) {
    return (
      <SparkEmpty title={`RDD ${rddId} is not cached in this application`}>
        Spark reports a block here only while it is still held in memory or on disk; evicted blocks disappear from the list.
      </SparkEmpty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {rddQ.error && <SparkStaleErrorBanner error={rddQ.error} subject={`RDD ${rddId}`} onRetry={() => void rddQ.refetch()} />}
      <PageHeader
        title={
          <Entity id={String(rdd.id)} as="span" className="flex items-center gap-2">
            <span>RDD {rdd.id}</span>
          </Entity>
        }
        description={
          <Entity id={String(rdd.id)} as="span">
            <Datum field="spark.rdd.name" raw={rdd.name} />
          </Entity>
        }
      >
        <Link to="/apps/$appId/spark/storage" params={{ appId }} search={{ attempt: attempt ?? undefined }} className={ACTION_LINK_CLASS}>
          <ArrowLeft className="size-3.5" aria-hidden="true" /> Storage
        </Link>
      </PageHeader>

      <RddDetailBody appId={appId} rdd={rdd} />
    </div>
  );
}
