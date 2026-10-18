/**
 * Attempt detail — the legacy `/cluster/appattempt/{id}` page.
 *
 * The attempt's timing, application master, links and scheduling details use the same compact table surfaces as
 * Scheduler Health. Fields retain their parity datums; discarded container records and unreported locality counts
 * remain unavailable rather than becoming zeroes.
 */
import type { ColumnVisibilityState } from "@tanstack/react-table";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { App, AppAttempt, AppAttemptDetail, Container, ResourceRequestInfo } from "~/api/schemas";
import { fmtDuration, fmtMB, type Fmt } from "~/lib/format";
import { useParity } from "~/state/parity";
import { Datum, Entity } from "~/ui/datum";
import { DetailTableScroller } from "~/ui/detail-table-scroller";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { StatusPill } from "~/ui/status";
import { LogLink } from "./LogLink";
import { rewriteUpstreamUrl, useUpstreamBases } from "~/lib/upstream-url";
import { CopyButton, Section } from "./Field";
import {
  LOCALITY_MATRIX,
  attemptElapsedMs,
  attemptHostPortText,
  attemptTrackingText,
  blacklistedNodesText,
  nodeHostPort,
  totalOutstandingResources,
  totalOutstandingText,
  trackingKind,
} from "../model";
import { useLocalTableState } from "../table-state";

const CONTAINER_VISIBILITY: ColumnVisibilityState = {
  containerId: true,
  nodeHttpAddress: true,
  containerState: true,
  resources: true,
  containerExitStatus: true,
  logs: true,
};
const REQUEST_VISIBILITY: ColumnVisibilityState = { allocationTags: false, placementConstraint: false, allocationRequestId: false };

function containerColumns(appId: string): ColDef<Container>[] {
  return [
    {
      id: "containerId",
      accessorFn: (c) => c.containerId,
      size: 280,
      meta: { label: "Container ID", pinned: true },
      cell: ({ row }) => (
        <Link
          to="/apps/$appId/containers/$containerId"
          params={{ appId, containerId: row.original.containerId }}
          className="truncate font-mono text-live underline-offset-2 hover:underline"
        >
          <Datum field="container.containerId" raw={row.original.containerId} />
        </Link>
      ),
    },
    {
      id: "nodeHttpAddress",
      accessorFn: (c) => c.nodeHttpAddress,
      size: 180,
      meta: { label: "Node" },
      cell: ({ row }) => <Datum field="container.nodeHttpAddress" raw={row.original.nodeHttpAddress} className="font-mono text-small" />,
    },
    {
      id: "containerState",
      accessorFn: (c) => c.containerState,
      size: 110,
      meta: { label: "State" },
      cell: ({ row }) => <StatusPill domain="container.state" state={row.original.containerState} field="container.containerState" />,
    },
    {
      id: "resources",
      accessorFn: (c) => c.allocatedMB,
      size: 150,
      meta: { label: "Resources" },
      cell: ({ row }) => (
        <span className="tnum text-ink-2">
          <Datum field="container.allocatedMB" raw={row.original.allocatedMB} fmt="mb" /> ·{" "}
          <Datum field="container.allocatedVCores" raw={row.original.allocatedVCores} fmt="int" /> vCores
        </span>
      ),
    },
    {
      id: "containerExitStatus",
      accessorFn: (c) => c.containerExitStatus,
      size: 100,
      meta: { label: "Exit status", align: "end" },
      cell: ({ row }) => (
        <Datum field="container.containerExitStatus" raw={row.original.containerExitStatus} fmt="int" className="tnum">
          {row.original.containerExitStatus === -1000 ? "—" : undefined}
        </Datum>
      ),
    },
    {
      id: "logs",
      accessorFn: (c) => c.logUrl,
      size: 90,
      meta: { label: "Logs" },
      cell: ({ row }) => (
        <>
          <LogLink appId={appId} containerId={row.original.containerId} node={nodeHostPort(row.original)} compact />
          <Datum field="container.logUrl" raw={row.original.logUrl} as="span" className="sr-only" />
        </>
      ),
    },
  ];
}

function requestColumns(): ColDef<ResourceRequestInfo>[] {
  const text = (id: string, label: string, field: string, size: number, align?: "start" | "end"): ColDef<ResourceRequestInfo> => ({
    id,
    accessorFn: (r) => r[id as keyof ResourceRequestInfo] as unknown,
    size,
    meta: { label, align },
    cell: ({ row }) => {
      const raw = row.original[id as keyof ResourceRequestInfo] as unknown;
      return <Datum field={field} raw={raw} className="truncate text-small" />;
    },
  });
  return [
    text("priority", "Priority", "app.resourceRequests.priority", 80, "end"),
    text("allocationRequestId", "Request ID", "app.resourceRequests.allocationRequestId", 120, "end"),
    text("resourceName", "Location", "app.resourceRequests.resourceName", 150),
    text("numContainers", "Containers", "app.resourceRequests.numContainers", 100, "end"),
    text("relaxLocality", "Relax locality", "app.resourceRequests.relaxLocality", 110),
    text("nodeLabelExpression", "Node label", "app.resourceRequests.nodeLabelExpression", 140),
    text("allocationTags", "Allocation tags", "app.resourceRequests.allocationTags", 150),
    text("placementConstraint", "Placement constraint", "app.resourceRequests.placementConstraint", 170),
    {
      id: "executionType",
      accessorFn: (r) => r.executionTypeRequest?.executionType,
      size: 130,
      meta: { label: "Execution type" },
      cell: ({ row }) => (
        <Datum field="app.resourceRequests.executionTypeRequest.executionType" raw={row.original.executionTypeRequest?.executionType} />
      ),
    },
    {
      id: "capability",
      accessorFn: (r) => r.capability?.memory,
      size: 140,
      meta: { label: "Resources each" },
      cell: ({ row }) => (
        <span className="tnum">
          {row.original.capability ? `${fmtMB(row.original.capability.memory)} · ${row.original.capability.vCores} vCores` : "—"}
        </span>
      ),
    },
  ];
}

/** Small field tables use Health's neutral header, row separators and spacing. */
function DetailsTable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-seam bg-fabric">
      <h3 className="border-b border-seam bg-fabric-2 px-3 py-1.5 text-small font-medium text-ink-2">{title}</h3>
      <table className="w-full table-fixed text-body">
        <caption className="sr-only">{title}</caption>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function DetailRow({
  label,
  field,
  raw,
  fmt,
  children,
  mono = false,
}: {
  label: string;
  field?: string;
  raw?: unknown;
  fmt?: Fmt;
  children?: ReactNode;
  mono?: boolean;
}) {
  return (
    <tr className="border-b border-seam-soft last:border-b-0">
      <th scope="row" className="w-[38%] px-3 py-1.5 text-left align-top text-small font-medium text-ink-3">
        {label}
      </th>
      <td className={`px-3 py-1.5 align-top break-words ${mono ? "font-mono text-caption" : "text-body"}`}>
        {field ? (
          <Datum field={field} raw={raw} fmt={fmt}>
            {children}
          </Datum>
        ) : (
          children
        )}
      </td>
    </tr>
  );
}

export function AttemptDetail({
  app,
  attempt,
  containers,
  containersUnavailable,
  containersError = false,
  detail,
  now,
}: {
  app: App;
  attempt: AppAttempt;
  containers: readonly Container[];
  /** true when the RM answered `{}`: it no longer holds containers for this attempt (finished apps) */
  containersUnavailable: boolean;
  /** true when the current container request failed and returned no usable rows */
  containersError?: boolean;
  /** the single-attempt resource; undefined while loading or when the RM does not serve it */
  detail?: AppAttemptDetail;
  now: number;
}) {
  const bases = useUpstreamBases();
  const parity = useParity();
  const allRequests = app.resourceRequests ?? [];
  const requests = allRequests.filter((r) => r.numContainers > 0);
  const outstanding = totalOutstandingResources(allRequests);
  const elapsed = attemptElapsedMs(attempt, now);
  const appBlacklistText = blacklistedNodesText(attempt.blacklistedNodes);
  const systemBlacklistText = blacklistedNodesText(attempt.nodesBlacklistedBySystem);
  const hostPortText = detail ? attemptHostPortText(detail.host, detail.rpcPort) : null;
  const trackingText = detail ? attemptTrackingText(detail.trackingUrl, detail.appAttemptState) : null;
  const diagnostics = detail?.diagnosticsInfo ?? null;
  const amContainer = containers.find((c) => c.containerId === attempt.containerId);
  const containerTable = useLocalTableState(CONTAINER_VISIBILITY);
  const requestTable = useLocalTableState(REQUEST_VISIBILITY);

  return (
    <Entity id={attempt.appAttemptId} className="flex min-w-0 flex-col gap-4">
      <Section
        variant="plain"
        title={
          <span className="flex flex-wrap items-center gap-2">
            Attempt {attempt.id}
            <StatusPill domain="app.state" state={attempt.appAttemptState} field="attempt.appAttemptState" raw={attempt.appAttemptState} />
          </span>
        }
        actions={<CopyButton text={attempt.appAttemptId} label="Copy attempt ID" />}
      >
        <Datum field="attempt.appAttemptId" raw={attempt.appAttemptId} className="break-all font-mono text-small text-ink-3" />
        <DetailTableScroller ariaLabel="Attempt summary" className="rounded-lg border border-seam bg-fabric">
          <table className="w-full text-body sm:min-w-[40rem]">
            <thead>
              <tr className="border-b border-seam bg-fabric-2 text-small text-ink-3">
                {["Started", "Finished", "Duration", "Retained containers"].map((label) => (
                  <th key={label} scope="col" className="px-3 py-1.5 text-left font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-3 py-1.5 tnum">
                  <Datum field="attempt.startTime" raw={attempt.startTime} fmt="epoch" />
                </td>
                <td className="px-3 py-1.5 tnum">
                  <Datum field="attempt.finishedTime" raw={attempt.finishedTime} fmt="epoch">
                    {attempt.finishedTime === 0 ? "In progress" : undefined}
                  </Datum>
                </td>
                <td className="px-3 py-1.5 tnum">
                  <Datum field="attempt.derived.elapsedText" raw={elapsed} fmt="ms">
                    {fmtDuration(elapsed)}
                  </Datum>
                </td>
                <td className="px-3 py-1.5 tnum" data-burrow="retained-container-count">
                  {containersUnavailable ? <span className="text-ink-3">Unavailable</span> : containers.length}
                </td>
              </tr>
            </tbody>
          </table>
        </DetailTableScroller>
      </Section>

      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
        <DetailsTable title="Application master">
          <DetailRow label="Container" field="attempt.containerId" raw={attempt.containerId}>
            {attempt.containerId ? (
              <Link
                to="/apps/$appId/containers/$containerId"
                params={{ appId: app.id, containerId: attempt.containerId }}
                className="break-all font-mono text-caption text-live underline-offset-2 hover:underline"
              >
                {attempt.containerId}
              </Link>
            ) : (
              "Unassigned"
            )}
          </DetailRow>
          <DetailRow label="Host / RPC port" field="attempt.derived.hostPortText" raw={hostPortText} mono>
            {detail ? hostPortText : "Not available"}
            <Datum field="attempt.host" raw={detail?.host} as="span" className="sr-only" bare />
            <Datum field="attempt.rpcPort" raw={detail?.rpcPort} fmt="int" as="span" className="sr-only" bare />
          </DetailRow>
          <DetailRow label="Node ID" field="attempt.nodeId" raw={attempt.nodeId} mono>
            {attempt.nodeId || "Unassigned"}
          </DetailRow>
          <DetailRow label="Node HTTP address" field="attempt.nodeHttpAddress" raw={attempt.nodeHttpAddress} mono />
          <DetailRow label="Exposed ports" field="attempt.exportPorts" raw={attempt.exportPorts} mono>
            {attempt.exportPorts && attempt.exportPorts !== "null" ? attempt.exportPorts : "None"}
          </DetailRow>
          <DetailRow label="Allocated resources">
            {amContainer ? (
              <Entity id={amContainer.containerId} as="span" className="tnum">
                <Datum field="container.assignedNodeId" raw={amContainer.assignedNodeId} as="span" className="sr-only" />
                <Datum field="container.allocatedMB" raw={amContainer.allocatedMB} fmt="mb" /> ·{" "}
                <Datum field="container.allocatedVCores" raw={amContainer.allocatedVCores} fmt="int" /> vCores
              </Entity>
            ) : (
              <span className="text-small text-ink-3">Not retained by the ResourceManager</span>
            )}
          </DetailRow>
        </DetailsTable>
        <DetailsTable title="Tracking and diagnostics">
          <DetailRow label="Attempt tracking" field="attempt.derived.trackingUiText" raw={trackingText}>
            <Datum field="attempt.trackingUrl" raw={detail?.trackingUrl}>
              {!detail ? (
                "Not available"
              ) : trackingText === "Unassigned" || !detail.trackingUrl ? (
                "Unassigned"
              ) : (
                <a
                  href={rewriteUpstreamUrl(detail.trackingUrl, bases).href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-live underline-offset-2 hover:underline"
                >
                  {trackingText}
                </a>
              )}
            </Datum>
          </DetailRow>
          <DetailRow label="Application tracking">
            {trackingKind(app) === "unassigned" || !app.trackingUrl ? (
              "Unassigned"
            ) : (
              <a
                href={rewriteUpstreamUrl(app.trackingUrl, bases).href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-live underline-offset-2 hover:underline"
              >
                {trackingKind(app) === "history" ? "History" : "Application UI"}
              </a>
            )}
          </DetailRow>
          <DetailRow label="Aggregated logs" field="attempt.logsLink" raw={attempt.logsLink || null}>
            {attempt.logsLink ? (
              <a
                href={rewriteUpstreamUrl(attempt.logsLink, bases).href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-live underline-offset-2 hover:underline"
              >
                Open aggregated logs
              </a>
            ) : (
              <span className="text-small text-ink-3">Not available</span>
            )}
          </DetailRow>
          <DetailRow label="Diagnostics">
            <Datum
              field="attempt.diagnosticsInfo"
              raw={diagnostics}
              as={diagnostics ? "pre" : "span"}
              data-burrow="attempt-diagnostics"
              className={
                diagnostics
                  ? "burrow-scroll max-h-48 overflow-auto font-mono text-caption leading-relaxed whitespace-pre-wrap text-ink-2"
                  : "text-ink-3"
              }
            >
              {!detail ? "Not available" : diagnostics || "None reported"}
            </Datum>
          </DetailRow>
          <DetailRow label="Application diagnostics">
            <Link to="/apps/$appId" params={{ appId: app.id }} className="text-live underline-offset-2 hover:underline">
              View application details
            </Link>
          </DetailRow>
        </DetailsTable>
      </div>

      <Section
        variant="plain"
        title="Containers"
        actions={
          containers.length > 0 &&
          !containersUnavailable && <span className="text-small text-ink-3 tnum">{containers.length} retained</span>
        }
      >
        {containers.length === 0 ? (
          <div
            className="rounded-lg border border-seam bg-fabric px-3 py-2.5"
            data-burrow={containersError ? "containers-error" : "containers-unavailable"}
          >
            <p className="text-body text-ink-2">
              {containersError
                ? "Container records could not be loaded."
                : containersUnavailable
                  ? "Container records are no longer retained for this finished attempt."
                  : "No container records are currently available."}
            </p>
            <p className="mt-0.5 text-small text-ink-3">
              {containersError
                ? "The ResourceManager did not return a usable container list; see the error above and retry."
                : containersUnavailable
                  ? "The original allocation count is unavailable."
                  : "The ResourceManager has not returned any containers for this attempt."}
              {containersUnavailable && attempt.logsLink && " Aggregated logs are available above."}
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col" style={{ height: Math.min(420, 100 + containers.length * 34) }}>
            <DataTable<Container>
              data={containers}
              columns={containerColumns(app.id)}
              getRowId={(c) => c.containerId}
              label="Attempt containers"
              storageKey="attempt-containers"
              sorting={containerTable.sorting}
              onSortingChange={containerTable.setSorting}
              columnVisibility={containerTable.visibility}
              onColumnVisibilityChange={containerTable.setVisibility}
              defaultVisibility={CONTAINER_VISIBILITY}
              exportName={`${attempt.appAttemptId}-containers`}
              rowVersion={(c) => `${c.containerState}:${c.containerExitStatus}`}
            />
          </div>
        )}
      </Section>

      <Section
        variant="plain"
        title="Outstanding resource requests"
        actions={
          outstanding && (
            <span className="text-small text-ink-3 tnum">
              {fmtMB(outstanding.memoryMB)} · {outstanding.vcores} vCores
            </span>
          )
        }
      >
        {outstanding && (
          <Datum field="attempt.derived.totalOutstandingResourceRequestsText" raw={totalOutstandingText(outstanding)} className="sr-only">
            {totalOutstandingText(outstanding)}
          </Datum>
        )}
        {requests.length === 0 ? (
          <div className="rounded-lg border border-seam bg-fabric px-3 py-2.5 text-body text-ink-3" data-burrow="no-outstanding-requests">
            No outstanding resource requests.
          </div>
        ) : (
          <div className="flex min-h-0 flex-col" style={{ height: Math.min(352, 100 + requests.length * 34) }}>
            <DataTable<ResourceRequestInfo>
              data={requests}
              columns={requestColumns()}
              getRowId={(r) =>
                `${r.allocationRequestId}-${r.priority}-${r.resourceName ?? "*"}-${r.executionTypeRequest?.executionType ?? ""}`
              }
              label="Outstanding resource requests"
              storageKey="attempt-resource-requests"
              sorting={requestTable.sorting}
              onSortingChange={requestTable.setSorting}
              columnVisibility={requestTable.visibility}
              onColumnVisibilityChange={requestTable.setVisibility}
              defaultVisibility={REQUEST_VISIBILITY}
              exportName={`${attempt.appAttemptId}-resource-requests`}
            />
          </div>
        )}
      </Section>

      <Section variant="plain" title="Scheduling details">
        <DetailsTable title="Node exclusions">
          <DetailRow label="Excluded by application" field="attempt.derived.appBlacklistedNodesText" raw={appBlacklistText}>
            <Datum field="attempt.blacklistedNodes" raw={attempt.blacklistedNodes}>
              {appBlacklistText}
            </Datum>
          </DetailRow>
          <DetailRow label="Excluded by system" field="attempt.derived.rmBlacklistedNodesText" raw={systemBlacklistText}>
            <Datum field="attempt.nodesBlacklistedBySystem" raw={attempt.nodesBlacklistedBySystem}>
              {systemBlacklistText}
            </Datum>
          </DetailRow>
        </DetailsTable>
        <details open={parity || undefined} className="overflow-hidden rounded-lg border border-seam bg-fabric">
          <summary className="cursor-pointer bg-fabric-2 px-3 py-1.5 text-small font-medium text-ink-2">
            Container locality · unavailable
          </summary>
          <p className="px-3 py-2 text-small text-ink-3" data-burrow="locality-unavailable">
            The ResourceManager does not report locality counts for this attempt. A dash means unavailable, not zero.
          </p>
          <DetailTableScroller ariaLabel="Container locality matrix">
            <table className="w-full min-w-[38rem] text-body" data-burrow="locality-matrix">
              <thead>
                <tr className="border-y border-seam bg-fabric-2 text-small text-ink-3">
                  <th scope="col" className="px-3 py-1.5 text-left font-medium">
                    Containers / request locality
                  </th>
                  {LOCALITY_MATRIX.columns.map((label) => (
                    <th key={label} scope="col" className="px-3 py-1.5 text-right font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {LOCALITY_MATRIX.rows.map((label, r) => (
                  <tr key={label} className="border-b border-seam-soft last:border-b-0">
                    <th scope="row" className="px-3 py-1.5 text-left text-small font-medium text-ink-3">
                      {label}
                    </th>
                    {LOCALITY_MATRIX.cells[r]!.map((cell, c) => (
                      <td key={LOCALITY_MATRIX.columns[c]} className="px-3 py-1.5 text-right text-ink-3 tnum">
                        <Datum
                          field={`attempt.derived.localityStatistics.${LOCALITY_MATRIX.rowKeys[r]}.by.${LOCALITY_MATRIX.columnKeys[c]}`}
                          raw={cell}
                          fmt="int"
                        >
                          —
                        </Datum>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </DetailTableScroller>
        </details>
      </Section>
    </Entity>
  );
}
