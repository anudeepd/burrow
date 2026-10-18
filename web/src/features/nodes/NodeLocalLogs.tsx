/**
 * Node-local logs for one node.
 *
 * The contract exposes container logs through `/api/logs/containers/{containerId}?node=host:port` (api.md §5), which the
 * NodeManager serves per container — there is no "list the node's log files" endpoint. So this section asks that endpoint for
 * the node's first container and reports exactly what came back:
 *   - a real file list when the log routes are implemented,
 *   - an explicit "source unavailable + reason" state when they are not (never invented files).
 */
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiGet } from "~/api/client";
import { nq } from "~/api/queries/nodes";
import type { Node } from "~/api/schemas";
import { fmtEpoch, fmtInt } from "~/lib/format";
import { Datum, Entity } from "~/ui/datum";
import { usePref } from "~/state/prefs";
import { EmptyState, ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { Section, Unavailable } from "./page";

/** `GET /api/logs/containers/{id}` (api.md §5). */
const LogSourceSchema = z.object({
  source: z.string(),
  node: z.string().nullable(),
  files: z
    .array(
      z.object({
        name: z.string(),
        size: z.number(),
        lastModified: z.number(),
      }),
    )
    .default([]),
});
type LogSource = z.infer<typeof LogSourceSchema>;

export function NodeLocalLogs({ node }: { node: Node }) {
  const address = node.nodeHTTPAddress;
  const tz = usePref("tz");
  const containers = useQuery({ ...nq.nmContainers(address), enabled: address !== "" });
  const first = containers.data?.[0];

  const probe = useQuery({
    queryKey: ["logs", "containers", first?.id, address],
    queryFn: ({ signal }) =>
      apiGet(`logs/containers/${encodeURIComponent(first?.id ?? "")}`, {
        signal,
        query: { node: address },
        schema: LogSourceSchema,
        timeoutMs: 8_000,
      }),
    enabled: !!first && !!address,
    retry: false,
  });

  return (
    <Section title="Node-local logs">
      {address === "" ? (
        <Unavailable title="No NodeManager address" reason="Node logs are served by the NodeManager, and this node has none." />
      ) : containers.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : containers.error && containers.data === undefined ? (
        <ErrorState
          title="Cannot read this node's containers"
          message="The NodeManager did not return its container list."
          hint="Check that the NodeManager is reachable, then retry."
          onRetry={() => void containers.refetch()}
        />
      ) : !first ? (
        <>
          {containers.error && (
            <StaleErrorBanner
              title="Could not refresh this node's containers"
              error={containers.error}
              onRetry={() => void containers.refetch()}
            />
          )}
          <EmptyState title="No container on this node">
            Container logs live under the container's directory in the NodeManager's log dir, so there is nothing to read here yet.
          </EmptyState>
        </>
      ) : probe.error && probe.data === undefined ? (
        <ErrorState
          title="Could not check NodeManager logs"
          message={`Burrow could not read log metadata for ${first.id}.`}
          hint="Check that the NodeManager is reachable and has logs for this container, then retry."
          onRetry={() => void probe.refetch()}
        />
      ) : !probe.data ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <Entity id={node.id} as="div" className="flex flex-col gap-2">
          {containers.error && (
            <StaleErrorBanner
              title="Could not refresh this node's containers"
              error={containers.error}
              onRetry={() => void containers.refetch()}
            />
          )}
          {probe.error && (
            <ErrorState
              compact
              title="Could not refresh NodeManager logs"
              message="The previously loaded log list is still shown."
              onRetry={() => void probe.refetch()}
            />
          )}
          <p className="text-small text-ink-3">
            Source <span className="font-mono text-ink-2">{probe.data.source}</span> for container{" "}
            <span className="font-mono text-ink-2">{first.id}</span> (proxy: {probe.data.node ?? address})
          </p>
          <ul className="divide-y divide-seam-soft rounded-lg border border-seam bg-fabric">
            {probe.data.files.map((f) => (
              <li key={f.name} className="flex items-center gap-3 px-3 py-1.5">
                <Datum field="log.name" raw={f.name} fmt="text" className="min-w-0 flex-1 truncate font-mono text-small" />
                <Datum field="log.size" raw={f.size} fmt="int" className="text-small text-ink-3 tnum" />
                <Datum field="log.lastModified" raw={f.lastModified} fmt="epoch" className="text-small text-ink-3" />
                <a
                  href={`/api/logs/containers/${encodeURIComponent(first.id)}/files/${encodeURIComponent(f.name)}?node=${encodeURIComponent(address)}`}
                  className="text-small text-live underline-offset-2 hover:underline"
                >
                  open
                </a>
              </li>
            ))}
            {probe.data.files.length === 0 && <li className="px-3 py-2 text-small text-ink-3">The source reported no files yet.</li>}
          </ul>
          <p className="text-micro text-ink-4">
            Total {fmtInt(probe.data.files.length)} file(s) · newest{" "}
            {fmtEpoch(Math.max(0, ...probe.data.files.map((f) => f.lastModified)), tz)}
          </p>
        </Entity>
      )}
    </Section>
  );
}

export type { LogSource };
