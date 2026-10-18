/**
 * Choosing a container when the URL does not name one.
 *
 * The ResourceManager drops container records when an attempt reaches a terminal state, so for a finished application
 * its container list is genuinely empty — but the *attempt* records still name the AM container (`containerId`) and
 * carry the JobHistory aggregated-log URL (`logsLink`). Those are the primary source here; the live-container list is
 * shown when the RM still holds it, and a paste box covers the genuinely-unknown case (no attempts, no containers).
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useState } from "react";
import { q } from "~/api/queries";
import { type AppAttempt, selectAppAttempts, selectContainers } from "~/api/schemas";
import { attemptIdFromContainerId } from "~/features/app/model";
import { Button } from "~/ui/button";
import { Datum, Entity } from "~/ui/datum";
import { DetailTableScroller } from "~/ui/detail-table-scroller";
import { EmptyState, ErrorState, Skeleton } from "~/ui/feedback";
import { StatusPill } from "~/ui/status";
import { Tooltip } from "~/ui/tooltip";
import { Section } from "~/features/nodes/page";

export interface LogsLinkParts {
  node: string | null;
  containerId: string | null;
  user: string | null;
}

/**
 * `/jobhistory/logs/<node>/<containerId>/<containerId>/<user>[/<file>]` — the RM's per-attempt aggregated-log URL
 * (`AppAttemptInfo.logsLink`). The container id, node and user are recoverable from it, which is how a finished
 * application's AM log can be opened when the attempt record omits them.
 */
export function parseLogsLink(link: string | null | undefined): LogsLinkParts {
  if (!link) return { node: null, containerId: null, user: null };
  const m = /\/(?:jobhistory\/)?logs\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)/.exec(link);
  if (!m) return { node: null, containerId: null, user: null };
  return { node: m[1] ?? null, containerId: m[2] ?? null, user: m[4] ?? null };
}

export interface ContainerPickerProps {
  appId: string;
  onPick: (containerId: string, node: string | null, user: string | null) => void;
}

interface AmRow {
  attempt: AppAttempt;
  containerId: string;
  node: string | null;
  user: string | null;
  /** the attempt exposes a JobHistory aggregated-log URL ⇒ the log is (or will be) aggregated */
  aggregated: boolean;
}

export function ContainerPicker({ appId, onPick }: ContainerPickerProps) {
  const attempts = useQuery(q.appAttempts(appId));
  const list = selectAppAttempts(attempts.data ?? {});
  const [manual, setManual] = useState("");

  const containerQueries = useQueries({
    queries: list.map((a: AppAttempt) => ({ ...q.appContainers(appId, a.appAttemptId), enabled: !!a.appAttemptId })),
  });

  if (attempts.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (attempts.isError && !attempts.data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <ErrorState
          title="Could not load application attempts"
          message={attempts.error instanceof Error ? attempts.error.message : String(attempts.error)}
          hint="The attempt list supplies the ApplicationMaster container ids and aggregated-log locations. Retry the ResourceManager request or open a container by id below."
          onRetry={() => void attempts.refetch()}
        />
        <ManualContainerForm value={manual} onValueChange={setManual} onPick={onPick} />
      </div>
    );
  }

  // AM containers, derived from the attempt records — the only source for a finished application.
  const amRows: AmRow[] = list
    .map((attempt) => {
      const parts = parseLogsLink(attempt.logsLink);
      return {
        attempt,
        containerId: attempt.containerId || parts.containerId || "",
        node: attempt.nodeHttpAddress || attempt.nodeId || parts.node,
        user: parts.user,
        aggregated: !!attempt.logsLink,
      };
    })
    .filter((r) => !!r.containerId);

  const liveRows = list.flatMap((attempt, i) => {
    const containers = containerQueries[i]?.data ? selectContainers(containerQueries[i]!.data!) : [];
    // The AM container is already listed from the attempt record; don't repeat it.
    return containers.filter((c) => !amRows.some((r) => r.containerId === c.containerId)).map((c) => ({ attempt, container: c }));
  });

  const nothingKnown = amRows.length === 0 && liveRows.length === 0;
  const failedContainerQueries = list.flatMap((attempt, index) => {
    const query = containerQueries[index];
    if (!query?.isError) return [];
    return [
      {
        query,
        attemptId: attempt.appAttemptId,
        message: query.error instanceof Error ? query.error.message : String(query.error),
      },
    ];
  });
  const failedContainerSummary = failedContainerQueries
    .slice(0, 3)
    .map(({ attemptId, message }) => `${attemptId}: ${message || "Unknown error"}`)
    .join(" · ");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {attempts.isError && (
        <ErrorState
          compact
          title="Could not refresh application attempts"
          message={attempts.error instanceof Error ? attempts.error.message : String(attempts.error)}
          onRetry={() => void attempts.refetch()}
        />
      )}
      {failedContainerQueries.length > 0 && (
        <ErrorState
          compact
          title="Some live container lists could not be loaded"
          message={`${failedContainerQueries.length} attempt container lookup(s) failed. ${failedContainerSummary}${
            failedContainerQueries.length > 3 ? ` · ${failedContainerQueries.length - 3} more failed.` : ""
          }`}
          hint="ApplicationMaster rows and any successful lookups remain available."
          onRetry={() => void Promise.all(failedContainerQueries.map(({ query }) => query.refetch()))}
        />
      )}
      {amRows.length > 0 && (
        <Section title="ApplicationMaster containers" actions={<span className="text-caption text-ink-4">from the attempt records</span>}>
          <DetailTableScroller ariaLabel="ApplicationMaster containers" className="burrow-picker rounded-lg border border-seam bg-fabric">
            <table className="w-full max-lg:table-fixed border-collapse text-small">
              <caption className="sr-only">ApplicationMaster containers of {appId}</caption>
              <thead className="sticky top-0 border-b border-seam bg-fabric-2 text-small">
                <tr>
                  <th scope="col" className="max-lg:w-[50%] px-3 py-1.5 text-left font-medium text-ink-3">
                    Container
                  </th>
                  <th scope="col" className="max-lg:w-[20%] px-3 py-1.5 text-left font-medium text-ink-3">
                    Attempt
                  </th>
                  <th scope="col" className="px-3 py-1.5 text-left font-medium text-ink-3">
                    Node
                  </th>
                  <th scope="col" className="px-3 py-1.5 text-left font-medium text-ink-3">
                    State
                  </th>
                  <th scope="col" className="px-3 py-1.5 text-left font-medium text-ink-3">
                    Started
                  </th>
                  <th scope="col" className="px-3 py-1.5 text-right font-medium text-ink-3">
                    Log source
                  </th>
                  <th scope="col" className="max-lg:w-[20%] px-3 py-1.5">
                    <span className="sr-only">Logs</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {amRows.map((row) => (
                  <Entity
                    key={`am-${row.containerId}`}
                    id={row.containerId}
                    as="tr"
                    className="border-b border-seam-soft last:border-0 hover:bg-fabric-3"
                  >
                    <td className="px-3 py-1.5">
                      <Tooltip label={row.containerId}>
                        <Datum field="log.containerId" raw={row.containerId} fmt="text" className="block truncate font-mono text-ink" />
                      </Tooltip>
                    </td>
                    <td className="px-3 py-1.5">
                      <Tooltip label={row.attempt.appAttemptId}>
                        <Link
                          to="/apps/$appId/attempts/$attemptId"
                          params={{ appId, attemptId: row.attempt.appAttemptId }}
                          className="block truncate font-mono text-live underline-offset-2 hover:underline"
                        >
                          {row.attempt.appAttemptId}
                        </Link>
                      </Tooltip>
                    </td>
                    <td className="px-3 py-1.5">
                      <Datum field="log.nodeId" raw={row.node} fmt="text" className="font-mono text-ink-2" />
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusPill domain="app.state" state={row.attempt.appAttemptState} field="attempt.appAttemptState" size="sm" />
                    </td>
                    <td className="px-3 py-1.5">
                      <Datum field="attempt.startTime" raw={row.attempt.startTime} fmt="epoch" className="tnum text-ink-2" />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span className="text-caption text-ink-3" data-burrow-log-hint={row.aggregated ? "jhs" : "nm"}>
                        {row.aggregated ? "Aggregated (JobHistory)" : "NodeManager"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Tooltip
                        label={
                          row.aggregated
                            ? "Read the JobHistory aggregated copy of this container's logs"
                            : "Read this container's logs from its NodeManager"
                        }
                      >
                        <Button variant="quiet" size="sm" onClick={() => onPick(row.containerId, row.node, row.user)}>
                          <FileText className="size-3.5" aria-hidden="true" />
                          <span className="burrow-picker-full-action">{row.aggregated ? "Aggregated log (JobHistory)" : "Open logs"}</span>
                          <span className="burrow-picker-short-action">Logs</span>
                        </Button>
                      </Tooltip>
                    </td>
                  </Entity>
                ))}
              </tbody>
            </table>
          </DetailTableScroller>
        </Section>
      )}

      {liveRows.length > 0 && (
        <Section title="Live containers" actions={<span className="text-caption text-ink-4">held by the ResourceManager</span>}>
          <DetailTableScroller ariaLabel="Live containers" className="burrow-picker rounded-lg border border-seam bg-fabric">
            <table className="w-full max-lg:table-fixed border-collapse text-small">
              <caption className="sr-only">Live containers of {appId}</caption>
              <thead className="sticky top-0 border-b border-seam bg-fabric-2 text-small">
                <tr>
                  <th scope="col" className="max-lg:w-[50%] px-3 py-1.5 text-left font-medium text-ink-3">
                    Container
                  </th>
                  <th scope="col" className="max-lg:w-[20%] px-3 py-1.5 text-left font-medium text-ink-3">
                    Attempt
                  </th>
                  <th scope="col" className="px-3 py-1.5 text-left font-medium text-ink-3">
                    Node
                  </th>
                  <th scope="col" className="px-3 py-1.5 text-left font-medium text-ink-3">
                    State
                  </th>
                  <th scope="col" className="px-3 py-1.5 text-right font-medium text-ink-3">
                    Exit
                  </th>
                  <th scope="col" className="max-lg:w-[20%] px-3 py-1.5">
                    <span className="sr-only">Logs</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {liveRows.map(({ attempt, container }) => (
                  <Entity
                    key={container.containerId}
                    id={container.containerId}
                    as="tr"
                    className="border-b border-seam-soft last:border-0 hover:bg-fabric-3"
                  >
                    <td className="px-3 py-1.5">
                      <Tooltip label={container.containerId}>
                        <Datum
                          field="log.containerId"
                          raw={container.containerId}
                          fmt="text"
                          className="block truncate font-mono text-ink"
                        />
                      </Tooltip>
                    </td>
                    <td className="px-3 py-1.5">
                      <Tooltip label={attempt.appAttemptId}>
                        <Link
                          to="/apps/$appId/attempts/$attemptId"
                          params={{ appId, attemptId: attempt.appAttemptId }}
                          className="block truncate font-mono text-live underline-offset-2 hover:underline"
                        >
                          {attempt.appAttemptId}
                        </Link>
                      </Tooltip>
                    </td>
                    <td className="px-3 py-1.5">
                      <Datum
                        field="log.nodeId"
                        raw={container.nodeHttpAddress ?? container.nodeId}
                        fmt="text"
                        className="font-mono text-ink-2"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusPill domain="container.state" state={container.containerState} field="container.containerState" size="sm" />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Datum
                        field="container.containerExitStatus"
                        raw={container.containerExitStatus}
                        fmt="int"
                        className="tnum text-ink-2"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Tooltip label="Read this container's logs from its NodeManager">
                        <Button
                          variant="quiet"
                          size="sm"
                          onClick={() => onPick(container.containerId, container.nodeHttpAddress ?? container.nodeId, null)}
                        >
                          <FileText className="size-3.5" aria-hidden="true" />
                          <span className="burrow-picker-full-action">Open logs</span>
                          <span className="burrow-picker-short-action">Logs</span>
                        </Button>
                      </Tooltip>
                    </td>
                  </Entity>
                ))}
              </tbody>
            </table>
          </DetailTableScroller>
        </Section>
      )}

      {nothingKnown && (
        <EmptyState title="No container named by this application">
          The ResourceManager holds no container records and the attempts name no AM container — there is nothing to open. Paste a container
          id below to read a log directly.
        </EmptyState>
      )}

      <ManualContainerForm value={manual} onValueChange={setManual} onPick={onPick} />
    </div>
  );
}

function ManualContainerForm({
  value: manual,
  onValueChange: setManual,
  onPick,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onPick: ContainerPickerProps["onPick"];
}) {
  return (
    <Section title="Open by container id">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const id = manual.trim();
          if (id) onPick(id, null, null);
        }}
      >
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="container_…_01_000001"
          aria-label="Container id"
          className="h-(--ctl-h) min-w-72 flex-1 rounded-md border border-seam-strong bg-well px-2 font-mono text-small text-ink placeholder:text-ink-4 focus:border-ink-4 focus:outline-none"
        />
        <Button type="submit" disabled={!manual.trim()}>
          Open pasted container
        </Button>
        {manual.trim() && !attemptIdFromContainerId(manual.trim()) && (
          <span className="text-caption text-warn">
            Not a container id — expected container_&lt;ts&gt;&lt;app&gt;&lt;attempt&gt;&lt;n&gt;.
          </span>
        )}
      </form>
    </Section>
  );
}
