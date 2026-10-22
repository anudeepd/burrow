/**
 * The sticky status bar: what is on screen, how much was searched, how far behind the live tail we are, and which
 * transport is carrying the follow. It is the honest counterweight to the viewer — if the stream dropped to polling,
 * or a reconnect skipped bytes, this is where the user finds out.
 */
import { AlertTriangle, CircleDot, RefreshCw } from "lucide-react";
import { cn } from "~/lib/cn";
import { fmtBytes } from "~/lib/format";
import { Button } from "~/ui/button";
import { HelpTip } from "~/ui/tooltip";
import type { LogLevel } from "./model";
import type { FollowMode } from "./use-follow";

export interface LogStatusBarProps {
  shown: number;
  total: number;
  dropped: number;
  hits: number;
  activeMatch: number;
  filter: LogLevel | null;
  followMode: FollowMode;
  followDetail: string | null;
  behind: number | null;
  size: number;
  heldBytes: number;
  ended: boolean;
  gaps: number;
  /** a one-shot message from an action (e.g. "jump to first error" found nothing) */
  notice: string | null;
  onRetry: () => void;
}

const MODE_LABEL: Record<FollowMode, string> = {
  off: "Not following",
  connecting: "Connecting to log stream…",
  streaming: "Following new output",
  reconnecting: "Reconnecting…",
  polling: "Following by polling",
  ended: "Stream ended",
  error: "Stream error",
};

const MODE_TONE: Record<FollowMode, string> = {
  off: "text-ink-4",
  connecting: "text-wait",
  streaming: "text-ok",
  reconnecting: "text-wait",
  polling: "text-wait",
  ended: "text-ink-3",
  error: "text-fail",
};

export function LogStatusBar(props: LogStatusBarProps) {
  const {
    shown,
    total,
    dropped,
    hits,
    activeMatch,
    filter,
    followMode,
    followDetail,
    behind,
    size,
    heldBytes,
    ended,
    gaps,
    notice,
    onRetry,
  } = props;
  return (
    <div className="sticky bottom-0 z-sticky flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-seam bg-fabric/95 px-3 py-1.5 text-caption text-ink-3 backdrop-blur">
      <span className="tnum" data-burrow-log-lines>
        {shown.toLocaleString("en-US")}
        {filter ? ` / ${total.toLocaleString("en-US")}` : ""} lines
      </span>
      {dropped > 0 && (
        <span className="inline-flex items-center gap-1 tnum text-warn">
          {dropped.toLocaleString("en-US")} older lines dropped
          <HelpTip label="Dropped log lines">
            The viewer keeps a bounded buffer. Older lines have been removed from this view; download the log to read the full file.
          </HelpTip>
        </span>
      )}
      {hits > 0 && (
        <span className="tnum" data-burrow-log-hits>
          match {activeMatch + 1} of {hits.toLocaleString("en-US")}
        </span>
      )}
      {gaps > 0 && (
        <span className="inline-flex items-center gap-1 text-warn">
          <AlertTriangle className="size-3" aria-hidden="true" />
          {gaps} byte gap{gaps === 1 ? "" : "s"} skipped
          <HelpTip label="Skipped log bytes">
            The connection resumed after bytes that were not loaded. Refresh or download the file to read the missing output.
          </HelpTip>
        </span>
      )}
      {notice && (
        <span className="text-warn" role="status" data-burrow-log-notice>
          {notice}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        <CircleDot className={cn("size-3", MODE_TONE[followMode])} aria-hidden="true" />
        <span className={cn("font-medium", MODE_TONE[followMode])} data-burrow-log-follow={followMode}>
          {MODE_LABEL[followMode]}
        </span>
        {followDetail && <span className="text-ink-4">— {followDetail}</span>}
        {(followMode === "polling" || followMode === "reconnecting" || followMode === "error") && (
          <Button variant="ghost" size="sm" onClick={onRetry} aria-label="Retry the log stream" className="h-5 px-1.5 text-caption">
            <RefreshCw className="size-3" aria-hidden="true" />
            Retry
          </Button>
        )}
      </span>
      <span className="tnum">
        {heldBytes > 0 ? `${fmtBytes(heldBytes)} held` : "0 B held"}
        {size > 0 && <> of {fmtBytes(size)}</>}
      </span>
      {behind != null && behind > 0 && <span className="tnum text-wait">{fmtBytes(behind)} behind</span>}
      {ended && (
        <span className="text-ink-3" data-burrow-log-ended="1">
          container finished
        </span>
      )}
    </div>
  );
}
