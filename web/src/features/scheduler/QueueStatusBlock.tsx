/**
 * The legacy "Queue Status" blocks, with the legacy labels verbatim (CapacitySchedulerPage.LeafQueueInfoBlock /
 * renderCommonLeafQueueInfo, FairSchedulerPage.LeafQueueBlock / ParentQueueBlock) so the parity harness can compare
 * label→value pairs. Every value is a `Datum` with the literal REST key path relative to the queue object.
 *
 * Two documented deviations from the legacy rendering:
 *  - the legacy divides `absolute*Capacity` by 100 before appending "%", which prints "0.3%" for a 30% queue; we print the
 *    raw percentage (the REST value is already 0..100) and keep `data-yv` raw;
 *  - `configuredMaxResource` is serialized as a zero ResourceInfo even when the Java getter means "unlimited", so we show
 *    the zeros with an explicit "(unlimited)" note instead of silently printing "unlimited".
 */
import type { FairQueueInfo, ResourceInfo } from "~/api/schemas";
import type { CapacityRaw } from "./model";
import { Datum } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { fmtInt, fmtMB } from "~/lib/format";
import { KV, KVRow, KVRowGroup, Unavailable } from "./Chrome";
import { countText, orderingPolicyDisplayName, partitionText, pctText } from "./format";

const MAX_INT = 2147483647;

/** "2 GiB · 3 vCores" as two datums (the ResourceInfo leaves). */
function ResourceValue({
  memoryField,
  vcoresField,
  resource,
  suffix,
}: {
  memoryField: string;
  vcoresField: string;
  resource: ResourceInfo | null | undefined;
  suffix?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 tnum">
      <Datum field={memoryField} raw={resource?.memory} fmt="mb" className="text-ink-2">
        {resource ? fmtMB(resource.memory) : "—"}
      </Datum>
      <span className="text-ink-4">·</span>
      <Datum field={vcoresField} raw={resource?.vCores} fmt="int" className="text-ink-2">
        {resource ? `${fmtInt(resource.vCores)} vCores` : "—"}
      </Datum>
      {suffix && <span className="text-micro text-ink-4">{suffix}</span>}
    </span>
  );
}

function ResourceRow({
  label,
  memoryField,
  vcoresField,
  resource,
  suffix,
}: {
  label: string;
  memoryField: string;
  vcoresField: string;
  resource: ResourceInfo | null | undefined;
  suffix?: string;
}) {
  return (
    <KVRowGroup label={label}>
      <ResourceValue memoryField={memoryField} vcoresField={vcoresField} resource={resource} suffix={suffix} />
    </KVRowGroup>
  );
}

export function CapacityQueueStatus({ raw, leaf }: { raw: CapacityRaw; leaf: boolean }) {
  const cap = raw.capacities?.queueCapacitiesByPartition?.[0];
  const res = raw.resources?.resourceUsagesByPartition?.[0];
  const configuredMaxEmpty =
    cap?.configuredMaxResource != null && cap.configuredMaxResource.memory === 0 && cap.configuredMaxResource.vCores === 0;
  const weightUnset = cap?.weight == null || cap.weight < 0;
  return (
    <KV columns={2}>
      {leaf && (
        <KVRow label="Queue State" field="queue.state" raw={raw.state}>
          <StatusPill domain="queue.state" state={raw.state} size="sm" />
        </KVRow>
      )}
      <KVRowGroup label="Used Capacity">
        <span className="inline-flex items-baseline gap-1 tnum">
          <Datum field="queue.capacities.queueCapacitiesByPartition.usedCapacity" raw={cap?.usedCapacity} fmt="pct" className="text-ink-2">
            {pctText(cap?.usedCapacity ?? null)}
          </Datum>
          <span className="text-micro text-ink-4">
            of its capacity ({res?.used ? `${fmtMB(res.used.memory)} · ${fmtInt(res.used.vCores)} vCores` : "—"})
          </span>
        </span>
      </KVRowGroup>
      {!weightUnset ? (
        <KVRow label="Configured Weight" field="queue.capacities.queueCapacitiesByPartition.weight" raw={cap?.weight}>
          {cap?.weight == null ? "—" : String(cap.weight)}
        </KVRow>
      ) : (
        <ResourceRow
          label="Configured Capacity"
          memoryField="queue.capacities.queueCapacitiesByPartition.configuredMinResource.memory"
          vcoresField="queue.capacities.queueCapacitiesByPartition.configuredMinResource.vCores"
          resource={cap?.configuredMinResource}
        />
      )}
      <ResourceRow
        label="Configured Max Capacity"
        memoryField="queue.capacities.queueCapacitiesByPartition.configuredMaxResource.memory"
        vcoresField="queue.capacities.queueCapacitiesByPartition.configuredMaxResource.vCores"
        resource={cap?.configuredMaxResource}
        suffix={configuredMaxEmpty ? "(unlimited)" : undefined}
      />
      <KVRowGroup label="Effective Capacity">
        <span className="inline-flex items-baseline gap-1 tnum">
          <Datum
            field="queue.capacities.queueCapacitiesByPartition.effectiveMinResource.memory"
            raw={cap?.effectiveMinResource?.memory}
            fmt="mb"
            className="text-ink-2"
          >
            {cap?.effectiveMinResource ? fmtMB(cap.effectiveMinResource.memory) : "—"}
          </Datum>
          <span className="text-micro text-ink-4">
            (
            <Datum field="queue.capacities.queueCapacitiesByPartition.capacity" raw={cap?.capacity} fmt="pct">
              {pctText(cap?.capacity ?? null)}
            </Datum>
            )
          </span>
        </span>
      </KVRowGroup>
      <KVRowGroup label="Effective Max Capacity">
        <span className="inline-flex items-baseline gap-1 tnum">
          <Datum
            field="queue.capacities.queueCapacitiesByPartition.effectiveMaxResource.memory"
            raw={cap?.effectiveMaxResource?.memory}
            fmt="mb"
            className="text-ink-2"
          >
            {cap?.effectiveMaxResource ? fmtMB(cap.effectiveMaxResource.memory) : "—"}
          </Datum>
          <span className="text-micro text-ink-4">
            (
            <Datum field="queue.capacities.queueCapacitiesByPartition.maxCapacity" raw={cap?.maxCapacity} fmt="pct">
              {pctText(cap?.maxCapacity ?? null)}
            </Datum>
            )
          </span>
        </span>
      </KVRowGroup>
      <KVRow label="Absolute Used Capacity" field="queue.absoluteUsedCapacity" raw={raw.absoluteUsedCapacity} fmt="pct">
        {pctText(raw.absoluteUsedCapacity ?? null)}
      </KVRow>
      <KVRow label="Absolute Configured Capacity" field="queue.absoluteCapacity" raw={raw.absoluteCapacity} fmt="pct">
        {pctText(raw.absoluteCapacity ?? null)}
      </KVRow>
      <KVRow label="Absolute Configured Max Capacity" field="queue.absoluteMaxCapacity" raw={raw.absoluteMaxCapacity} fmt="pct">
        {pctText(raw.absoluteMaxCapacity ?? null)}
      </KVRow>
      <ResourceRow
        label="Used Resources"
        memoryField="queue.resources.resourceUsagesByPartition.used.memory"
        vcoresField="queue.resources.resourceUsagesByPartition.used.vCores"
        resource={res?.used}
      />
      <KVRow
        label="Configured Max Application Master Limit"
        field="queue.capacities.queueCapacitiesByPartition.maxAMLimitPercentage"
        raw={cap?.maxAMLimitPercentage}
        fmt="pct"
      >
        {pctText(cap?.maxAMLimitPercentage ?? null)}
      </KVRow>
      <ResourceRow
        label="Max Application Master Resources"
        memoryField="queue.resources.resourceUsagesByPartition.amLimit.memory"
        vcoresField="queue.resources.resourceUsagesByPartition.amLimit.vCores"
        resource={res?.amLimit}
      />
      <ResourceRow
        label="Used Application Master Resources"
        memoryField="queue.resources.resourceUsagesByPartition.amUsed.memory"
        vcoresField="queue.resources.resourceUsagesByPartition.amUsed.vCores"
        resource={res?.amUsed}
      />
      <ResourceRow
        label="Max Application Master Resources Per User"
        memoryField="queue.resources.resourceUsagesByPartition.userAmLimit.memory"
        vcoresField="queue.resources.resourceUsagesByPartition.userAmLimit.vCores"
        resource={res?.userAmLimit}
      />
      {leaf && (
        <>
          <KVRow label="Num Schedulable Applications" field="queue.numActiveApplications" raw={raw.numActiveApplications} fmt="int">
            {countText(raw.numActiveApplications ?? null)}
          </KVRow>
          <KVRow label="Num Non-Schedulable Applications" field="queue.numPendingApplications" raw={raw.numPendingApplications} fmt="int">
            {countText(raw.numPendingApplications ?? null)}
          </KVRow>
          <KVRow label="Num Containers" field="queue.numContainers" raw={raw.numContainers} fmt="int">
            {countText(raw.numContainers ?? null)}
          </KVRow>
          <KVRow label="Max Applications" field="queue.maxApplications" raw={raw.maxApplications} fmt="int">
            {countText(raw.maxApplications ?? null)}
          </KVRow>
          <KVRow label="Max Applications Per User" field="queue.maxApplicationsPerUser" raw={raw.maxApplicationsPerUser} fmt="int">
            {countText(raw.maxApplicationsPerUser ?? null)}
          </KVRow>
          <KVRow label="Configured Minimum User Limit Percent" field="queue.userLimit" raw={raw.userLimit} fmt="pct">
            {pctText(raw.userLimit ?? null)}
          </KVRow>
          <KVRow label="Configured User Limit Factor" field="queue.userLimitFactor" raw={raw.userLimitFactor}>
            {raw.userLimitFactor == null ? "—" : String(raw.userLimitFactor)}
          </KVRow>
          <KVRow label="Accessible Node Labels" field="queue.nodeLabels" raw={raw.nodeLabels}>
            {raw.nodeLabels?.length ? raw.nodeLabels.join(",") : "—"}
          </KVRow>
          <KVRowGroup label="Ordering Policy">
            <span className="inline-flex items-baseline gap-1.5">
              <Datum field="queue.derived.orderingPolicyDisplayName" raw={orderingPolicyDisplayName(raw.orderingPolicyInfo)}>
                {orderingPolicyDisplayName(raw.orderingPolicyInfo) ?? "—"}
              </Datum>
              <Datum field="queue.orderingPolicyInfo" raw={raw.orderingPolicyInfo} className="text-micro text-ink-4">
                {raw.orderingPolicyInfo ?? "—"}
              </Datum>
            </span>
          </KVRowGroup>
          <KVRow label="Preemption" field="queue.preemptionDisabled" raw={raw.preemptionDisabled}>
            {raw.preemptionDisabled == null ? "—" : raw.preemptionDisabled ? "disabled" : "enabled"}
          </KVRow>
          <KVRow label="Intra-queue Preemption" field="queue.intraQueuePreemptionDisabled" raw={raw.intraQueuePreemptionDisabled}>
            {raw.intraQueuePreemptionDisabled == null ? "—" : raw.intraQueuePreemptionDisabled ? "disabled" : "enabled"}
          </KVRow>
          <KVRow label="Default Node Label Expression" field="queue.defaultNodeLabelExpression" raw={raw.defaultNodeLabelExpression}>
            {partitionText(raw.defaultNodeLabelExpression)}
          </KVRow>
          <KVRow label="Default Application Priority" field="queue.defaultPriority" raw={raw.defaultPriority} fmt="int">
            {countText(raw.defaultPriority ?? null)}
          </KVRow>
          <KVRow label="Auto-created Leaf Queue" field="queue.isAutoCreatedLeafQueue" raw={raw.isAutoCreatedLeafQueue}>
            {raw.isAutoCreatedLeafQueue == null ? "—" : String(raw.isAutoCreatedLeafQueue)}
          </KVRow>
          <KVRow label="Max Application Lifetime" field="queue.maxApplicationLifetime" raw={raw.maxApplicationLifetime} fmt="int">
            {raw.maxApplicationLifetime == null || raw.maxApplicationLifetime < 0 ? "unlimited" : String(raw.maxApplicationLifetime)}
          </KVRow>
          <KVRow
            label="Default Application Lifetime"
            field="queue.defaultApplicationLifetime"
            raw={raw.defaultApplicationLifetime}
            fmt="int"
          >
            {raw.defaultApplicationLifetime == null || raw.defaultApplicationLifetime < 0
              ? "unlimited"
              : String(raw.defaultApplicationLifetime)}
          </KVRow>
          <KVRow label="Configured Max AM Resource Limit" field="queue.configuredMaxAMResourceLimit" raw={raw.configuredMaxAMResourceLimit}>
            {raw.configuredMaxAMResourceLimit == null ? "—" : String(raw.configuredMaxAMResourceLimit)}
          </KVRow>
        </>
      )}
    </KV>
  );
}

export function FairQueueStatus({ raw, leaf }: { raw: FairQueueInfo; leaf: boolean }) {
  return (
    <KV columns={2}>
      <ResourceRow
        label="Used Resources"
        memoryField="queue.usedResources.memory"
        vcoresField="queue.usedResources.vCores"
        resource={raw.usedResources}
      />
      {leaf && (
        <ResourceRow
          label="Demand Resources"
          memoryField="queue.demandResources.memory"
          vcoresField="queue.demandResources.vCores"
          resource={raw.demandResources}
        />
      )}
      {leaf && (
        <ResourceRow
          label="AM Used Resources"
          memoryField="queue.amUsedResources.memory"
          vcoresField="queue.amUsedResources.vCores"
          resource={raw.amUsedResources}
        />
      )}
      {leaf && (
        <ResourceRow
          label="AM Max Resources"
          memoryField="queue.amMaxResources.memory"
          vcoresField="queue.amMaxResources.vCores"
          resource={raw.amMaxResources}
        />
      )}
      {leaf && (
        <>
          <KVRow label="Num Active Applications" field="queue.numActiveApps" raw={raw.numActiveApps} fmt="int">
            {countText(raw.numActiveApps ?? null)}
          </KVRow>
          <KVRow label="Num Pending Applications" field="queue.numPendingApps" raw={raw.numPendingApps} fmt="int">
            {countText(raw.numPendingApps ?? null)}
          </KVRow>
        </>
      )}
      <ResourceRow
        label="Min Resources"
        memoryField="queue.minResources.memory"
        vcoresField="queue.minResources.vCores"
        resource={raw.minResources}
      />
      <ResourceRow
        label="Max Resources"
        memoryField="queue.maxResources.memory"
        vcoresField="queue.maxResources.vCores"
        resource={raw.maxResources}
      />
      <ResourceRow
        label="Max Container Allocation"
        memoryField="queue.maxContainerAllocation.memory"
        vcoresField="queue.maxContainerAllocation.vCores"
        resource={raw.maxContainerAllocation}
      />
      <ResourceRow
        label="Reserved Resources"
        memoryField="queue.reservedResources.memory"
        vcoresField="queue.reservedResources.vCores"
        resource={raw.reservedResources}
      />
      <KVRow label="Pending Containers" field="queue.pendingContainers" raw={raw.pendingContainers} fmt="int">
        {countText(raw.pendingContainers)}
      </KVRow>
      <KVRow label="Allocated Containers" field="queue.allocatedContainers" raw={raw.allocatedContainers} fmt="int">
        {countText(raw.allocatedContainers)}
      </KVRow>
      <KVRow label="Reserved Containers" field="queue.reservedContainers" raw={raw.reservedContainers} fmt="int">
        {countText(raw.reservedContainers)}
      </KVRow>
      <KVRow label="Max Running Applications" field="queue.maxApps" raw={raw.maxApps} fmt="int">
        {raw.maxApps == null || raw.maxApps >= MAX_INT ? `${countText(raw.maxApps)} (unlimited)` : countText(raw.maxApps)}
      </KVRow>
      <ResourceRow
        label="Steady Fair Share"
        memoryField="queue.steadyFairResources.memory"
        vcoresField="queue.steadyFairResources.vCores"
        resource={raw.steadyFairResources}
      />
      <ResourceRow
        label="Instantaneous Fair Share"
        memoryField="queue.fairResources.memory"
        vcoresField="queue.fairResources.vCores"
        resource={raw.fairResources}
      />
      <KVRow label="Scheduling Policy" field="queue.schedulingPolicy" raw={raw.schedulingPolicy}>
        {raw.schedulingPolicy ?? "—"}
      </KVRow>
      <KVRow label="Cluster Resources" field="queue.clusterResources.memory" raw={raw.clusterResources?.memory} fmt="mb">
        {raw.clusterResources ? fmtMB(raw.clusterResources.memory) : "—"}
      </KVRow>
      {leaf ? (
        <KVRow label="Preemptable" field="queue.preemptable" raw={raw.preemptable}>
          {raw.preemptable == null ? "—" : String(raw.preemptable)}
        </KVRow>
      ) : (
        <KVRowGroup label="Preemptable">
          <Unavailable reason="parent queues have no preemptable field" />
        </KVRowGroup>
      )}
    </KV>
  );
}
