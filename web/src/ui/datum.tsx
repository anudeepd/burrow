/**
 * Parity DOM primitives (docs/contracts/parity-dom.md). NON-NEGOTIABLE: every YARN/Spark datum goes through `Datum`
 * (or spreads `datumAttrs`) and sits inside an `Entity`.
 *
 *   <Entity id="application_1_1" as="tr">           -> data-ye="application_1_1"
 *     <Datum field="app.state" raw={app.state} />    -> data-yf="app.state" data-yv="RUNNING"
 *   </Entity>
 *
 * data-yv is ALWAYS the raw upstream value stringified as JSON would: never formatted, never tweened.
 * null/undefined -> data-yv="" + data-yn="1".
 */
import { type ElementType, type HTMLAttributes, type ReactNode, type Ref, createContext, useContext } from "react";
import { type Fmt, formatByTag, rawString } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { Tooltip } from "./tooltip";

const EntityCtx = createContext<string | null>(null);

export interface DatumAttrs {
  "data-yf": string;
  "data-yv": string;
  "data-yn"?: "1";
  "data-yfmt"?: Fmt;
}

export function datumAttrs(field: string, raw: unknown, fmt?: Fmt): DatumAttrs {
  const attrs: DatumAttrs = { "data-yf": field, "data-yv": rawString(raw) };
  if (raw == null) attrs["data-yn"] = "1";
  if (fmt) attrs["data-yfmt"] = fmt;
  return attrs;
}

export function Entity<T extends ElementType = "div">({
  id,
  domId,
  as,
  children,
  ...rest
}: { id: string; domId?: string; as?: T; children?: ReactNode } & Omit<HTMLAttributes<HTMLElement>, "id">) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <EntityCtx.Provider value={id}>
      <Tag data-ye={id} id={domId} {...rest}>
        {children}
      </Tag>
    </EntityCtx.Provider>
  );
}

/** Singleton entities (cluster.info, cluster.metrics) use key "_" per the contract. */
export const SINGLETON = "_";

export interface DatumProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  field: string;
  raw: unknown;
  fmt?: Fmt;
  as?: ElementType;
  /** Visible content. Defaults to the formatted raw value. */
  children?: ReactNode;
  /**
   * Carry only the parity attributes, with no text of its own (`data-yv` still holds the raw value).
   * Required for a *nested* datum inside a composite: the outer datum already renders the legacy text
   * (`<memory:2304, vCores:3>`, `host:rpcPort`), so a nested datum that also prints its value would make the
   * composite's textContent read `<memory:2304, vCores:3>2304 3` — which is exactly the duplication the
   * differential gate caught against the stock UI.
   */
  bare?: boolean;
  /** the element the datum renders into (used by callers that need to observe it, e.g. a visibility-gated loop) */
  ref?: Ref<HTMLElement>;
}

export function Datum({ field, raw, fmt, as, children, bare, ref, title, ...rest }: DatumProps) {
  const Tag = (as ?? "span") as ElementType;
  const tz = usePref("tz");
  const entity = useContext(EntityCtx);
  if (import.meta.env.DEV && entity === null && typeof console !== "undefined") {
    // Rule 4 of the contract: a Datum outside an Entity is ambiguous for the harness.
    console.warn(`[parity] <Datum field="${field}"> rendered outside <Entity>`);
  }
  const value = (
    <Tag ref={ref} {...rest} {...datumAttrs(field, raw, fmt)}>
      {bare ? null : (children ?? formatByTag(fmt ?? "text", raw, tz))}
    </Tag>
  );
  return title && !bare ? <Tooltip label={title}>{value}</Tooltip> : value;
}
