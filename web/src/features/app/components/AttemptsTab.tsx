/**
 * Attempts tab — the legacy `table#attempts` (Attempt ID · Started · Node · Logs · Nodes blacklisted by the
 * application · Nodes blacklisted by the RM for the app) plus the fields the REST API gives us for free (state,
 * finish time, elapsed, AM container, node id) so the table doubles as the attempt index for the detail route.
 */
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { Link } from "@tanstack/react-router";
import type { AppAttempt } from "~/api/schemas";
import { fmtDuration } from "~/lib/format";
import { Datum } from "~/ui/datum";
import { DataTable, type DataTableProps } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { StatusPill } from "~/ui/status";
import { Tooltip } from "~/ui/tooltip";
import { LogLink } from "./LogLink";
import { attemptElapsedMs, blacklistedIds, nodeHostPort } from "../model";

export const ATTEMPT_DEFAULT_VISIBILITY: ColumnVisibilityState = {
  appAttemptId: true,
  appAttemptState: true,
  startTime: true,
  finishedTime: true,
  elapsed: true,
  containerId: true,
  nodeHttpAddress: true,
  logs: true,
  blacklistedNodes: true,
  nodesBlacklistedBySystem: true,
  nodeId: false,
};

function columns(appId: string, now: number): ColDef<AppAttempt>[] {
  return [
    {
      id: "appAttemptId",
      accessorFn: (a) => a.appAttemptId,
      size: 250,
      meta: { label: "Attempt ID", pinned: true, hint: "RMAppAttemptID — links to the attempt page" },
      cell: ({ row }) => (
        <Tooltip label={row.original.appAttemptId}>
          <Link
            to="/apps/$appId/attempts/$attemptId"
            params={{ appId, attemptId: row.original.appAttemptId }}
            className="truncate font-mono text-live underline-offset-2 hover:underline"
          >
            <Datum field="attempt.appAttemptId" raw={row.original.appAttemptId} />
          </Link>
        </Tooltip>
      ),
    },
    {
      id: "appAttemptState",
      accessorFn: (a) => a.appAttemptState,
      size: 120,
      meta: { label: "State", hint: "RMAppAttemptState" },
      cell: ({ row }) => <StatusPill domain="app.state" state={row.original.appAttemptState} field="attempt.appAttemptState" size="sm" />,
    },
    {
      id: "startTime",
      accessorFn: (a) => a.startTime,
      size: 165,
      meta: { label: "Started", exportValue: (a: AppAttempt) => a.startTime },
      cell: ({ row }) => <Datum field="attempt.startTime" raw={row.original.startTime} fmt="epoch" className="tabular-nums" />,
    },
    {
      id: "finishedTime",
      accessorFn: (a) => a.finishedTime,
      size: 165,
      meta: { label: "Finished", exportValue: (a: AppAttempt) => a.finishedTime },
      cell: ({ row }) => <Datum field="attempt.finishedTime" raw={row.original.finishedTime} fmt="epoch" className="tabular-nums" />,
    },
    {
      id: "elapsed",
      accessorFn: (a) => attemptElapsedMs(a, now),
      size: 110,
      meta: {
        label: "Elapsed",
        align: "end",
        hint: "Times.elapsed(startTime, finishedTime) — live for a running attempt",
        exportValue: (a: AppAttempt) => attemptElapsedMs(a, Date.now()),
      },
      cell: ({ row }) => (
        <Datum field="attempt.derived.elapsedText" raw={attemptElapsedMs(row.original, now)} fmt="ms" className="tabular-nums">
          {fmtDuration(attemptElapsedMs(row.original, now))}
        </Datum>
      ),
    },
    {
      id: "containerId",
      accessorFn: (a) => a.containerId,
      size: 270,
      meta: { label: "AM Container", hint: "ContainerInfo of the ApplicationMaster" },
      cell: ({ row }) =>
        row.original.containerId ? (
          <Link
            to="/apps/$appId/containers/$containerId"
            params={{ appId, containerId: row.original.containerId }}
            className="truncate font-mono text-live underline-offset-2 hover:underline"
          >
            <Datum field="attempt.containerId" raw={row.original.containerId} />
          </Link>
        ) : (
          <Datum field="attempt.containerId" raw={row.original.containerId} />
        ),
    },
    {
      id: "nodeHttpAddress",
      accessorFn: (a) => a.nodeHttpAddress,
      size: 170,
      meta: { label: "Node", hint: "NodeManager web address of the AM container" },
      cell: ({ row }) =>
        row.original.nodeHttpAddress ? (
          <a
            href={`http://${row.original.nodeHttpAddress.replace(/^https?:\/\//, "")}`}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate font-mono text-ink-2 underline-offset-2 hover:underline"
          >
            <Datum field="attempt.nodeHttpAddress" raw={row.original.nodeHttpAddress} />
          </a>
        ) : (
          <Datum field="attempt.nodeHttpAddress" raw={row.original.nodeHttpAddress} />
        ),
    },
    {
      id: "nodeId",
      accessorFn: (a) => a.nodeId,
      size: 170,
      meta: { label: "Node ID (RPC)", defaultVisible: false },
      cell: ({ row }) => <Datum field="attempt.nodeId" raw={row.original.nodeId} className="font-mono text-small" />,
    },
    {
      id: "logs",
      accessorFn: (a) => a.logsLink,
      size: 90,
      meta: { label: "Logs", align: "start", hint: "Container log link (JHS for finished attempts, NM while running)" },
      cell: ({ row }) => (
        <>
          <LogLink appId={appId} containerId={row.original.containerId} node={nodeHostPort(row.original)} compact />
          <Datum field="attempt.logsLink" raw={row.original.logsLink} as="span" className="sr-only" />
        </>
      ),
    },
    {
      id: "blacklistedNodes",
      accessorFn: (a) => a.blacklistedNodes,
      size: 150,
      meta: {
        label: "Nodes blacklisted by the application",
        align: "end",
        hint: "Legacy cell shows the count; the ids come from RMAppAttemptInfo.blacklistedNodes",
      },
      cell: ({ row }) => {
        const ids = blacklistedIds(row.original.blacklistedNodes);
        return (
          <>
            <Datum
              field="attempt.derived.appBlacklistedNodesCount"
              raw={ids.length}
              fmt="int"
              title={ids.length ? ids.join(", ") : "No nodes blacklisted by the application"}
              className="tabular-nums"
            >
              {ids.length}
            </Datum>
            <Datum field="attempt.blacklistedNodes" raw={row.original.blacklistedNodes} as="span" className="sr-only">
              {ids.join(", ")}
            </Datum>
          </>
        );
      },
    },
    {
      id: "nodesBlacklistedBySystem",
      accessorFn: (a) => a.nodesBlacklistedBySystem,
      size: 150,
      meta: { label: "Nodes blacklisted by the RM for the app", align: "end", hint: "Legacy tooltip: Nodes blacklisted by the system" },
      cell: ({ row }) => {
        const ids = blacklistedIds(row.original.nodesBlacklistedBySystem);
        return (
          <>
            <Datum
              field="attempt.derived.rmBlacklistedNodesCount"
              raw={ids.length}
              fmt="int"
              title={ids.length ? ids.join(", ") : "No nodes blacklisted by the system"}
              className="tabular-nums"
            >
              {ids.length}
            </Datum>
            <Datum field="attempt.nodesBlacklistedBySystem" raw={row.original.nodesBlacklistedBySystem} as="span" className="sr-only">
              {ids.join(", ")}
            </Datum>
          </>
        );
      },
    },
  ];
}

export function AttemptsTab({
  appId,
  attempts,
  now,
  sorting,
  onSortingChange,
  columnVisibility,
  onColumnVisibilityChange,
  loading,
  error,
  toolbar,
}: {
  appId: string;
  attempts: readonly AppAttempt[];
  now: number;
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  columnVisibility: ColumnVisibilityState;
  onColumnVisibilityChange: (v: ColumnVisibilityState) => void;
  loading?: boolean;
  error?: DataTableProps<AppAttempt>["error"];
  toolbar?: React.ReactNode;
}) {
  return (
    <DataTable<AppAttempt>
      data={attempts}
      columns={columns(appId, now)}
      getRowId={(a) => a.appAttemptId}
      label="Application attempts"
      storageKey="app-attempts"
      sorting={sorting}
      onSortingChange={onSortingChange}
      columnVisibility={columnVisibility}
      onColumnVisibilityChange={onColumnVisibilityChange}
      defaultVisibility={ATTEMPT_DEFAULT_VISIBILITY}
      loading={loading}
      error={error}
      empty={<p className="p-6 text-center text-small text-ink-3">The RM reports no attempts for this application.</p>}
      totalCount={attempts.length}
      toolbar={toolbar}
      exportName={`${appId}-attempts`}
      rowVersion={(a) => `${a.appAttemptState}:${a.finishedTime}`}
    />
  );
}
