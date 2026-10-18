/**
 * Small shared primitives for the app-detail surfaces: the legacy InfoBlock key/value row, an honest "not exposed"
 * badge, and a copy-to-clipboard control for the diagnostics blobs.
 */
import { Check, Copy } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Fmt } from "~/lib/format";
import { cn } from "~/lib/cn";
import { copyText } from "~/lib/copy";
import { Button } from "~/ui/button";
import { Datum } from "~/ui/datum";
import { HelpTip, Tooltip } from "~/ui/tooltip";

/**
 * The legacy InfoBlock row layout without stamping a datum — for rows whose value element carries the parity
 * attributes itself (e.g. a `<pre>` diagnostics block, so `data-yv`'s textContent is the raw value and nothing else).
 *
 * One row = label + value. Stacked below `sm`: at phone widths a fixed label column leaves the value ~160px, and
 * content that cannot shrink (a row of buttons, a long single-word label) then pushes the whole page sideways. From
 * `sm` up the legacy two-column layout returns; `lg` widens the label column as before.
 */
const ROW =
  "grid grid-cols-1 items-baseline gap-x-4 gap-y-0.5 py-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-y-1 lg:grid-cols-[minmax(9rem,15rem)_minmax(0,1fr)]";
/** `min-w-0` lets a long label shrink instead of pushing its column wider; the icon wraps with it. */
const ROW_LABEL = "flex min-w-0 items-center gap-1 text-small text-ink-3";

export function FieldShell({
  label,
  hint,
  className,
  valueClassName,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  valueClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(ROW, className)}>
      <dt className={ROW_LABEL}>
        <span className="min-w-0">{label}</span>
        {hint && <HelpTip label={typeof label === "string" ? label.replace(/:$/, "") : "Field details"}>{hint}</HelpTip>}
      </dt>
      <dd className={cn("min-w-0 text-body break-words", valueClassName)}>{children}</dd>
    </div>
  );
}

/**
 * One legacy InfoBlock row: `label:` on the left, the datum on the right. Every field of an entity goes through
 * `<Field>`/`<Datum>` exactly once so the parity harness can reconstruct legacy label -> raw value.
 */
export function Field({
  label,
  field,
  raw,
  fmt = "text",
  children,
  hint,
  className,
  valueClassName,
}: {
  label: ReactNode;
  field: string;
  raw: unknown;
  fmt?: Fmt;
  /** visible content; defaults to the formatted raw value */
  children?: ReactNode;
  /** supplementary explanation shown next to the label */
  hint?: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <FieldShell label={label} hint={hint} className={className} valueClassName={valueClassName}>
      <Datum field={field} raw={raw} fmt={fmt}>
        {children}
      </Datum>
    </FieldShell>
  );
}

/** A row whose value the RM REST API does not expose: the legacy label stays, the value is explicitly absent. */
export function UnavailableField({
  label,
  field,
  reason,
  className,
}: {
  label: ReactNode;
  field: string;
  reason: string;
  className?: string;
}) {
  return (
    <Field label={label} field={field} raw={null} className={className} hint={reason}>
      <span className="inline-flex items-center gap-1.5 text-small text-ink-3" data-burrow="not-exposed">
        <span className="rounded-sm border border-dashed border-seam-strong px-1 text-micro tracking-wide uppercase">not exposed</span>
        <span className="text-ink-4">RM REST has no such field</span>
      </span>
    </Field>
  );
}

/**
 * One legacy `Resource` value (memory + vCores) split into its two REST fields.
 *
 * The legacy page prints `<memory:0, vCores:0>` from a `Resource.toString()`; REST delivers the two components as
 * separate keys, so each carries its own `data-yf`/`data-yv` and the exact legacy rendering is exposed as a tooltip.
 * Splitting is deliberate: it keeps `(entity, field) -> raw` unambiguous. (Intentionally-merged label: the legacy row
 * "Total Resource Preempted:" covers `app.preemptedResourceMB` + `app.preemptedResourceVCores`.)
 */
export function ResourcePair({
  memoryMB,
  vcores,
  memoryField,
  vcoresField,
  label,
  hint,
  className,
}: {
  memoryMB: number | null | undefined;
  vcores: number | null | undefined;
  memoryField: string;
  vcoresField: string;
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  const legacy = `<memory:${memoryMB ?? 0}, vCores:${vcores ?? 0}>`;
  return (
    <div className={cn(ROW, className)}>
      <dt className={ROW_LABEL}>
        <span className="min-w-0">{label}</span>
        <HelpTip label={typeof label === "string" ? label.replace(/:$/, "") : "Resource details"}>
          {hint ?? `Memory and virtual CPU cores reported by YARN: ${legacy}`}
        </HelpTip>
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-body">
        <Datum field={memoryField} raw={memoryMB} fmt="mb" className="tabular-nums" />
        <span aria-hidden="true" className="text-ink-4">
          ·
        </span>
        <Datum field={vcoresField} raw={vcores} fmt="int" className="tabular-nums" />
      </dd>
    </div>
  );
}

/** Copy-to-clipboard with a 1.2s "Copied" acknowledgement; degrades to select-only when the clipboard API is blocked. */
export function CopyButton({
  text,
  label = "Copy",
  className,
  iconOnly = false,
}: {
  text: string;
  label?: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  // the acknowledgement reverts after a beat; the timer dies with the component (it used to fire on an unmounted one)
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const onCopy = useCallback(() => {
    void copyText(text)
      .then((didCopy) => {
        setCopied(didCopy);
        if (!didCopy) return;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => setCopied(false));
  }, [text]);
  if (iconOnly) {
    const subject = label.replace(/^Copy\s+/i, "");
    return (
      <Tooltip label={copied ? `${subject} copied` : label}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onCopy}
          className={cn("size-6 rounded-md text-ink-4 hover:text-live", className)}
          aria-label={copied ? `${subject} copied` : `${label} to clipboard`}
        >
          {copied ? <Check className="size-3.5 text-ok" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        </Button>
      </Tooltip>
    );
  }
  return (
    <Button variant="quiet" size="sm" onClick={onCopy} className={className} aria-label={`${label} to clipboard`}>
      {copied ? <Check className="size-3.5 text-ok" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/** Section shell used by the tab bodies: a titled card that keeps the legacy heading text visible. */
export function Section({
  title,
  children,
  actions,
  className,
  id,
  variant = "card",
}: {
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  id?: string;
  variant?: "card" | "plain";
}) {
  if (variant === "plain") {
    return (
      <section id={id} className={cn("flex min-w-0 flex-col gap-2", className)}>
        <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
          <h2 className="min-w-0 break-words text-h3">{title}</h2>
          {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
        {children}
      </section>
    );
  }
  return (
    <section id={id} className={cn("rounded-lg border border-seam bg-fabric", className)}>
      <header className="flex min-w-0 min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-seam-soft px-3 py-1.5">
        <h2 className="min-w-0 flex-1 break-words text-small font-semibold tracking-wide text-ink-2 uppercase">{title}</h2>
        {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">{actions}</div>}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}
