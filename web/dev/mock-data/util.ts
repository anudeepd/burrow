/** Seeded PRNG + small helpers shared by the mock data generators. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  /** inclusive integer range */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
}

export function seedOf(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
}

export const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** Java Long.MAX_VALUE as emitted by Hadoop (JS rounds it, which is what any JS client sees anyway). */
// biome-ignore lint/correctness/noPrecisionLoss: Hadoop emits Java Long.MAX_VALUE verbatim; every JS client rounds it identically
export const LONG_MAX = 9223372036854775807;

export interface Bounds {
  minMb: number;
  maxMb: number;
  minVc: number;
  maxVc: number;
}

export const CLUSTER_BOUNDS: Bounds = { minMb: 1024, maxMb: 16384, minVc: 1, maxVc: 8 };

/** `ResourceInformationsInfo` JSON. */
export function resourceInformations(mb: number, vc: number, b?: Bounds) {
  return {
    resourceInformation: [
      {
        attributes: {},
        maximumAllocation: b ? b.maxMb : LONG_MAX,
        minimumAllocation: b ? b.minMb : 0,
        name: "memory-mb",
        resourceType: "COUNTABLE",
        units: "Mi",
        value: mb,
      },
      {
        attributes: {},
        maximumAllocation: b ? b.maxVc : LONG_MAX,
        minimumAllocation: b ? b.minVc : 0,
        name: "vcores",
        resourceType: "COUNTABLE",
        units: "",
        value: vc,
      },
    ],
  };
}

/** `ResourceInfo` JSON (`memory`, `vCores`, `resourceInformations`). */
export function resourceInfo(mb: number, vc: number, b?: Bounds) {
  return { memory: mb, vCores: vc, resourceInformations: resourceInformations(mb, vc, b) };
}

/** Jersey "natural" JSON of a `Map<String, Long>` field (`entry` list, stringified values). */
export function longMap(entries: Record<string, number>) {
  return { entry: Object.entries(entries).map(([key, value]) => ({ key, value: String(Math.round(value)) })) };
}

/** Same JSON as Hadoop's `Times.formatISO8601`. */
export function iso8601(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}+0000`;
}

export function round(n: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}
