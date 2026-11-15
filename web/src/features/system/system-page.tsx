/**
 * `/system` — Burrow's own runtime: process health, client traffic, memory and recent failures.
 *
 * The page owns no user state and no SSE topic. It polls `/api/system` on the shared live cadence and lays the
 * fixed contract out with the shared ops chrome from `features/nodes/page`. Values Burrow cannot obtain (platform
 * memory counters) render an explicit `Unavailable`, never a fake zero.
 */
import { Check, RefreshCw } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { q } from "~/api/queries";
import { useStableQuery } from "~/api/use-stable-query";
import { Field, KvGrid, PageHead, Section, Stat } from "~/features/nodes/page";
import { useNow } from "~/features/shell/use-now";
import { fmtBytes, fmtClock, fmtDuration, fmtInt, fmtPct, fmtRelative } from "~/lib/format";
import { useScrollRestore } from "~/lib/use-scroll-restore";
import { Button } from "~/ui/button";
import { AreaChart, type Point } from "~/ui/charts";
import { DetailTableScroller } from "~/ui/detail-table-scroller";
import { EmptyState, ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";

const SCROLL = "burrow-scroll burrow-page-scroll min-h-0 flex-1 overflow-y-auto pb-6";
const PANEL = "rounded-lg border border-seam bg-fabric p-(--gap-card)";

function requestSample(point: Point): string {
  return `${fmtInt(point.v)} requests at ${fmtClock(point.t)}`;
}

function memorySample(point: Point): string {
  return `${fmtBytes(point.v * 1024 * 1024)} at ${fmtClock(point.t)}`;
}

/** Round a chart ceiling up so the three y-axis labels stay whole numbers. */
function axisMax(value: number, step: number): number {
  return Math.max(step, Math.ceil(value / step) * step);
}

/** Format an API latency sample without collapsing sub-millisecond values to `0 ms`. */
function fmtLatency(ms: number): string {
  return ms > 0 && ms < 1 ? `${Math.round(ms * 1000)} µs` : fmtDuration(ms);
}

function SystemSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading system metrics"
      className="mx-auto flex w-full max-w-[1560px] flex-col gap-4"
      data-page-motion="content"
    >
      <header className="flex flex-col gap-2 pb-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </header>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-20 rounded-lg" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-52 rounded-lg" />
        <Skeleton className="h-52 rounded-lg" />
      </div>
      <Skeleton className="h-64 rounded-lg" />
      <Skeleton className="h-40 rounded-lg" />
    </div>
  );
}

export function SystemPage() {
  const { data, error, isPending, dataUpdatedAt, refetch } = useStableQuery(q.system());
  const now = useNow();
  const retry = () => void refetch();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [savedScroll] = useState(() => Number(sessionStorage.getItem("burrow.system.scroll") ?? "0"));
  useScrollRestore(scrollRef, "burrow.system.scroll", true);
  useLayoutEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    return () => {
      history.scrollRestoration = previous;
    };
  }, []);

  if (isPending) {
    return (
      <div ref={scrollRef} data-testid="system" className={SCROLL}>
        <div style={savedScroll > 0 ? { minHeight: `calc(100% + ${savedScroll}px)` } : undefined}>
          <SystemSkeleton />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div ref={scrollRef} data-testid="system" className={SCROLL}>
        <div className="mx-auto flex w-full max-w-[1560px] flex-col gap-4" data-page-motion="content">
          <PageHead title="System" description="Burrow's own process, traffic and connected clients" />
          <ErrorState
            title="Cannot read Burrow's system metrics"
            error={error}
            hint="The backend serves this endpoint itself; no ResourceManager round trip is involved."
            onRetry={retry}
          />
        </div>
      </div>
    );
  }

  const { process, clients, requests, memoryHistory, recentErrors, cache } = data;
  const memory = process.memory;
  const serverFailures = requests.byStatus["5xx"];
  const requestPoints: Point[] = requests.history.map((bucket) => ({ t: bucket.atMs, v: bucket.requests }));
  const memoryPoints: Point[] = memoryHistory.map((sample) => ({ t: sample.atMs, v: sample.rssBytes / (1024 * 1024) }));
  const requestMax = axisMax(Math.max(1, ...requestPoints.map((point) => point.v)), 10);
  const memoryMax = axisMax(Math.max(1, ...memoryPoints.map((point) => point.v)), 16);
  const cacheLookups = cache.hits + cache.misses;
  const hitRate = cacheLookups === 0 ? null : (cache.hits / cacheLookups) * 100;
  const windowMinutes = Math.round(clients.windowSeconds / 60);

  return (
    <div ref={scrollRef} data-testid="system" className={SCROLL}>
      <div className="mx-auto flex w-full max-w-[1560px] flex-col gap-4" data-page-motion="content">
        <PageHead
          title="System"
          description="Burrow's own process, traffic and connected clients"
          actions={
            <>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-small leading-none text-ink-3">
                <span className="relative size-2 rounded-full bg-live" aria-hidden="true" />
                Live · updated {fmtRelative(dataUpdatedAt, now)}
              </span>
              <Button variant="quiet" size="sm" onClick={retry} aria-label="Refresh system metrics">
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Refresh
              </Button>
            </>
          }
        />

        {error && <StaleErrorBanner title="System metrics refresh failed; showing the last reading" error={error} onRetry={retry} />}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            label="Active browsers"
            value={fmtInt(clients.active)}
            sub={`${fmtInt(clients.streams)} live stream${clients.streams === 1 ? "" : "s"} · last ${windowMinutes} min`}
            tone="ok"
          />
          <Stat
            label="Process RSS"
            value={memory.rssBytes == null ? "Unavailable" : fmtBytes(memory.rssBytes)}
            sub={memory.rssBytes == null ? "platform does not report process memory" : `peak ${fmtBytes(memory.peakRssBytes)}`}
          />
          <Stat
            label="Failed requests"
            value={fmtInt(serverFailures)}
            sub={`${fmtInt(requests.errorsLast15m)} in the last 15 min · ${fmtInt(requests.byStatus["4xx"])} client errors`}
            tone={serverFailures > 0 ? "fail" : "ok"}
          />
          <Stat label="Uptime" value={fmtDuration(process.uptimeSeconds * 1000)} sub={`since ${fmtClock(process.startedAtMs)}`} />
          <Stat label="API latency" value={fmtLatency(requests.p95Ms)} sub={`p50 ${fmtLatency(requests.p50Ms)}`} />
        </div>
        <p className="text-micro text-ink-3">
          Active browsers are distinct browser cookies seen in the last {windowMinutes} minutes. Live streams are open event streams.
        </p>

        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Requests per minute" className={PANEL}>
            <AreaChart
              points={requestPoints}
              domain={[0, requestMax]}
              unit=" req"
              height={120}
              label="Requests per minute over the last 15 minutes"
              sampleAriaLabel="Request history samples"
              sampleTooltip={requestSample}
              timeLabel={fmtClock}
            />
            <p className="text-micro text-ink-3">
              15 one-minute buckets · {fmtInt(requests.total)} responses since startup · p95 {fmtLatency(requests.p95Ms)}
            </p>
          </Section>

          <Section title="Memory over time" className={PANEL}>
            <AreaChart
              points={memoryPoints}
              domain={[0, memoryMax]}
              unit=" MiB"
              height={120}
              label="Process RSS over the last 15 minutes"
              sampleAriaLabel="Memory history samples"
              sampleTooltip={memorySample}
              timeLabel={fmtClock}
            />
            <p className="text-micro text-ink-3">Sampled at most every 5 seconds · peak {fmtBytes(memory.peakRssBytes)}</p>
          </Section>
        </div>

        <Section title="Recent errors" className={PANEL}>
          {recentErrors.length === 0 ? (
            <EmptyState compact title="No errors since startup" icon={<Check className="size-4" aria-hidden="true" />} />
          ) : (
            <DetailTableScroller
              ariaLabel="Recent failed requests"
              maxHeight="20rem"
              scrollKey="burrow.system.errors"
              className="rounded-lg border border-seam bg-fabric"
            >
              <table className="w-full min-w-140 border-collapse text-small">
                <caption className="sr-only">Recent failed requests, newest first</caption>
                <thead className="sticky top-0 z-10 bg-fabric-2 text-micro uppercase tracking-wide text-ink-4">
                  <tr>
                    <th scope="col" className="px-3 py-1.5 text-start font-medium">
                      Time
                    </th>
                    <th scope="col" className="px-3 py-1.5 text-start font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-1.5 text-start font-medium">
                      Method
                    </th>
                    <th scope="col" className="px-3 py-1.5 text-start font-medium">
                      Path
                    </th>
                    <th scope="col" className="px-3 py-1.5 text-end font-medium">
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recentErrors.slice(0, 20).map((row, index) => (
                    <tr key={`${row.atMs}-${row.method}-${row.path}-${row.status}-${index}`} className="border-t border-seam-soft">
                      <td className="px-3 py-1.5 tnum text-ink-3">{fmtClock(row.atMs)}</td>
                      <td className="px-3 py-1.5 font-medium tnum text-fail">{fmtInt(row.status)}</td>
                      <td className="px-3 py-1.5 text-ink-2">{row.method}</td>
                      <td className="px-3 py-1.5 font-mono text-ink-2">{row.path}</td>
                      <td className="px-3 py-1.5 text-end tnum text-ink-3">{fmtLatency(row.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DetailTableScroller>
          )}
        </Section>

        <Section title="Runtime" className={PANEL}>
          <KvGrid columns={3} className="border-0 bg-transparent p-0">
            <Field label="Version">
              <span className="tnum">{process.version}</span>
            </Field>
            <Field label="PID">
              <span className="tnum">{fmtInt(process.pid)}</span>
            </Field>
            <Field label="Uptime">
              <span className="tnum">{fmtDuration(process.uptimeSeconds * 1000)}</span>
            </Field>
            <Field label="Started">
              <span className="tnum">{fmtClock(process.startedAtMs)}</span>
            </Field>
            <Field label="In flight">
              <span className="tnum">{fmtInt(requests.inFlight)}</span>
            </Field>
            <Field label="Live streams">
              <span className="tnum">{fmtInt(clients.streams)}</span>
            </Field>
            <Field label="Cache hit rate">
              <span className="tnum">{hitRate == null ? "—" : fmtPct(hitRate, 1)}</span>
            </Field>
            <Field label="Cache entries">
              <span className="tnum">{fmtInt(cache.entries)}</span>
            </Field>
            <Field label="Cache bytes">
              <span className="tnum">{fmtBytes(cache.bytes)}</span>
            </Field>
            <Field label="Virtual memory">
              {memory.virtualBytes == null ? (
                <span className="text-ink-3">Unavailable</span>
              ) : (
                <span className="tnum">{fmtBytes(memory.virtualBytes)}</span>
              )}
            </Field>
          </KvGrid>
        </Section>
      </div>
    </div>
  );
}
