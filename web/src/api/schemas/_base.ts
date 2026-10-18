/**
 * Schema helpers shared by every entity file.
 *
 * Modes
 * - loose (default, production): unknown keys are preserved, so a newer Hadoop that adds a field never breaks the UI.
 * - strict (test mode): unknown keys are an error. Enabled by `globalThis.__BURROW_STRICT_SCHEMAS__ = true` *before the
 *   schema modules are imported* (Playwright `addInitScript`, vitest setup) or `VITE_BURROW_STRICT_SCHEMAS=1` at build time.
 *   The parity harness (P1) relies on this: "unknown new keys fail the build".
 */
import { z } from "zod";

export const STRICT_SCHEMAS: boolean =
  (globalThis as { __BURROW_STRICT_SCHEMAS__?: boolean }).__BURROW_STRICT_SCHEMAS__ === true ||
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_BURROW_STRICT_SCHEMAS === "1");

/** Object schema honouring the loose/strict mode. Use for every REST object. */
export function obj<T extends z.core.$ZodLooseShape>(shape: T) {
  return STRICT_SCHEMAS ? z.strictObject(shape) : z.looseObject(shape);
}

/**
 * Hadoop's Jersey/JSON marshalling quirks, in one place:
 * - empty collection => `null`/absent instead of `[]` (e.g. `{"apps":null}`);
 * - a single-element array may be emitted as a bare object (`{"app":{...}}`), a known JAXB-JSON behaviour.
 * `listOf` accepts all three and always yields an array.
 */
export function listOf<S extends z.ZodType>(item: S) {
  return z
    .union([z.array(item), item, z.null(), z.undefined()])
    .transform((v): z.output<S>[] => (v == null ? [] : Array.isArray(v) ? v : [v]))
    .default([]);
}

/** Number that REST may deliver as number or numeric string (some DAOs stringify). */
export const num = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
]);
