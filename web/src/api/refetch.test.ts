import { afterEach, describe, expect, it } from "vitest";
import { adaptive, configuredInterval, eventsStore, nextInterval } from "./refetch";
import { parityStore } from "~/state/parity";
import { prefsStore, setPrefs } from "~/state/prefs";

const initialPrefs = prefsStore.get();

afterEach(() => {
  parityStore.setState(() => ({ enabled: false }));
  setPrefs(initialPrefs);
  eventsStore.setState(() => ({ state: "idle", lastEventAt: null, topics: [] }));
});

describe("adaptive query focus policy", () => {
  it("refocuses live queries unless parity or paused updates are active", () => {
    parityStore.setState(() => ({ enabled: false }));
    setPrefs({ livePaused: false });
    const focus = adaptive("live").refetchOnWindowFocus as () => boolean;
    expect(focus()).toBe(true);
    setPrefs({ livePaused: true });
    expect(focus()).toBe(false);
    expect((adaptive("static").refetchOnWindowFocus as () => boolean)()).toBe(false);
    parityStore.setState(() => ({ enabled: true }));
    setPrefs({ livePaused: false });
    expect(focus()).toBe(false);
  });

  it("uses the adaptive interval callback and parity-sensitive stale times", () => {
    parityStore.setState(() => ({ enabled: false }));
    setPrefs({ livePaused: false, liveIntervalMs: 1000 });
    const interval = adaptive("live").refetchInterval as (query: {
      state: { fetchFailureCount: number };
      meta?: Record<string, unknown>;
    }) => number | false;
    expect(interval({ state: { fetchFailureCount: 1 }, meta: { topic: "yarn/apps" } })).toBe(2000);
    expect(interval({ state: { fetchFailureCount: 0 }, meta: { topic: 10 } })).toBe(1000);
    expect(adaptive("live").staleTime).toBe(500);
    expect(adaptive("static").staleTime).toBe(60_000);
    parityStore.setState(() => ({ enabled: true }));
    expect(adaptive("live").staleTime).toBe(Number.POSITIVE_INFINITY);
  });

  it("suspends polling for static, paused, parity, and hidden-page states", () => {
    parityStore.setState(() => ({ enabled: false }));
    setPrefs({ livePaused: false, liveIntervalMs: 2000 });
    const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
    try {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      expect(configuredInterval("live")).toBe(2000);
      expect(configuredInterval("slow")).toBe(8000);
      expect(configuredInterval("static")).toBe(false);
      expect(nextInterval("live", 2)).toBe(8000);

      eventsStore.setState(() => ({ state: "open", lastEventAt: Date.now(), topics: ["yarn/nodes"] }));
      expect(nextInterval("live", 0, "yarn/nodes")).toBe(30_000);
      expect(nextInterval("live", 0, "yarn/apps")).toBe(2000);
      expect(nextInterval("slow", 5)).toBe(30_000);

      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      expect(configuredInterval("live")).toBe(false);
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      setPrefs({ livePaused: true });
      expect(nextInterval("live", 0)).toBe(false);
      setPrefs({ livePaused: false });
      parityStore.setState(() => ({ enabled: true }));
      expect(configuredInterval("live")).toBe(false);
    } finally {
      if (hidden) Object.defineProperty(document, "hidden", hidden);
      else Reflect.deleteProperty(document, "hidden");
    }
  });
});
