/**
 * The bundled elkjs worker ships no type declarations (`elkjs/lib/elk-worker.d.ts` describes a different file and only
 * re-exports `Worker` as itself). We use it as an *inline* fake worker — it runs ELK's algorithms on the calling
 * thread, which is exactly what we want inside our own Web Worker — so one small structural declaration is enough.
 */
declare module "elkjs/lib/elk-worker.min.js" {
  export class Worker {
    constructor(url?: string);
    postMessage(message: unknown, transfer?: unknown[]): void;
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener(type: string, listener: (event: unknown) => void): void;
    terminate?: () => void;
  }
}
