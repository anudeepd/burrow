import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { historyStore, pushSample, useUtilisation, type UtilSample } from "./history";

const sample = (t: number): UtilSample => ({ t, memPct: 20, vcorePct: 30, appsRunning: 4, appsPending: 2, containers: 6 });

afterEach(() => {
  cleanup();
  act(() => historyStore.setState(() => ({ samples: [] })));
});

describe("utilisation history", () => {
  it("exposes the current sample list to subscribers", async () => {
    const { result } = renderHook(() => useUtilisation());
    expect(result.current).toEqual([]);
    await act(async () => pushSample(sample(1000)));
    expect(result.current).toEqual([sample(1000)]);
  });

  it("keeps one sample per half-second and bounds the session buffer", async () => {
    await act(async () => pushSample(sample(1000)));
    await act(async () => pushSample(sample(1499)));
    expect(historyStore.get().samples.map((item) => item.t)).toEqual([1000]);

    await act(async () => pushSample(sample(1500)));
    expect(historyStore.get().samples.map((item) => item.t)).toEqual([1000, 1500]);

    await act(async () => {
      historyStore.setState(() => ({ samples: Array.from({ length: 900 }, (_, index) => sample(index * 1000)) }));
      pushSample(sample(900_000));
    });
    act(() => pushSample(sample(900_000)));
    const samples = historyStore.get().samples;
    expect(samples).toHaveLength(900);
    expect(samples[0]?.t).toBe(1000);
    expect(samples.at(-1)?.t).toBe(900_000);
  });
});
