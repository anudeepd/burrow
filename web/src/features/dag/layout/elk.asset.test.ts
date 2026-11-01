// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { getElk, loadInlineWorkerAsset } from "./elk";

const globals = ["document", "module", "exports", "importScripts", "location"] as const;
type GlobalName = (typeof globals)[number];
const descriptors = new Map<GlobalName, PropertyDescriptor | undefined>();

afterEach(() => {
  for (const name of globals) {
    const descriptor = descriptors.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  descriptors.clear();
});

function saveGlobals() {
  descriptors.clear();
  for (const name of globals) descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
}

function setGlobal(name: GlobalName, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, writable: true, value });
}

function exposedWorker(): new () => object {
  return class InlineWorker {
    onmessage: ((event: { data: { id: number } }) => void) | null = null;

    postMessage(message: { id: number }) {
      this.onmessage?.({ data: { id: message.id } });
    }
  };
}

describe("ELK browser asset worker bootstrap", () => {
  it("selects the browser asset loader and clears a rejected engine promise", async () => {
    saveGlobals();
    vi.stubEnv("MODE", "production");
    vi.stubEnv("SSR", false);
    let exposeWorker = false;
    setGlobal("location", { origin: "https://burrow.test" });
    setGlobal("document", undefined);
    setGlobal("importScripts", () => {
      if (!exposeWorker) return;
      const commonJs = (globalThis as unknown as { module: { exports: { Worker?: new () => object } } }).module;
      commonJs.exports.Worker = exposedWorker();
    });

    await expect(getElk()).rejects.toThrow("did not expose its inline Worker");
    await new Promise((resolve) => setTimeout(resolve, 0));
    exposeWorker = true;
    await expect(getElk()).resolves.toBeTruthy();
  });

  it("loads the classic worker asset through importScripts and restores pre-existing globals", async () => {
    saveGlobals();
    const oldModule = { exports: { previousModule: true } };
    const oldExports = { previousExports: true };
    const Worker = exposedWorker();
    setGlobal("document", undefined);
    setGlobal("location", { origin: "https://burrow.test" });
    setGlobal("module", oldModule);
    setGlobal("exports", oldExports);
    setGlobal("importScripts", (url: string) => {
      expect(url).toMatch(/^https:\/\/burrow\.test\//);
      const commonJs = (globalThis as unknown as { module: { exports: { Worker?: new () => object } } }).module;
      commonJs.exports.Worker = Worker;
    });

    await expect(loadInlineWorkerAsset()).resolves.toBe(Worker);
    expect((globalThis as unknown as { module: unknown }).module).toBe(oldModule);
    expect((globalThis as unknown as { exports: unknown }).exports).toBe(oldExports);
    expect((globalThis as unknown as { document: unknown }).document).toBeUndefined();
  });

  it("loads through a script element and removes the temporary script", async () => {
    saveGlobals();
    const Worker = exposedWorker();
    const script = { src: "", onload: null as (() => void) | null, onerror: null as (() => void) | null, remove: vi.fn() };
    setGlobal("location", { origin: "https://burrow.test" });
    setGlobal("document", {
      createElement: () => script,
      head: {
        append: (element: typeof script) => {
          const commonJs = (globalThis as unknown as { module: { exports: { Worker?: new () => object } } }).module;
          commonJs.exports.Worker = Worker;
          element.onload?.();
        },
      },
    });

    await expect(loadInlineWorkerAsset()).resolves.toBe(Worker);
    expect(script.src).toMatch(/^https:\/\/burrow\.test\//);
    expect(script.remove).toHaveBeenCalledOnce();
  });

  it("reports script-load errors and rejects assets that expose no Worker", async () => {
    saveGlobals();
    const script = { src: "", onload: null as (() => void) | null, onerror: null as (() => void) | null, remove: vi.fn() };
    setGlobal("location", { origin: "https://burrow.test" });
    setGlobal("document", {
      createElement: () => script,
      head: { append: (element: typeof script) => element.onerror?.() },
    });
    await expect(loadInlineWorkerAsset()).rejects.toThrow("Failed to load ELK worker asset");
    expect(script.remove).toHaveBeenCalledOnce();

    setGlobal("document", undefined);
    setGlobal("importScripts", () => undefined);
    await expect(loadInlineWorkerAsset()).rejects.toThrow("did not expose its inline Worker");
  });

  it("reports when neither a script loader nor importScripts is available", async () => {
    saveGlobals();
    setGlobal("location", { origin: "https://burrow.test" });
    setGlobal("document", undefined);
    await expect(loadInlineWorkerAsset()).rejects.toThrow("No script loader is available");
  });
});
