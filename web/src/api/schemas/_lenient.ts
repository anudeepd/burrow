/**
 * Extra Hadoop wire-format quirks on top of `_base.ts` (kept separate: `_base.ts` is owned by WebFoundation).
 *
 * The RM serialises through Jersey 1.x + JAXB. Classes registered in `JAXBContextResolver.cTypes` use "natural" JSON
 * (real numbers/booleans, root element kept); classes that are NOT registered (containers, node labels, label mappings,
 * scheduler-conf, app state/queue/priority…) fall back to Jersey's default "mapped" notation (numbers/booleans may be
 * quoted strings, root element possibly unwrapped, `Map` => `{entry:[{key,value}]}`).
 */
import { z } from "zod";
import { listOf, num, obj } from "./_base";

/** Boolean that mapped notation may deliver as `"true"`/`"false"`. */
export const boolish = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);

/** Float that may be a number, a numeric string, or one of Java's non-finite spellings (`"NaN"` on a FIFO queue). */
export const floatish = z.union([num, z.enum(["NaN", "Infinity", "-Infinity"]).transform(Number)]);

/**
 * Java `Map<String, V>` as Hadoop emits it. Accepted wire shapes (all normalised to a plain record):
 * `[{key,value}]` · `{entry:[{key,value}]}` / `{entry:{key,value}}` · `{k: v}` · `{}`/null/absent.
 */
export function entryMap<V extends z.ZodType>(value: V) {
  const entry = obj({ key: z.string(), value });
  type Out = Record<string, z.output<V>>;
  const fromEntries = (es: unknown): Out => {
    const out: Out = {};
    for (const e of es as { key: string; value: z.output<V> }[]) out[e.key] = e.value;
    return out;
  };
  return z.union([
    z.array(entry).transform(fromEntries),
    // `entry` is REQUIRED here so that a plain record (or `{}`) falls through to the next branch in loose mode.
    obj({ entry: z.union([z.array(entry), entry]) }).transform((w): Out => fromEntries(Array.isArray(w.entry) ? w.entry : [w.entry])),
    z.record(z.string(), value),
    z.null().transform((): Out => ({})),
  ]);
}

/**
 * `listOf` as an object-field schema: key may be absent (Hadoop omits empty collections), output is always an array.
 * (`listOf` alone makes zod treat the key as required because its output is non-optional.)
 */
export function list<S extends z.ZodType>(item: S) {
  return listOf(item).default([]);
}
