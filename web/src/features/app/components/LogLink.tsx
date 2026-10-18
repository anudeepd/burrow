/**
 * Cross-link to the container log viewer (owned by the logs slice).
 *
 * The viewer's route and the backend `/api/logs/*` routes are not part of this build yet, so the link is gated on
 * `/api/meta`.features (docs/contracts/api.md §2): while neither `nodeLogs` nor `aggregatedLogs` is true we render an
 * honest, focusable "unavailable" control that says *what* would back it and *why* it is missing. Never a dead link,
 * never a fabricated log line.
 */
import { FileText } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { q } from "~/api/queries";
import { cn } from "~/lib/cn";
import { Button } from "~/ui/button";
import { Tooltip } from "~/ui/tooltip";

const REASON =
  "Log source: NodeManager (running containers) or JobHistory/ATS (aggregated) via Burrow — unavailable in this build until the backend log routes land.";

export function LogLink({
  appId,
  containerId,
  node,
  user,
  className,
  compact,
}: {
  appId: string;
  containerId: string;
  /** NM host:port known by the caller, passed to the viewer as a hint */
  node?: string | null;
  user?: string | null;
  className?: string;
  compact?: boolean;
}) {
  const meta = useQuery(q.meta());
  const features = meta.data?.features;
  const available = !!features && (features.nodeLogs || features.aggregatedLogs);
  const href = `/apps/${appId}/logs?container=${encodeURIComponent(containerId)}${node ? `&node=${encodeURIComponent(node)}` : ""}${
    user ? `&user=${encodeURIComponent(user)}` : ""
  }`;

  if (available) {
    return (
      <a href={href} className={cn("inline-flex items-center gap-1.5 text-live underline-offset-2 hover:underline", className)}>
        <FileText className="size-3.5" aria-hidden="true" />
        Logs
      </a>
    );
  }
  if (meta.error) {
    const error = meta.error instanceof Error ? meta.error.message : String(meta.error);
    return (
      <Tooltip label={`Burrow could not confirm log support. ${error}`}>
        <Button
          variant="quiet"
          size="sm"
          aria-label="Retry checking log support"
          data-burrow="log-source-check-failed"
          onClick={() => void meta.refetch()}
          className={cn("text-warn", className)}
        >
          <FileText className="size-3.5" aria-hidden="true" />
          {compact ? "Retry" : "Retry log check"}
        </Button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={REASON}>
      <Button
        variant="quiet"
        size="sm"
        aria-disabled="true"
        data-burrow="log-source-unavailable"
        onClick={(e) => e.preventDefault()}
        className={cn("opacity-70", className)}
      >
        <FileText className="size-3.5" aria-hidden="true" />
        {compact ? "Logs" : "Logs (unavailable)"}
      </Button>
    </Tooltip>
  );
}
