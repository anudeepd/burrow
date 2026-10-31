/**
 * Main-thread layout client: worker transport, hash-keyed cache, in-flight de-duplication, bounded synchronous fallback.
 *
 * Why the cache is keyed by `graph.hash`: metrics stream in every second while the structure does not change. Hashing
 * the *structure* means a progress tick costs zero layout work, which is what keeps the 300-node case at 60 fps.
 */
import type { LayoutRequest, LayoutResponse, LayoutResult, LayoutWire, RenderGraph } from "../types";
import { decodeWire, layoutRequest } from "./wire";

/**
 * The ELK API is loaded on demand. The layout worker fetches the algorithm asset on first use. A browser fallback
 * loads this module dynamically and uses the same asset; tests/SSR use the package's inline worker export.
 */
async function engine(): Promise<typeof import("./elk")> {
  return await import("./elk");
}

/** Layout cache size. A 300-node graph is ~40 KB of geometry; 24 entries stay well under a megabyte. */
const CACHE_LIMIT = 24;

export interface LayoutStats {
  hits: number;
  misses: number;
  coalesced: number;
  fallbacks: number;
  requests: number;
  lastDurationMs: number;
  lastRan: "worker" | "main";
  /** layout ladder rung of the last result (0 = primary options) */
  lastRung: number;
  workerReady: boolean;
}

const emptyStats: LayoutStats = {
  hits: 0,
  misses: 0,
  coalesced: 0,
  fallbacks: 0,
  requests: 0,
  lastDurationMs: 0,
  lastRan: "main",
  lastRung: 0,
  workerReady: false,
};

/** Insertion-ordered map used as an LRU: re-inserting on hit keeps the most recent layouts. */
function lruGet(cache: Map<string, LayoutResult>, key: string): LayoutResult | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function lruSet(cache: Map<string, LayoutResult>, key: string, value: LayoutResult): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

interface Pending {
  resolve: (r: LayoutResult) => void;
  reject: (e: unknown) => void;
}

/**
 * One worker for the whole app. The browser worker is optional: unit tests, SSR and (rare) environments without Worker
 * fall back to a synchronous main-thread layout that produces byte-identical geometry, just on the wrong thread.
 */
export class LayoutClient {
  private readonly cache = new Map<string, LayoutResult>();
  private readonly inflight = new Map<string, Promise<LayoutResult>>();
  private readonly pending = new Map<number, Pending>();
  private worker: Worker | null = null;
  private nextId = 1;
  private stats: LayoutStats = { ...emptyStats };

  private allowWorker: boolean;

  constructor(allowWorker: boolean = typeof Worker !== "undefined") {
    this.allowWorker = allowWorker;
  }

  /** Lazily start the worker; a failure to construct it is permanent and remembered as "no worker". */
  private ensureWorker(): Worker | null {
    if (!this.allowWorker) return null;
    if (this.worker) return this.worker;
    try {
      // The classic worker can load ELK's standalone script asset without bundling it into this worker.
      const w = new Worker(new URL("./worker.ts", import.meta.url));
      w.addEventListener("message", (ev: MessageEvent<unknown>) => this.onMessage(ev.data));
      w.addEventListener("error", (ev) => {
        // A worker-level error kills every in-flight request; resolve them through the fallback path.
        const error = new Error(`dag layout worker error: ${ev.message || "unknown"}`);
        for (const [, p] of this.pending) p.reject(error);
        this.pending.clear();
        this.worker = null;
        this.stats.workerReady = false;
      });
      this.worker = w;
      this.stats.workerReady = true;
      return w;
    } catch {
      this.allowWorker = false;
      return null;
    }
  }

  private onMessage(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const res = data as LayoutResponse;
    const p = this.pending.get(res.requestId);
    if (!p) return;
    this.pending.delete(res.requestId);
    if (res.ok) {
      this.stats.lastRan = "worker";
      this.stats.lastDurationMs = res.wire.durationMs;
      this.stats.lastRung = res.wire.rung;
      p.resolve(decodeWire(res.wire, "worker"));
    } else {
      p.reject(new Error(res.error));
    }
  }

  private async runInWorker(req: LayoutRequest): Promise<LayoutResult> {
    const w = this.ensureWorker();
    if (!w) throw new Error("no worker");
    return await new Promise<LayoutResult>((resolve, reject) => {
      this.pending.set(req.requestId, { resolve, reject });
      w.postMessage(req);
    });
  }

  /** Layout on the main thread (fallback + tests). Kept public so a caller can force it for reproducible geometry. */
  async layoutSync(graph: RenderGraph): Promise<LayoutResult> {
    const cached = lruGet(this.cache, graph.hash);
    if (cached) {
      this.stats.hits += 1;
      return cached;
    }
    const wire = await (await engine()).runLayout(layoutRequest(graph, 0));
    const result = decodeWire(wire, "main");
    this.stats.lastRan = "main";
    this.stats.lastDurationMs = wire.durationMs;
    this.stats.lastRung = wire.rung;
    lruSet(this.cache, graph.hash, result);
    return result;
  }

  /** Cached/worker layout. Small graphs retry synchronously; a large graph reports worker failure instead of blocking the page. */
  async layout(graph: RenderGraph): Promise<LayoutResult> {
    const cached = lruGet(this.cache, graph.hash);
    if (cached) {
      this.stats.hits += 1;
      return cached;
    }
    const inFlight = this.inflight.get(graph.hash);
    if (inFlight) {
      this.stats.coalesced += 1;
      return inFlight;
    }
    this.stats.requests += 1;
    const promise = (async (): Promise<LayoutResult> => {
      try {
        const result = await this.runInWorker(layoutRequest(graph, this.nextId++));
        lruSet(this.cache, graph.hash, result);
        return result;
      } catch {
        if (graph.large) {
          throw new Error("DAG layout worker failed; refusing main-thread ELK for a large DAG");
        }
        this.stats.fallbacks += 1;
        const wire = await (await engine()).runLayout(layoutRequest(graph, 0));
        const result = decodeWire(wire, "main");
        lruSet(this.cache, graph.hash, result);
        return result;
      } finally {
        this.inflight.delete(graph.hash);
      }
    })();
    this.inflight.set(graph.hash, promise);
    this.stats.misses += 1;
    return promise;
  }

  /** Test seam: the wire payload for a graph without going through the worker. */
  async layoutWire(graph: RenderGraph): Promise<LayoutWire> {
    return await (await engine()).runLayout(layoutRequest(graph, 0));
  }

  getStats(): LayoutStats {
    return { ...this.stats };
  }

  /** True while a Worker is available and healthy. */
  get workerReady(): boolean {
    return this.worker !== null;
  }

  resetStats(): void {
    this.stats = { ...emptyStats, workerReady: this.worker !== null };
  }

  clearCache(): void {
    this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.size;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.stats.workerReady = false;
    for (const [, p] of this.pending) p.reject(new Error("layout client disposed"));
    this.pending.clear();
    this.inflight.clear();
    this.cache.clear();
  }
}

let shared: LayoutClient | null = null;

export function layoutClient(): LayoutClient {
  if (!shared) shared = new LayoutClient();
  return shared;
}

/** Layout a render graph on the shared client (worker when available, cached by structure hash). */
export function layoutDag(graph: RenderGraph): Promise<LayoutResult> {
  return layoutClient().layout(graph);
}

/** Deterministic, worker-free layout — tests and SSR. */
export function layoutDagSync(graph: RenderGraph): Promise<LayoutResult> {
  return new LayoutClient(false).layoutSync(graph);
}
