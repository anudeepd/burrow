import { Check, Copy, Inbox, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "~/lib/cn";
import { useInView } from "~/lib/in-view";
import { motionAllowed, tokenMs } from "~/lib/motion";
import { copyText, describeError, simpleErrorText } from "~/lib/error-details";
import { Button } from "./button";

/** One row of skeleton. The shimmer loops only while the box is on screen (`data-visible` drives the CSS gate). */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const [ref, visible] = useInView<HTMLDivElement>();
  return <div ref={ref} aria-hidden="true" data-visible={visible} className={cn("burrow-skeleton h-3", className)} style={style} />;
}

/** Gives a route-level error or empty state the full content area for vertical centering. */
export function CenteredPageState({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid min-h-0 flex-1 place-items-center py-8", className)}>{children}</div>;
}

/** Structural skeleton for a table: same row height/column rhythm as the real thing so nothing jumps on load. */
export function TableSkeleton({ rows = 10, cols = 7 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="flex flex-col">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-seam-soft px-3" style={{ height: "var(--row-h)" }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="h-2.5" style={{ width: `${c === 0 ? 14 : 6 + ((r * 7 + c * 13) % 9)}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Empty = an invitation: say what is missing and offer exactly one next action. */
export function EmptyState({
  title,
  children,
  action,
  icon,
  compact = false,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "burrow-enter mx-auto flex max-w-xl",
        compact && "w-fit max-w-full",
        compact
          ? "flex-row flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 py-4 text-left"
          : "flex-col items-center gap-2 px-6 py-14 text-center",
        className,
      )}
    >
      <div
        className={cn(
          "mb-1 grid size-10 place-items-center rounded-full border border-dashed border-seam-strong text-ink-3",
          compact && "mb-0 size-7",
        )}
      >
        {icon ?? <Inbox className={cn("size-5", compact && "size-4")} aria-hidden="true" />}
      </div>
      <div className={cn(compact ? "min-w-0 flex-1 basis-48 text-left" : "contents")}>
        <h2 className={compact ? "text-small font-medium" : "text-lead"}>{title}</h2>
        {children && <p className={compact ? "text-caption text-ink-3" : "text-body text-ink-3"}>{children}</p>}
      </div>
      {action && <div className={compact ? "mt-0" : "mt-2"}>{action}</div>}
    </div>
  );
}

/** Errors say what failed, where, and what to try; never apologise, never vague.
 *
 * Every technical payload lives behind the same copyable disclosure: `error` derives it from an ApiError/Error, `detail`
 * carries a bespoke string (e.g. a Spark failure reason). The normal state never shows a stack trace or raw envelope.
 */
export function ErrorState({
  title,
  message,
  error,
  detail,
  hint,
  onRetry,
  compact = false,
  className,
}: {
  title: string;
  message?: ReactNode;
  /** Raw failure; supplies the one-line message, hint and technical details unless overridden. */
  error?: unknown;
  detail?: ReactNode;
  hint?: ReactNode;
  onRetry?: () => void;
  compact?: boolean;
  className?: string;
}) {
  const described = error == null ? undefined : describeError(error);
  const shownMessage = message ?? described?.message;
  const shownHint = hint ?? described?.hint;
  const messageText = typeof shownMessage === "string" ? simpleErrorText(shownMessage) : null;
  const hintText = typeof shownHint === "string" ? simpleErrorText(shownHint) : null;
  const technical = described?.details ?? detail;
  return (
    <div
      role="alert"
      className={cn(
        "burrow-enter mx-auto flex w-full min-w-0 max-w-lg text-center",
        compact ? "flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1 px-3 py-2" : "flex-col items-center gap-2 px-6 py-12",
        className,
      )}
    >
      <div
        className={cn(
          "mb-1 grid size-10 place-items-center rounded-full bg-[color-mix(in_oklch,var(--fail)_14%,transparent)] text-fail",
          compact && "mb-0 size-7",
        )}
      >
        <TriangleAlert className={cn("size-5", compact && "size-4")} aria-hidden="true" />
      </div>
      <div className={cn(compact ? "min-w-0 flex-1 basis-48 text-left" : "contents")}>
        <h2 className={compact ? "text-small font-medium" : "text-lead"}>{title}</h2>
        {shownMessage != null && (
          <p
            className={cn(
              "min-w-0 max-w-full wrap-anywhere",
              compact ? "line-clamp-2 text-caption text-ink-2" : "line-clamp-3 text-body text-ink-2",
            )}
          >
            {messageText ?? shownMessage}
          </p>
        )}
        {shownHint != null && (
          <p className={cn("min-w-0 max-w-full wrap-anywhere line-clamp-2", compact ? "text-micro text-ink-3" : "text-small text-ink-3")}>
            {hintText ?? shownHint}
          </p>
        )}
      </div>
      {technical != null && technical !== "" && <TechnicalDetails detail={technical} />}
      {onRetry && (
        <Button size={compact ? "sm" : "md"} className={compact ? "mt-0" : "mt-2"} onClick={onRetry}>
          Retry now
        </Button>
      )}
    </div>
  );
}

/**
 * The one technical-details disclosure. The content mounts only while open, so collapsed errors can never duplicate
 * the message in the DOM. Expansion and collapse animate one grid row (0fr ↔ 1fr) on the authored `--dur-base`
 * entrance and fade the content with `--dur-fade`; the payload stays mounted until the collapse finishes, then is
 * removed. Reduced motion snaps both steps, and parity drops the animation entirely.
 *
 * The payload spans the panel instead of sharing a row with Copy, wraps at whitespace (`wrap-anywhere` only breaks a
 * token that has no break), and scrolls inside a capped well, so a large envelope never pushes the page. The error
 * message itself is line-clamped by `ErrorState`; its full text is here.
 */
export function TechnicalDetails({ detail, className }: { detail: ReactNode; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  useEffect(() => {
    if (!open) {
      setExpanded(false);
      return;
    }
    const frame = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const toggle = () => {
    if (open) {
      setOpen(false);
      setExpanded(false);
      setClosing(true);
      const duration = motionAllowed() ? tokenMs(detailsRef.current, "--dur-base", 240) : 0;
      if (duration <= 0) {
        setClosing(false);
        return;
      }
      cancelClose();
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setClosing(false);
      }, duration);
      return;
    }
    // Reopening mid-collapse retargets the same row instead of remounting it.
    cancelClose();
    setClosing(false);
    setOpen(true);
  };

  // The summary is the disclosure control: intercept its click with a native listener (not React's delegated onClick,
  // which some render contexts do not receive), prevent the browser toggle, and drive the state machine ourselves.
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });
  useEffect(() => {
    const summary = summaryRef.current!;
    const onSummaryClick = (event: MouseEvent) => {
      event.preventDefault();
      toggleRef.current();
    };
    summary.addEventListener("click", onSummaryClick);
    return () => summary.removeEventListener("click", onSummaryClick);
  }, []);

  return (
    <details
      ref={detailsRef}
      open={open || closing}
      className={cn("mt-1 w-full min-w-0 max-w-full rounded-md bg-well px-2 py-1.5 text-left text-micro text-ink-3", className)}
    >
      <summary ref={summaryRef} className="min-h-6 cursor-pointer py-1 font-medium text-ink-2">
        Technical details
      </summary>
      {(open || closing) && (
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-(--dur-base) ease-out",
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className={cn("mt-1 min-w-0 transition-opacity duration-(--dur-fade) ease-out", expanded ? "opacity-100" : "opacity-0")}>
              <div className="mb-1 flex justify-end">
                <Button
                  variant="quiet"
                  size="sm"
                  className="min-w-26 shrink-0 justify-center"
                  aria-label="Copy technical details"
                  onClick={() => {
                    void copyText(textRef.current!.textContent!).then((ok) => setState(ok ? "copied" : "failed"));
                  }}
                >
                  {state === "copied" ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
                  {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
                </Button>
              </div>
              <pre ref={textRef} className="burrow-scroll max-h-72 min-w-0 overflow-auto whitespace-pre-wrap wrap-anywhere text-ink-2">
                {detail}
              </pre>
            </div>
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Technical details copied" : state === "failed" ? "Could not copy technical details" : ""}
      </span>
    </details>
  );
}

/** Compact warning for a failed refresh when the last successful response remains usable. */
export function StaleErrorBanner({
  title,
  message,
  error,
  onRetry,
}: {
  title: string;
  /** Human summary; the raw error stays in Technical details. */
  message?: ReactNode;
  error: unknown;
  onRetry?: () => void;
}) {
  return <ErrorState compact title={title} message={message} error={error} onRetry={onRetry} />;
}
