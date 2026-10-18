/**
 * Containers on one node — from the NodeManager (`/api/nm/{host:port}/containers`, contract §3), because the RM's
 * `/ws/v1/cluster/nodes/{id}` payload carries only a count. `NMContainerInfo` has its own field names
 * (`id`, `memoryNeeded`, `vCoresNeeded`, `shortLogLink`) which is why it has its own schema in `api/queries/nodes.ts`.
 */
import { useMemo } from "react";
import type { NmContainer } from "~/api/queries/nodes";
import type { Node } from "~/api/schemas";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import { EmptyState, ErrorState, StaleErrorBanner } from "~/ui/feedback";
import { StatusPill } from "~/ui/status";
import { HelpTip, OptionalTooltip } from "~/ui/tooltip";
import { appIdOfContainer } from "./domain";
import { Unavailable } from "./page";

export function NodeContainers({
  node,
  containers,
  loading,
  error,
  onRetry,
}: {
  node: Node;
  containers?: NmContainer[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const address = node.nodeHTTPAddress;
  const columns = useMemo(() => containerColumns(address), [address]);

  return (
    <section className="flex min-h-0 flex-col gap-2">
      <h2 className="text-lead font-medium text-ink-2">Containers on this node</h2>
      {address === "" ? (
        <Unavailable title="Containers are not readable" reason="This node has no NodeManager HTTP address in the ResourceManager." />
      ) : error && !containers ? (
        <ErrorState
          title="Cannot read the NodeManager's container list"
          message="The NodeManager did not return its container list."
          hint={`Burrow proxies /ws/v1/node/containers from ${address}. The ResourceManager only reports a count, so this list needs the NodeManager.`}
          detail={error instanceof Error ? error.message : undefined}
          onRetry={onRetry}
        />
      ) : (
        <>
          {error && <StaleErrorBanner title="Container refresh failed; showing the last loaded rows" error={error} onRetry={onRetry} />}
          <DataTable
            data={containers ?? []}
            columns={columns}
            getRowId={(c) => c.id}
            entityKey={(c) => c.id}
            label="Containers on this node"
            storageKey="burrow.node.containers"
            sorting={[]}
            onSortingChange={() => undefined}
            columnVisibility={{}}
            onColumnVisibilityChange={() => undefined}
            defaultVisibility={{}}
            loading={loading}
            exportName={`node-${node.id}-containers`}
            totalCount={containers?.length}
            empty={
              <EmptyState title="No containers on this node" className="py-2">
                Containers will appear here when YARN schedules work.
              </EmptyState>
            }
            className="min-h-[10rem]"
          />
        </>
      )}
    </section>
  );
}

function containerColumns(address: string): ColDef<NmContainer>[] {
  return [
    {
      id: "id",
      accessorFn: (c) => c.id,
      size: 300,
      meta: { label: "Container ID" },
      cell: ({ row }) => {
        const appId = appIdOfContainer(row.original.id);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Datum field="nm.container.id" raw={row.original.id} fmt="text" className="truncate font-mono text-small" />
            {appId && (
              /* plain anchor: the application slice owns that route and this feature must not depend on its route id */
              <a
                href={`/apps/${encodeURIComponent(appId)}`}
                className="shrink-0 text-micro text-ink-3 underline-offset-2 hover:text-live hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                app
              </a>
            )}
          </span>
        );
      },
    },
    {
      id: "state",
      accessorFn: (c) => c.state,
      size: 110,
      meta: { label: "State" },
      cell: ({ row }) => <StatusPill domain="container.state" state={row.original.state} field="nm.container.state" size="sm" />,
    },
    {
      id: "user",
      accessorFn: (c) => c.user,
      size: 110,
      meta: { label: "User" },
      cell: ({ row }) => <Datum field="nm.container.user" raw={row.original.user} fmt="text" className="truncate text-small" />,
    },
    {
      id: "totalMemoryNeededMB",
      accessorFn: (c) => c.totalMemoryNeededMB,
      size: 110,
      meta: { label: "Memory", align: "end" },
      cell: ({ row }) => (
        <Datum field="nm.container.totalMemoryNeededMB" raw={row.original.totalMemoryNeededMB} fmt="mb" className="block text-end tnum" />
      ),
    },
    {
      id: "totalVCoresNeeded",
      accessorFn: (c) => c.totalVCoresNeeded,
      size: 90,
      meta: { label: "vCores", align: "end" },
      cell: ({ row }) => (
        <Datum field="nm.container.totalVCoresNeeded" raw={row.original.totalVCoresNeeded} fmt="int" className="block text-end tnum" />
      ),
    },
    {
      id: "exitCode",
      accessorFn: (c) => c.exitCode,
      size: 120,
      meta: {
        label: "Exit code",
        hint: "Container exit code: 0 succeeded; -100 aborted; -102 preempted; -103 virtual-memory limit; -104 physical-memory limit; -1000 no valid exit status yet.",
      },
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <Datum
            field="nm.container.exitCode"
            raw={row.original.exitCode}
            fmt="int"
            className="shrink-0 text-small tnum"
            title={row.original.state === "RUNNING" || row.original.exitCode === -1000 ? "Available when the container exits." : undefined}
          >
            {row.original.state === "RUNNING" || row.original.exitCode === -1000 ? "—" : undefined}
          </Datum>
          {row.original.exitStatus && (
            <Datum field="nm.container.exitStatus" raw={row.original.exitStatus} fmt="text" className="truncate text-micro text-ink-4" />
          )}
        </span>
      ),
    },
    {
      id: "logs",
      accessorFn: (c) => c.containerLogsLink ?? "",
      size: 120,
      meta: { label: "Logs" },
      cell: ({ row }) => {
        const files = row.original.containerLogFiles ?? [];
        if (!row.original.containerLogsLink && files.length === 0) {
          return (
            <span className="inline-flex items-center gap-1 text-small text-ink-4">
              —<HelpTip label="Container logs">The NodeManager reports no log files for this container yet.</HelpTip>
            </span>
          );
        }
        // Deep link into the container-log viewer (FE-Logs owns /apps/$appId/logs; shape:
        // ?container=<id>&file=<name>&node=<host:port>). Plain anchor on purpose: this slice must not depend on another
        // slice's route id, and the link still works if the viewer is mounted from a nested path.
        const appId = appIdOfContainer(row.original.id);
        const href = appId
          ? `/apps/${encodeURIComponent(appId)}/logs?container=${encodeURIComponent(row.original.id)}&file=stdout&node=${encodeURIComponent(address)}`
          : `/api/logs/containers/${encodeURIComponent(row.original.id)}?node=${encodeURIComponent(address)}`;
        return (
          <OptionalTooltip label={`Open the container logs (${files.length} file${files.length === 1 ? "" : "s"} on the NodeManager)`}>
            <a href={href} className="text-small text-live underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
              {files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"}` : "view"}
            </a>
          </OptionalTooltip>
        );
      },
    },
    {
      id: "diagnostics",
      accessorFn: (c) => c.diagnostics ?? "",
      size: 220,
      meta: { label: "Diagnostics", defaultVisible: false },
      cell: ({ row }) => (
        <Datum
          field="nm.container.diagnostics"
          raw={row.original.diagnostics}
          fmt="text"
          className="block truncate text-small text-ink-3"
          title={row.original.diagnostics ?? ""}
        />
      ),
    },
  ];
}
