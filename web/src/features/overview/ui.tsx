/**
 * Overview-local presentation pieces: section chrome, the metric card, cross-view links, and the explicit
 * "source unavailable" affordance. Kept in the feature (not `~/ui`) because they encode Overview-specific
 * information architecture; they use tokens and the shared primitives only.
 */
import { AlertCircle, ArrowUpRight, Info } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { useConnection } from "~/api/connection";
import { cn } from "~/lib/cn";
import { HelpTip, Tooltip } from "~/ui/tooltip";

/**
 * Client-side link to a view owned by another slice.
 *
 * Typed `<Link to="/apps">` cannot be used from here: the target route file does not exist yet, so the generated
 * `routeTree.gen.ts` does not contain it and the `to` union would fail typecheck in this slice. An anchor + the
 * router's own history keeps the navigation client-side and the href honest (middle-click, copy-link, no-JS all work).
 */
export function CrossLink({
  href,
  children,
  onClick,
  className,
  ...anchorProps
}: Omit<ComponentPropsWithRef<"a">, "href"> & { href: string }) {
  const router = useRouter();
  return (
    <a
      {...anchorProps}
      href={href}
      className={cn("burrow-touch-link", className)}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        void router.history.push(href, undefined, { ignoreBlocker: true });
      }}
    >
      {children}
    </a>
  );
}

/** A card surface. `as` lets a card be a link/article/li without changing the look. */
export function Panel({
  children,
  className,
  as: Tag = "div",
  ...rest
}: {
  children?: ReactNode;
  className?: string;
  as?: "div" | "article" | "li" | "section";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={cn("rounded-lg border border-seam bg-fabric p-[var(--gap-card)]", className)} {...rest}>
      {children}
    </Tag>
  );
}

export function Section({
  id,
  title,
  headingLevel = 2,
  hint,
  help,
  actions,
  children,
  className,
}: {
  id?: string;
  title: string;
  headingLevel?: 2 | 3;
  hint?: ReactNode;
  help?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cn(
        "flex flex-col gap-2.5",
        id && "scroll-mt-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
        className,
      )}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="flex items-center gap-1.5">
          <Heading className="text-h3">{title}</Heading>
          {help && <HelpTip label={title}>{help}</HelpTip>}
        </div>
        {hint && <p className="text-caption text-ink-3">{hint}</p>}
        {actions && <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/**
 * "We cannot show this, and here is why." Used wherever the contract cannot supply a datum yet — never a fake value,
 * never a silent blank. `variant="warn"` for genuinely missing data, `"info"` for ordinary "not applicable here".
 */
export function Unavailable({ reason, variant = "warn", className }: { reason: ReactNode; variant?: "warn" | "info"; className?: string }) {
  const Icon = variant === "warn" ? AlertCircle : Info;
  const classes = cn(
    "inline-flex max-w-full items-center gap-1 rounded-sm border border-dashed px-1.5 py-0.5 text-micro",
    variant === "warn" ? "border-warn/40 text-warn" : "border-seam-strong text-ink-3",
    className,
  );
  const content = (
    <>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{reason}</span>
    </>
  );
  if (typeof reason === "string") {
    return (
      <Tooltip label={reason}>
        <span className={classes}>{content}</span>
      </Tooltip>
    );
  }
  return <span className={classes}>{content}</span>;
}

/** A small "stale" marker: the value is real but the backend is serving cache because the upstream failed. */
export function StaleTag({ ageMs, className }: { ageMs: number | null; className?: string }) {
  return (
    <Tooltip label="The backend is serving a cached copy: the upstream did not answer the last refresh.">
      <span className={cn("inline-flex items-center gap-1 rounded-sm border border-wait/40 px-1.5 py-0.5 text-micro text-wait", className)}>
        <Info className="size-3" aria-hidden="true" />
        stale{ageMs != null && ageMs > 0 ? ` · ${Math.round(ageMs / 1000)}s` : ""}
      </span>
    </Tooltip>
  );
}

/** The outbound arrow used on click-through affordances. */
export function GoIcon() {
  return <ArrowUpRight className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />;
}

/** The backend tells us when it served stale cache because an upstream failed (`x-burrow-cache: stale`). */
export function useStale(): boolean {
  return useConnection((s) => s.lastCache === "stale");
}

/** Plain label/value pair for the identity strip (the legacy About block's `th/td` shape). */
export function Kv({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <dt className="text-micro tracking-wide text-ink-4 uppercase">{label}</dt>
      <dd className="m-0 min-w-0 text-body text-ink">{children}</dd>
    </div>
  );
}
