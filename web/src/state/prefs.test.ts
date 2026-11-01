import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => localStorage.removeItem("burrow.prefs.v1"));

describe("preference loading", () => {
  it("falls back to server defaults when persisted JSON is malformed", async () => {
    localStorage.setItem("burrow.prefs.v1", "{");
    vi.resetModules();
    const { prefsStore, PREF_DEFAULTS } = await import("./prefs");
    expect(prefsStore.get()).toEqual(PREF_DEFAULTS);
  });
});
