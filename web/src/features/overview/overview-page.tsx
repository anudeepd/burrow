/**
 * The Overview page: at-a-glance cluster state, composed of sections that each own their own source and their own
 * failure mode (see `docs/contracts/api.md`). The page itself only arranges them and owns the one piece of URL state —
 * the utilisation-history window — so the whole view stays linkable.
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useMounted } from "~/lib/use-mounted";
import { useParity } from "~/state/parity";
import { ov } from "~/api/queries/overview";
import { Button } from "~/ui/button";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "~/ui/menu";
import type { ClusterMetrics } from "~/api/schemas";
import { ClusterIdentity } from "./cluster-identity";
import { ClusterMetricsSection, ResourceManagerMetricsSection } from "./cluster-metrics";
import { ActiveRail } from "./active-rail";
import { OverviewAttentionSummary } from "./attention-summary";
import { NodeStatesSection } from "./node-states";
import { SchedulerSection } from "./scheduler";
import { ServicesHealthSection } from "./services-health";
import { CrossLink, Section } from "./ui";
import { HISTORY_WINDOWS, type HistoryWindow } from "./derive";

export type { HistoryWindow };

const OVERVIEW_SECTIONS = [
  { id: "overview-cluster-metrics", label: "Cluster metrics" },
  { id: "overview-rm-counters", label: "ResourceManager counters" },
  { id: "overview-cluster-identity", label: "Cluster identity" },
  { id: "overview-service-health", label: "Service health" },
  { id: "overview-scheduler", label: "Scheduler" },
  { id: "overview-node-states", label: "Node states" },
  { id: "overview-active-applications", label: "Active applications" },
] as const;

function OverviewGroup({
  id,
  title,
  layout,
  children,
}: {
  id: string;
  title: string;
  layout: "state" | "capacity" | "workload";
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="burrow-overview-group">
      <h2 id={`${id}-title`} className="burrow-overview-group-title text-h2">
        {title}
      </h2>
      <div className={`burrow-overview-group-grid burrow-overview-group-grid--${layout}`} data-page-motion="cards">
        {children}
      </div>
    </section>
  );
}

function OverviewJumpMenu() {
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <Button size="sm" variant="quiet" aria-label="Jump to an overview section">
            Jump to <ChevronDown className="size-3.5 text-ink-3" aria-hidden="true" />
          </Button>
        }
      />
      <MenuContent align="end" className="max-h-[min(20rem,calc(100dvh-2rem))] w-56 overflow-y-auto">
        {OVERVIEW_SECTIONS.map((section) => (
          <MenuItem key={section.id} href={`#${section.id}`}>
            {section.label}
          </MenuItem>
        ))}
      </MenuContent>
    </MenuRoot>
  );
}

export function OverviewPage({
  window: historyWindow,
  onHistoryWindow,
  renderVersion = "post",
}: {
  window: HistoryWindow;
  onHistoryWindow: (w: HistoryWindow) => void;
  renderVersion?: "pre" | "post";
}) {
  const isPre = renderVersion === "pre";
  const mounted = useMounted();
  const storedParity = useParity();
  const parity = mounted && storedParity;
  const metrics = useQuery(ov.metrics());
  const clusterMetrics = metrics.data as ClusterMetrics | undefined;

  return (
    // The shell's <main> is a fixed, non-scrolling region (pages own their scrolling, like /nodes and the app tables).
    // Without this wrapper the overview — the tallest page in the product — was clipped at the viewport with no
    // scrollbar. The shell already renders the page's <main>, so this is a plain div, not a second one.
    <div className="burrow-scroll burrow-page-scroll burrow-overview-page min-h-0 flex-1 overflow-y-auto pb-6" data-testid="overview">
      <div className="burrow-overview-content mx-auto flex w-full max-w-[1560px] flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-seam pb-5">
          <div>
            <h1 className="text-h1 font-semibold text-ink">{isPre ? "Cluster overview" : "Overview"}</h1>
            <p className="mt-1 max-w-3xl text-pretty text-body text-ink-3">A live view of YARN capacity, workload, and service health.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <OverviewJumpMenu />
            <div className="flex items-center gap-2 rounded-md border border-seam bg-fabric px-3 py-2 text-small text-ink-2">
              <span className="relative size-2 rounded-full bg-live" aria-hidden="true" />
              <span>Live cluster view</span>
              <span className="text-ink-4" aria-hidden="true">
                ·
              </span>
              <span className="text-ink-3">{clusterMetrics?.appsSubmitted ?? "—"} applications submitted</span>
            </div>
          </div>
        </header>

        {!isPre && <OverviewAttentionSummary metrics={clusterMetrics} metricsPending={metrics.isPending} metricsError={metrics.isError} />}

        <OverviewGroup id="overview-capacity" title="Capacity" layout="capacity">
          <Section
            title="Cluster metrics"
            headingLevel={3}
            id="overview-cluster-metrics"
            help="Application, container and resource totals reported by YARN. History charts collect samples while this tab is open; the selected window limits these local samples."
            hint={isPre ? "ResourceManager counters · /api/yarn/metrics" : undefined}
            actions={
              <div className="flex items-center gap-1.5" role="group" aria-label="Utilisation history window">
                <span className="text-micro text-ink-4 uppercase">history</span>
                {HISTORY_WINDOWS.map((w) => (
                  <Button
                    key={w.key}
                    size="sm"
                    variant={w.key === historyWindow ? "primary" : "quiet"}
                    aria-pressed={w.key === historyWindow}
                    onClick={() => onHistoryWindow(w.key)}
                    data-testid={`history-window-${w.key}`}
                  >
                    {w.label}
                  </Button>
                ))}
              </div>
            }
            className="burrow-overview-panel burrow-overview-panel--metrics min-w-0 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]"
          >
            <ClusterMetricsSection historyWindow={historyWindow} showRawAggregate={isPre} />
          </Section>

          {!isPre && (
            <Section
              title="ResourceManager counters"
              headingLevel={3}
              id="overview-rm-counters"
              help="ResourceManager cluster-wide memory and virtual-core counters: total, allocated, available, reserved, and pending. The YARN allocation figures in Cluster metrics sum scheduler capacity across partitions, so their totals can differ. Compare allocated with total within each source."
              className="burrow-overview-panel burrow-overview-panel--rm-counters min-w-0 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]"
            >
              <ResourceManagerMetricsSection />
            </Section>
          )}
        </OverviewGroup>

        <OverviewGroup id="overview-cluster-state" title="Cluster state" layout="state">
          <Section
            title="Cluster identity"
            headingLevel={3}
            id="overview-cluster-identity"
            help="ResourceManager identity, build versions and high-availability state. Times use the selected time zone."
            hint={isPre ? "Identity, versions and state · /api/yarn/info" : undefined}
            className="burrow-overview-panel burrow-overview-panel--identity min-w-0 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]"
          >
            <ClusterIdentity showUpstreamAnswer={isPre} />
          </Section>
          <Section
            title="Service health"
            headingLevel={3}
            id="overview-service-health"
            help="Status of Burrow's configured supporting services."
            hint={isPre ? "Configured services and capabilities · /api/meta" : undefined}
            className="burrow-overview-panel burrow-overview-panel--services min-w-0 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]"
          >
            <ServicesHealthSection renderVersion={isPre ? "pre" : "post"} />
          </Section>
        </OverviewGroup>

        <OverviewGroup id="overview-workload" title="Workload" layout="workload">
          <Section
            title="Scheduler"
            headingLevel={3}
            id="overview-scheduler"
            help="Queue guarantees, maximum capacity and current usage from the configured scheduler. Headroom is the remaining allocation allowed by each queue's limit."
            hint={isPre ? "Queue configuration and headroom · /api/yarn/scheduler" : undefined}
            actions={
              <CrossLink href="/scheduler" className="text-small text-live hover:underline">
                queue tree →
              </CrossLink>
            }
            className="burrow-overview-panel burrow-overview-panel--scheduler min-w-0 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]"
          >
            <SchedulerSection />
          </Section>
          <Section
            title="Node states"
            headingLevel={3}
            id="overview-node-states"
            help="ResourceManager node-state totals and registered NodeManagers. A node's health and physical utilisation are separate from YARN's allocated resources."
            hint={isPre ? "State counters and node inventory · /api/yarn/metrics + /api/yarn/nodes" : undefined}
            actions={
              <CrossLink href="/nodes" className="text-small text-live hover:underline">
                all nodes →
              </CrossLink>
            }
            className="burrow-overview-panel burrow-overview-panel--nodes min-w-0 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]"
          >
            <NodeStatesSection metrics={clusterMetrics} />
          </Section>
          <Section
            title="Active applications"
            headingLevel={3}
            id="overview-active-applications"
            help="Applications in New, New saving, Submitted, Accepted or Running YARN states. Pending applications may be waiting for queue capacity or resources. This section reports YARN application state; inspect Spark jobs and stages in each application's Spark tab."
            hint={isPre ? "NEW through RUNNING · /api/yarn/apps?states=…" : undefined}
            actions={
              <>
                {!isPre && (
                  <CrossLink
                    href="/apps?states=NEW,NEW_SAVING,SUBMITTED,ACCEPTED,RUNNING&type=SPARK"
                    className="text-small text-live hover:underline"
                  >
                    active Spark apps →
                  </CrossLink>
                )}
                <CrossLink href="/apps?states=NEW,NEW_SAVING,SUBMITTED,ACCEPTED,RUNNING" className="text-small text-live hover:underline">
                  all active apps →
                </CrossLink>
              </>
            }
            className="burrow-overview-panel burrow-overview-panel--active min-w-0 rounded-lg border border-seam bg-fabric p-[var(--gap-card)]"
          >
            <ActiveRail parity={parity} bordered={false} />
          </Section>
        </OverviewGroup>
      </div>
    </div>
  );
}
