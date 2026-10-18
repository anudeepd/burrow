/**
 * Global test setup (vitest).
 *
 * Strict schemas are ON for tests (docs/contracts/api.md §1, PLAN §8 P1): a fixture or mock response with a key the
 * schema does not list throws instead of being silently preserved.
 */
globalThis.__BURROW_STRICT_SCHEMAS__ = true;

// DOM gaps that app code touches. Kept minimal: only APIs a component actually calls during a unit test.
if (typeof globalThis.IntersectionObserver === "undefined") {
  class NoopIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: readonly number[] = [];
    disconnect(): void {}
    observe(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    unobserve(): void {}
  }
  globalThis.IntersectionObserver = NoopIntersectionObserver as unknown as typeof IntersectionObserver;
}

if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver implements ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
}

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// The DOM emulator has no meaningful page-scroll model; keep calls deterministic.
if (typeof window !== "undefined") {
  window.scrollTo = () => {};
}
