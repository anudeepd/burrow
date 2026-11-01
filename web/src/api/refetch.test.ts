import { afterEach, describe, expect, it } from "vitest";
import { adaptive } from "./refetch";
import { parityStore } from "~/state/parity";
import { prefsStore, setPrefs } from "~/state/prefs";

const initialPrefs = prefsStore.get();

afterEach(() => {
  parityStore.setState(() => ({ enabled: false }));
  setPrefs(initialPrefs);
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
  });
});
