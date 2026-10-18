/**
 * Node detail — every field of `/api/yarn/nodes/{nodeId}` (the RM's `NodeInfo` + `RMNode` state) plus what only the
 * NodeManager knows (`/api/nm/{host:port}/info`): build versions, startup time, per-node allocation totals.
 *
 * The whole page is one `Entity` keyed by the node id, so `(node id, field id) → raw` stays unambiguous
 * (docs/contracts/parity-dom.md).
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Server } from "lucide-react";
import { nq } from "~/api/queries/nodes";
import type { Node } from "~/api/schemas";
import { fmtDuration, fmtInt, fmtMB } from "~/lib/format";
import { utilizationTone } from "~/lib/progress-tone";
import { Datum, Entity, datumAttrs } from "~/ui/datum";
import { DetailTableScroller } from "~/ui/detail-table-scroller";
import { CenteredPageState, ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { ResourceRing } from "~/ui/resource-ring";
import { ACTION_LINK_CLASS } from "~/ui/button";
import { StatusPill } from "~/ui/status";
import { HelpTip } from "~/ui/tooltip";
import { NodeContainers } from "./NodeContainers";
import { NodeLocalLogs } from "./NodeLocalLogs";
import { allocationTagSummary, healthOf, numOf, resourceMatrix, totalMemoryMB, totalVCores, utilOf } from "./domain";
import { CopyButton, Field, KvGrid, PageHead, Section, Stat, Unavailable } from "./page";

const route = getRouteApi("/nodes/$nodeId");

export function NodeDetail() {
  const { nodeId } = route.useParams();
  const query = useQuery(nq.node(nodeId));
  const node = query.data;

  if (query.error && !node) {
    return (
      <CenteredPageState>
        <ErrorState
          title="Cannot read this node"
          message={query.error instanceof Error ? query.error.message : String(query.error)}
          hint={`Burrow proxies /ws/v1/cluster/nodes/${nodeId} from the active ResourceManager. A node that has been shut down long enough is dropped from the inactive-node map and will 404.`}
          onRetry={() => void query.refetch()}
        />
      </CenteredPageState>
    );
  }
  if (!node) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading node">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  return <NodeBody node={node} refreshError={query.error} onRetry={() => void query.refetch()} />;
}

function NodeBody({ node, refreshError, onRetry }: { node: Node; refreshError: unknown; onRetry: () => void }) {
  const util = utilOf(node);
  const address = node.nodeHTTPAddress;
  const nm = useQuery({ ...nq.nmInfo(address), enabled: address !== "" });
  const containers = useQuery({ ...nq.nmContainers(address), enabled: address !== "" });
  const total = { mem: totalMemoryMB(node), vcores: totalVCores(node) };
  const vcoresTotal = total.vcores || numOf(node.totalResource?.vCores);
  const runningContainers = containers.data?.filter((container) => container.state === "RUNNING");
  const containerMemoryMB = runningContainers?.reduce((sum, container) => sum + container.totalMemoryNeededMB, 0) ?? null;
  const containerVCores = runningContainers?.reduce((sum, container) => sum + container.totalVCoresNeeded, 0) ?? null;
  const listedContainerCount = runningContainers?.length ?? null;
  const containerSnapshotDiffers =
    listedContainerCount != null &&
    (listedContainerCount !== numOf(node.numContainers) ||
      containerMemoryMB !== numOf(node.usedMemoryMB) ||
      containerVCores !== numOf(node.usedVirtualCores));
  const tags = node.allocationTags?.allocationTagInfo ?? [];
  const attributes = node.nodeAttributesInfo?.nodeAttributeInfo ?? [];
  const inactive = node.state === "DECOMMISSIONED" || node.state === "LOST" || node.state === "SHUTDOWN" || node.state === "REBOOTED";

  return (
    <Entity
      id={node.id}
      as="div"
      tabIndex={0}
      aria-label="Node details"
      className="burrow-scroll burrow-page-scroll flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto pb-6 [&>*]:shrink-0"
    >
      {refreshError != null && (
        <StaleErrorBanner title="Node refresh failed; showing the last loaded details" error={refreshError} onRetry={onRetry} />
      )}
      <PageHead
        title={
          <span className="flex items-center gap-2">
            <Server className="size-5 text-ink-3" aria-hidden="true" />
            <span className="font-mono">{node.nodeHostName}</span>
          </span>
        }
        description={
          <div className="flex flex-col gap-1.5">
            <span>Node state, health, capacity, and assigned containers reported by its NodeManager.</span>
            <span className="flex flex-wrap items-center gap-2">
              <StatusPill domain="node.state" state={node.state} field="node.state" />
              {healthOf(node) === "unhealthy" && <StatusPill domain="node.health" state="unhealthy" field="node.state" raw={node.state} />}
              <span className="font-mono text-small">{node.rack || "/default-rack"}</span>
              <DatumMuted field="node.nodeHTTPAddress" raw={address} />
            </span>
          </div>
        }
        actions={
          <>
            <Link to="/nodes" className={ACTION_LINK_CLASS}>
              <ArrowLeft className="size-3.5" aria-hidden="true" /> All nodes
            </Link>
            <CopyButton value={node.id} label="Copy node id" />
            {address !== "" && (
              <>
                <a href={`http://${address}/`} target="_blank" rel="noreferrer noopener" className={ACTION_LINK_CLASS}>
                  NodeManager UI <ExternalLink className="size-3" aria-hidden="true" />
                </a>
                {/* plain anchors: the tools slice owns those routes and this feature must not depend on their route ids */}
                <a href={`/tools/conf?host=${encodeURIComponent(address)}`} className={ACTION_LINK_CLASS}>
                  NM configuration
                </a>
                <a href={`/tools/jmx?host=${encodeURIComponent(address)}`} className={ACTION_LINK_CLASS}>
                  NM metrics
                </a>
              </>
            )}
          </>
        }
      />

      {inactive && (
        <Unavailable
          title={`This node is ${node.state.toLowerCase()}`}
          reason="The ResourceManager still remembers the node, but it is no longer in the active set: its HTTP address is empty, so container lists and daemon pages cannot be read."
          hint="Decommissioned/lost/rebooted/shutdown nodes are kept only for a while (yarn.resourcemanager.nodes.exclude-path and the inactive-node expiry)."
        />
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="node-container-summary">
        <Stat
          label="Listed container memory"
          value={
            <span className="flex items-baseline gap-1">
              <Datum field="node.derived.nmContainerMemoryMB" raw={containerMemoryMB} fmt="mb">
                {containerMemoryMB == null ? "—" : fmtMB(containerMemoryMB)}
              </Datum>
              <span className="text-small font-normal text-ink-3">of {fmtMB(total.mem)} capacity</span>
            </span>
          }
          sub="sum of RUNNING containers reported by the NodeManager"
        />
        <Stat
          label="Listed container vCores"
          value={
            <span className="flex items-baseline gap-1">
              <Datum field="node.derived.nmContainerVCores" raw={containerVCores} fmt="int">
                {containerVCores == null ? "—" : fmtInt(containerVCores)}
              </Datum>
              <span className="text-small font-normal text-ink-3">of {fmtInt(vcoresTotal)} capacity</span>
            </span>
          }
          sub="sum of RUNNING containers reported by the NodeManager"
        />
        <Stat
          label="Running containers"
          value={
            <Datum field="node.derived.nmRunningContainers" raw={listedContainerCount} fmt="int">
              {listedContainerCount == null ? "—" : fmtInt(listedContainerCount)}
            </Datum>
          }
          sub="reported by the NodeManager"
        />
        <div className="grid min-w-0 content-center gap-2 rounded-lg border border-seam bg-fabric px-3 py-2">
          <span className="text-caption uppercase tracking-wide text-ink-3">Physical utilisation · NodeManager</span>
          <div className="flex items-center justify-around gap-2">
            <div className="grid justify-items-center gap-1">
              <ResourceRing
                used={util.mem}
                total={100}
                size={48}
                tone={utilizationTone(util.mem)}
                label="NodeManager physical memory utilisation"
                centre={<span {...datumAttrs("node.memUtilization", node.memUtilization, "pct")}>{fmtInt(Math.trunc(util.mem))}%</span>}
              />
              <span className="text-micro text-ink-3">Memory</span>
            </div>
            <div className="grid justify-items-center gap-1">
              <ResourceRing
                used={util.cpu}
                total={100}
                size={48}
                tone={utilizationTone(util.cpu)}
                label="NodeManager physical vCores utilisation"
                centre={<span {...datumAttrs("node.cpuUtilization", node.cpuUtilization, "pct")}>{fmtInt(Math.trunc(util.cpu))}%</span>}
              />
              <span className="text-micro text-ink-3">vCores</span>
            </div>
          </div>
        </div>
      </div>

      {containerSnapshotDiffers && (
        <p role="status" className="m-0 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-caption text-ink-2">
          ResourceManager snapshot: {fmtInt(numOf(node.numContainers))} containers, {fmtMB(numOf(node.usedMemoryMB))} and{" "}
          {fmtInt(numOf(node.usedVirtualCores))} vCores used. NodeManager list: {fmtInt(listedContainerCount)} running containers,{" "}
          {containerMemoryMB == null ? "—" : fmtMB(containerMemoryMB)} and {containerVCores == null ? "—" : fmtInt(containerVCores)} vCores.
          These endpoints update independently; refresh to compare newer values.
        </p>
      )}

      <Section title="Node (ResourceManager)">
        <KvGrid columns={4}>
          <Field label="Node id" field="node.id" raw={node.id} mono />
          <Field label="Host name" field="node.nodeHostName" raw={node.nodeHostName} mono />
          <Field label="Rack" field="node.rack" raw={node.rack} mono />
          <Field label="State" field="node.state" raw={node.state} />
          <Field label="NodeManager version" field="node.version" raw={node.version} hint="Hadoop version running on this NodeManager." />
          <Field
            label="Node HTTP address"
            field="node.nodeHTTPAddress"
            raw={node.nodeHTTPAddress}
            mono
            hint="Inactive nodes may have no web address."
          />
          <Field label="Last health-update" field="node.lastHealthUpdate" raw={node.lastHealthUpdate} fmt="epoch" />
          <Field
            label="Health-report"
            field="node.healthReport"
            raw={node.healthReport}
            hint="Diagnostic text from NodeManager health checks. The node state determines whether the node is unhealthy."
          />
          <Field
            label="Health"
            field="node.state"
            raw={node.state}
            hint="Derived from the current node state. Health is unknown for inactive or transitioning nodes."
          >
            {healthOf(node)}
          </Field>
          <Field label="Containers" field="node.numContainers" raw={node.numContainers} fmt="int" />
          <Field label="Memory used" field="node.usedMemoryMB" raw={node.usedMemoryMB} fmt="mb" />
          <Field label="Memory available" field="node.availMemoryMB" raw={node.availMemoryMB} fmt="mb" />
          <Field label="vCores used" field="node.usedVirtualCores" raw={node.usedVirtualCores} fmt="int" />
          <Field label="vCores available" field="node.availableVirtualCores" raw={node.availableVirtualCores} fmt="int" />
          <Field
            label="Physical memory used"
            field="node.memUtilization"
            raw={node.memUtilization}
            fmt="pct"
            hint="Physical host memory usage, including processes outside YARN."
          />
          <Field
            label="Physical vCores used"
            field="node.cpuUtilization"
            raw={node.cpuUtilization}
            fmt="pct"
            hint="Physical CPU usage reported by the NodeManager."
          />
          {node.subClusterId !== undefined && <Field label="Sub-cluster id" field="node.subClusterId" raw={node.subClusterId} />}
          <Field label="Node labels" field="node.nodeLabels" raw={node.nodeLabels?.length ? node.nodeLabels : undefined}>
            {(node.nodeLabels ?? []).length === 0 ? <span className="text-ink-4">—</span> : (node.nodeLabels ?? []).join(", ")}
          </Field>
          <Field
            label="Allocation tags"
            field="node.allocationTags"
            raw={tags.length ? tags : undefined}
            hint="tags with their allocation counts"
          >
            {tags.length === 0 ? <span className="text-ink-4">—</span> : allocationTagSummary(node)}
          </Field>
          <Field
            label="Running containers (opportunistic)"
            field="node.numRunningOpportContainers"
            raw={node.numRunningOpportContainers}
            fmt="int"
          />
          <Field label="Queued containers" field="node.numQueuedContainers" raw={node.numQueuedContainers} fmt="int" />
          <Field label="Opportunistic memory (GB)" field="node.usedMemoryOpportGB" raw={node.usedMemoryOpportGB} fmt="int" />
          <Field label="Opportunistic vCores" field="node.usedVirtualCoresOpport" raw={node.usedVirtualCoresOpport} fmt="int" />
        </KvGrid>
      </Section>

      <Section title="Resources">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <KvGrid columns={2}>
            <Field label="Total memory" field="node.totalResource.memory" raw={node.totalResource?.memory} fmt="mb" />
            <Field label="Total vCores" field="node.totalResource.vCores" raw={node.totalResource?.vCores} fmt="int" />
            <Field label="Used (resource)" field="node.usedResource.memory" raw={node.usedResource?.memory} fmt="mb" />
            <Field label="Used vCores (resource)" field="node.usedResource.vCores" raw={node.usedResource?.vCores} fmt="int" />
            <Field label="Available (resource)" field="node.availableResource.memory" raw={node.availableResource?.memory} fmt="mb" />
            <Field
              label="Available vCores (resource)"
              field="node.availableResource.vCores"
              raw={node.availableResource?.vCores}
              fmt="int"
            />
          </KvGrid>
          <KvGrid columns={2}>
            <Field
              label="Node physical memory"
              field="node.resourceUtilization.nodePhysicalMemoryMB"
              raw={node.resourceUtilization?.nodePhysicalMemoryMB}
              fmt="mb"
            />
            <Field
              label="Node virtual memory"
              field="node.resourceUtilization.nodeVirtualMemoryMB"
              raw={node.resourceUtilization?.nodeVirtualMemoryMB}
              fmt="mb"
            />
            <Field
              label="Node CPU usage"
              field="node.resourceUtilization.nodeCPUUsage"
              raw={node.resourceUtilization?.nodeCPUUsage}
              hint="NM-reported physical CPU usage (a percentage)."
            />
            <Field
              label="Containers physical memory"
              field="node.resourceUtilization.aggregatedContainersPhysicalMemoryMB"
              raw={node.resourceUtilization?.aggregatedContainersPhysicalMemoryMB}
              fmt="mb"
            />
            <Field
              label="Containers virtual memory"
              field="node.resourceUtilization.aggregatedContainersVirtualMemoryMB"
              raw={node.resourceUtilization?.aggregatedContainersVirtualMemoryMB}
              fmt="mb"
            />
            <Field
              label="Containers CPU usage"
              field="node.resourceUtilization.containersCPUUsage"
              raw={node.resourceUtilization?.containersCPUUsage}
            />
          </KvGrid>
        </div>
        <ResourceMatrix node={node} />
      </Section>

      <Section
        title={
          <h2 className="flex items-center gap-2 text-lead font-medium text-ink-2">
            NodeManager
            {nm.data && <span className="font-mono text-small text-ink-4">{nm.data.nodeManagerVersion}</span>}
          </h2>
        }
      >
        {address === "" ? (
          <Unavailable title="No NodeManager address" reason="The ResourceManager reports an empty HTTP address for this node." />
        ) : nm.error && !nm.data ? (
          <ErrorState
            title="Cannot read the NodeManager"
            message={nm.error instanceof Error ? nm.error.message : String(nm.error)}
            hint={`Burrow proxies /ws/v1/node/info from ${address}; the port must be reachable from the Burrow host.`}
            onRetry={() => void nm.refetch()}
          />
        ) : !nm.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {nm.error && (
              <StaleErrorBanner
                title="NodeManager refresh failed; showing the last loaded details"
                error={nm.error}
                onRetry={() => void nm.refetch()}
              />
            )}
            <KvGrid columns={4}>
              <Field label="NM version" field="nm.info.nodeManagerVersion" raw={nm.data.nodeManagerVersion} />
              <Field label="NM build" field="nm.info.nodeManagerBuildVersion" raw={nm.data.nodeManagerBuildVersion} mono />
              <Field label="NM built on" field="nm.info.nodeManagerVersionBuiltOn" raw={nm.data.nodeManagerVersionBuiltOn} />
              <Field label="Hadoop version" field="nm.info.hadoopVersion" raw={nm.data.hadoopVersion} />
              <Field label="Hadoop build" field="nm.info.hadoopBuildVersion" raw={nm.data.hadoopBuildVersion} mono />
              <Field label="Hadoop built on" field="nm.info.hadoopVersionBuiltOn" raw={nm.data.hadoopVersionBuiltOn} />
              <Field label="Started" field="nm.info.nmStartupTime" raw={nm.data.nmStartupTime} fmt="epoch" />
              <Field label="Uptime" field="nm.info.nmStartupTime" raw={nm.data.nmStartupTime} hint="Derived from nmStartupTime.">
                {nm.data.nmStartupTime ? fmtDuration(Date.now() - nm.data.nmStartupTime) : "—"}
              </Field>
              <Field label="Last node update" field="nm.info.lastNodeUpdateTime" raw={nm.data.lastNodeUpdateTime} fmt="epoch" />
              <Field label="Healthy" field="nm.info.nodeHealthy" raw={nm.data.nodeHealthy} hint="NM's own health verdict." />
              <Field label="Health report" field="nm.info.healthReport" raw={nm.data.healthReport} />
              <Field
                label="Physical memory allocated"
                field="nm.info.totalPmemAllocatedContainersMB"
                raw={nm.data.totalPmemAllocatedContainersMB}
                fmt="mb"
              />
              <Field
                label="Virtual memory allocated"
                field="nm.info.totalVmemAllocatedContainersMB"
                raw={nm.data.totalVmemAllocatedContainersMB}
                fmt="mb"
              />
              <Field
                label="vCores allocated"
                field="nm.info.totalVCoresAllocatedContainers"
                raw={nm.data.totalVCoresAllocatedContainers}
                fmt="int"
              />
              <Field label="vmem check enabled" field="nm.info.vmemCheckEnabled" raw={nm.data.vmemCheckEnabled} />
              <Field label="pmem check enabled" field="nm.info.pmemCheckEnabled" raw={nm.data.pmemCheckEnabled} />
              <Field label="Resource types" field="nm.info.resourceTypes" raw={nm.data.resourceTypes} mono />
            </KvGrid>
          </>
        )}
      </Section>

      {attributes.length > 0 && (
        <Section title="Node attributes">
          <KvGrid columns={3}>
            {attributes.map((a) => (
              <Field
                key={`${a.prefix ?? ""}${a.name}`}
                label={`${a.prefix ?? ""}${a.name}`}
                field={`node.nodeAttributesInfo.${a.name}`}
                raw={a.value}
                mono
                hint={a.type}
              >
                {a.value ?? "—"}
              </Field>
            ))}
          </KvGrid>
        </Section>
      )}

      <NodeContainers
        node={node}
        containers={containers.data}
        loading={containers.isPending}
        error={containers.error}
        onRetry={() => void containers.refetch()}
      />
      <NodeLocalLogs node={node} />
    </Entity>
  );
}

/** Every resource type with total/used/available — the only place a custom resource (GPU, FPGA) becomes visible. */
function ResourceMatrix({ node }: { node: Node }) {
  const rows = resourceMatrix(node);
  if (rows.length === 0) return null;
  const alloc = (v: number | undefined) =>
    v === undefined ? (
      "—"
    ) : v > Number.MAX_SAFE_INTEGER ? (
      <span className="inline-flex items-center gap-1">
        unbounded <HelpTip label="Allocation ceiling">YARN reports no finite allocation ceiling for this resource.</HelpTip>
      </span>
    ) : (
      fmtInt(v)
    );
  return (
    <DetailTableScroller ariaLabel="Node resource totals" className="rounded-lg border border-seam bg-fabric">
      <table className="w-full min-w-[58rem] border-collapse text-small">
        <thead className="bg-fabric-2 text-micro uppercase tracking-wide text-ink-4">
          <tr>
            <th className="px-3 py-1.5 text-start font-medium">Resource</th>
            <th className="px-3 py-1.5 text-start font-medium">
              <span className="inline-flex items-center gap-1">
                Units{" "}
                <HelpTip label="Resource units">
                  Memory uses MiB; virtual CPU cores and other countable resources use their configured resource units.
                </HelpTip>
              </span>
            </th>
            <th className="px-3 py-1.5 text-start font-medium">Type</th>
            <th className="px-3 py-1.5 text-end font-medium">Total</th>
            <th className="px-3 py-1.5 text-end font-medium">Used</th>
            <th className="px-3 py-1.5 text-end font-medium">Available</th>
            <th className="px-3 py-1.5 text-end font-medium">
              <span className="inline-flex items-center gap-1">
                Min alloc <HelpTip label="Minimum allocation">Smallest container allocation allowed for this resource type.</HelpTip>
              </span>
            </th>
            <th className="px-3 py-1.5 text-end font-medium">
              <span className="inline-flex items-center gap-1">
                Max alloc{" "}
                <HelpTip label="Maximum allocation">
                  Largest container allocation allowed for this resource type. Unbounded means no finite ceiling was reported.
                </HelpTip>
              </span>
            </th>
            <th className="px-3 py-1.5 text-start font-medium">Tags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-seam-soft">
              <td className="px-3 py-1.5 font-mono text-ink">{r.name}</td>
              <td className="px-3 py-1.5 text-ink-3">{r.units || "—"}</td>
              <td className="px-3 py-1.5 text-ink-3">{r.resourceType || "—"}</td>
              <td className="px-3 py-1.5 text-end">
                <Datum field={`node.totalResource.${r.name}`} raw={r.total} fmt="int" className="tnum" />
              </td>
              <td className="px-3 py-1.5 text-end">
                <Datum field={`node.usedResource.${r.name}`} raw={r.used} fmt="int" className="tnum" />
              </td>
              <td className="px-3 py-1.5 text-end">
                <Datum field={`node.availableResource.${r.name}`} raw={r.available} fmt="int" className="tnum" />
              </td>
              <td className="px-3 py-1.5 text-end text-ink-3 tnum">{alloc(r.minimumAllocation)}</td>
              <td className="px-3 py-1.5 text-end text-ink-3 tnum">{alloc(r.maximumAllocation)}</td>
              <td className="px-3 py-1.5 text-ink-3">{r.tags.length ? r.tags.join(", ") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </DetailTableScroller>
  );
}

function DatumMuted({ field, raw }: { field: string; raw: unknown }) {
  return (
    <span {...datumAttrs(field, raw)} className="font-mono text-micro text-ink-4">
      {raw ? String(raw) : "—"}
    </span>
  );
}
