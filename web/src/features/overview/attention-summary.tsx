import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Info } from "lucide-react";
import type { ClusterMetrics } from "~/api/schemas";
import { ov } from "~/api/queries/overview";
import { utilizationTone } from "~/lib/progress-tone";
import { fmtInt, fmtMB, fmtPct } from "~/lib/format";
import { Skeleton } from "~/ui/feedback";
import { HelpTip } from "~/ui/tooltip";
import { CrossLink } from "./ui";

const SUPPORTING_SERVICES = [
  { key: "sparkHistory", label: "Spark History" },
  { key: "jobHistory", label: "Job History" },
  { key: "timeline", label: "Timeline Service" },
] as const;

type Finding = {
  key: string;
  label: string;
  href: string;
  local?: boolean;
};

function FindingLink({ finding }: { finding: Finding }) {
  const content = (
    <>
      <span>{finding.label}</span>
      <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
    </>
  );

  if (finding.local) {
    return (
      <a
        href={finding.href}
        className="burrow-touch-link inline-flex max-w-full items-center gap-1 rounded-sm text-caption text-ink-2 underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live"
      >
        {content}
      </a>
    );
  }

  return (
    <CrossLink
      href={finding.href}
      className="inline-flex max-w-full items-center gap-1 rounded-sm text-caption text-ink-2 underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live"
    >
      {content}
    </CrossLink>
  );
}

export function OverviewAttentionSummary({
  metrics,
  metricsPending,
  metricsError,
}: {
  metrics: ClusterMetrics | undefined;
  metricsPending: boolean;
  metricsError: boolean;
}) {
  const meta = useQuery(ov.meta());

  if (!metrics && metricsPending && meta.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading cluster attention summary"
        className="flex flex-col gap-2 rounded-md border border-seam-soft bg-well px-3 py-2.5"
      >
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-56 max-w-full" />
      </div>
    );
  }

  const findings: Finding[] = [];

  if (meta.data?.rm.reachable === false) {
    findings.push({ key: "resource-manager", label: "ResourceManager unreachable", href: "#overview-cluster-identity", local: true });
  }

  if (metrics && metrics.unhealthyNodes > 0) {
    const count = metrics.unhealthyNodes;
    findings.push({
      key: "unhealthy-nodes",
      label: `${fmtInt(count)} ${count === 1 ? "unhealthy node" : "unhealthy nodes"}`,
      href: "/nodes?states=UNHEALTHY",
    });
  }

  if (metrics && metrics.lostNodes > 0) {
    const count = metrics.lostNodes;
    findings.push({
      key: "lost-nodes",
      label: `${fmtInt(count)} ${count === 1 ? "lost node" : "lost nodes"}`,
      href: "/nodes?states=LOST",
    });
  }

  if (metrics) {
    const memoryPct = metrics.totalMB > 0 ? (metrics.allocatedMB / metrics.totalMB) * 100 : null;
    const vcorePct = metrics.totalVirtualCores > 0 ? (metrics.allocatedVirtualCores / metrics.totalVirtualCores) * 100 : null;
    const isHigh = (percent: number | null) => {
      const tone = utilizationTone(percent);
      return tone === "warn" || tone === "fail";
    };
    const pressure: string[] = [];

    if (isHigh(vcorePct)) {
      pressure.push(
        `${fmtInt(metrics.allocatedVirtualCores)} of ${fmtInt(metrics.totalVirtualCores)} vCores allocated (${fmtPct(vcorePct, 0)})`,
      );
    }
    if (isHigh(memoryPct)) {
      pressure.push(`${fmtMB(metrics.allocatedMB)} of ${fmtMB(metrics.totalMB)} memory allocated (${fmtPct(memoryPct, 0)})`);
    }

    if (pressure.length > 0) {
      findings.push({
        key: "capacity",
        label: `ResourceManager allocation high: ${pressure.join(" · ")}`,
        href: "#overview-rm-counters",
        local: true,
      });
    }
  }

  for (const service of SUPPORTING_SERVICES) {
    const status = meta.data?.services[service.key];
    if (status?.configured && status.reachable === false) {
      findings.push({
        key: service.key,
        label: `${service.label} unreachable`,
        href: "#overview-service-health",
        local: true,
      });
    }
  }

  const hasUnprobedService = SUPPORTING_SERVICES.some(({ key }) => {
    const service = meta.data?.services[key];
    return service?.configured === true && service.reachable == null;
  });
  const complete = Boolean(metrics && meta.data) && !metricsError && !meta.isError && !hasUnprobedService;
  const title = findings.length > 0 ? "Needs attention" : complete ? "No current exceptions" : "Status summary incomplete";
  const description =
    findings.length > 0
      ? complete
        ? undefined
        : "Known conditions are shown below; some node, service, or ResourceManager counter sources could not be confirmed."
      : complete
        ? "No unhealthy or lost nodes, unreachable configured services, or ResourceManager allocation at 85% or higher is reported."
        : "Some node, service, or ResourceManager counter status could not be confirmed; see the sections below.";

  const Icon = findings.length > 0 ? AlertTriangle : complete ? CheckCircle2 : Info;

  return (
    <aside
      aria-labelledby="overview-attention-title"
      className={`flex min-w-0 items-start gap-2.5 rounded-md border px-3 py-2.5 ${findings.length > 0 ? "border-warn/40 bg-warn/5" : "border-seam-soft bg-well"}`}
      data-testid="overview-attention"
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${findings.length > 0 ? "text-warn" : complete ? "text-ok" : "text-ink-3"}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <h2 className="m-0 flex items-center gap-1.5 text-small font-semibold text-ink" id="overview-attention-title">
          {title}
          <HelpTip label="Cluster attention summary">
            Reports unhealthy or lost nodes, unreachable configured services, and ResourceManager memory or vCore allocation at 85% or
            higher. Capacity uses ResourceManager counters; scheduler partition totals are shown separately.
          </HelpTip>
        </h2>
        {description && <p className="m-0 mt-0.5 text-caption text-ink-3">{description}</p>}
        {findings.length > 0 && (
          <ul className="m-0 mt-1 flex list-none flex-wrap gap-x-4 gap-y-1 p-0" aria-label="Reported conditions">
            {findings.map((finding) => (
              <li key={finding.key}>
                <FindingLink finding={finding} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
