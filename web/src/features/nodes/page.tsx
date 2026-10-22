/**
 * Shared chrome for the "ops" sections of Burrow (Nodes, Node labels and the four daemon Tools pages).
 * Kept with the nodes feature because both sections live in the FE-NodesTools slice; tools pages import from here.
 *
 * Rules it encodes:
 *  - every datum goes through `<Datum>` so `?parity=1` can read it (docs/contracts/parity-dom.md);
 *  - a value the backend cannot provide yet renders `Unavailable` (explicit reason + next step), never a fake number.
 */
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Check, Copy, Search, TriangleAlert, X } from "lucide-react";
import { type KeyboardEventHandler, type ReactNode, useEffect, useId, useState } from "react";
import { cn } from "~/lib/cn";
import { copyText } from "~/lib/copy";
import type { Fmt } from "~/lib/format";
import { Button } from "~/ui/button";
import { Datum } from "~/ui/datum";
import { HelpTip, Tooltip } from "~/ui/tooltip";

export function PageHead({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-2">
      <div className="min-w-0">
        <h1 className="text-h1 font-semibold text-ink text-balance">{title}</h1>
        {description && <div className="mt-1 max-w-3xl text-body break-words text-ink-3">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({
  title,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("flex min-h-0 flex-col gap-2", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2">
          {typeof title === "string" ? <h2 className="text-lead font-medium text-ink-2">{title}</h2> : title}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** One labelled datum. `field` + `raw` stamp parity attrs on the value element; the label is decorative. */
export function Field({
  label,
  field,
  raw,
  fmt,
  hint,
  mono,
  children,
  className,
}: {
  label: ReactNode;
  field?: string;
  raw?: unknown;
  fmt?: Fmt;
  hint?: ReactNode;
  mono?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <dt className="flex items-center gap-1 text-caption uppercase tracking-wide text-ink-3">
        {label}
        {hint && <HelpTip label={typeof label === "string" ? label : "Field details"}>{hint}</HelpTip>}
      </dt>
      <dd className={cn("min-w-0 break-words text-body text-ink", mono && "font-mono text-small")}>
        {field !== undefined ? (
          <Datum field={field} raw={raw} fmt={fmt}>
            {children}
          </Datum>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}

export function KvGrid({ children, columns = 3, className }: { children: ReactNode; columns?: 2 | 3 | 4; className?: string }) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-3 rounded-lg border border-seam bg-fabric p-3",
        columns === 2 ? "sm:grid-cols-2" : columns === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/** A compact headline number. Not a `<Datum>`: the caller passes the field/raw through `Field` when the value is a YARN datum. */
export function Stat({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "ok" | "warn" | "fail" | "live" | "idle";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-seam bg-fabric px-3 py-2", className)}>
      <div className="text-caption uppercase tracking-wide text-ink-3">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-h3 font-semibold tnum text-ink",
          tone === "ok" && "text-ok",
          tone === "warn" && "text-warn",
          tone === "fail" && "text-fail",
          tone === "live" && "text-live",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-micro text-ink-3">{sub}</div>}
    </div>
  );
}

/**
 * "This source cannot be read yet" — the honest alternative to inventing values. States what is missing, why, and what to do.
 * Used for endpoints the backend does not implement yet (e.g. `/api/rm/logs` before the log routes land).
 */
export function Unavailable({
  title,
  reason,
  hint,
  className,
}: {
  title: string;
  reason: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn("flex items-start gap-2.5 rounded-lg border border-dashed border-seam-strong bg-well px-3 py-3 text-body", className)}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium text-ink-2">{title}</p>
        <p className="mt-0.5 text-small text-ink-3">{reason}</p>
        {hint && <p className="mt-0.5 text-micro text-ink-4">{hint}</p>}
      </div>
    </div>
  );
}

/** Debounced search box (Pacer). Local state keeps typing snappy; `onChange` fires after `wait` ms of quiet. */
export function SearchField({
  value,
  onChange,
  onKeyDown,
  placeholder = "Search",
  label,
  wait = 180,
  resetSignal,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  placeholder?: string;
  label: string;
  wait?: number;
  resetSignal?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [debounced] = useDebouncedValue(draft, { wait });
  // keep the box in sync when the URL changes under us (back/forward, shared link)
  useEffect(() => setDraft(value), [value, resetSignal]);
  useEffect(() => {
    if (debounced !== value) onChange(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onChange identity is the caller's; fire only on debounced change
  }, [debounced]);
  return (
    <div className={cn("relative flex items-center", className)}>
      <Search className="pointer-events-none absolute left-2.5 size-3.5 text-ink-4" aria-hidden="true" />
      <input
        type="search"
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        className="h-(--ctl-h) w-full rounded-md border border-seam-strong bg-well pl-8 pr-8 text-body text-ink placeholder:text-ink-4 focus:border-ink-4 focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      {draft !== "" && (
        <Tooltip label="Clear search">
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setDraft("")}
            className="burrow-touch-target absolute right-2 grid size-5 place-items-center rounded-sm text-ink-4 hover:bg-fabric-3 hover:text-ink"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** Copy-to-clipboard with a short confirmation; falls back to a no-op when the clipboard is unavailable (non-secure origin). */
export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Button
      variant="quiet"
      size="icon-sm"
      aria-label={label}
      title={label}
      className={className}
      onClick={() => {
        void copyText(value).then(setDone, () => setDone(false));
      }}
    >
      {done ? <Check className="size-3.5 text-ok" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </Button>
  );
}

/** Accessible field wrapper for the ad-hoc filter controls (Select has its own `label`). */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  const auto = useId();
  const id = htmlFor ?? auto;
  return (
    <label htmlFor={id} className="text-micro uppercase tracking-wide text-ink-4">
      {children}
    </label>
  );
}

export { X as ClearIcon };
