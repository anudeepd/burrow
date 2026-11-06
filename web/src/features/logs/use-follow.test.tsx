import { flushSync } from "react-dom";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLogWindow, logStreamUrl } from "~/api/queries/logs";
import { LineBuffer } from "./model";
import { useFollow, type FollowOptions } from "./use-follow";

vi.mock("~/api/queries/logs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api/queries/logs")>()),
  fetchLogWindow: vi.fn(),
  logStreamUrl: vi.fn(() => "/api/logs/stream"),
}));

type Listener = (event: Event) => void;
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    const event = new Event(type) as MessageEvent<string>;
    if (data !== undefined) Object.defineProperty(event, "data", { value: data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const originalEventSource = globalThis.EventSource;
const fetchWindow = vi.mocked(fetchLogWindow);
const streamUrl = vi.mocked(logStreamUrl);

function options(overrides: Partial<FollowOptions> = {}): FollowOptions {
  return {
    enabled: true,
    paused: false,
    intervalMs: 100,
    containerId: "container_1_2_3_4",
    name: "stdout",
    hints: { node: "nm:8041", user: "alice", app: "application_1_2" },
    buffer: new LineBuffer(),
    onAppend: vi.fn(),
    onEnded: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchWindow.mockReset();
  streamUrl.mockClear();
  FakeEventSource.instances = [];
  if (originalEventSource) globalThis.EventSource = originalEventSource;
  else Reflect.deleteProperty(globalThis, "EventSource");
});

describe("useFollow", () => {
  it.each([
    ["paused", { paused: true }],
    ["missing container", { containerId: null }],
    ["missing log name", { name: null }],
  ])("stays off when follow is %s", (_reason, overrides) => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const opts = options(overrides);
    const { result } = renderHook(() => useFollow(opts));
    expect(result.current.status.mode).toBe("off");
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("restarts the stream when the user retries", () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const opts = options();
    const { result } = renderHook(() => useFollow(opts));
    const first = FakeEventSource.instances[0];
    act(() => result.current.retry());
    expect(first?.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("ignores late stream and poll callbacks after the follow effect is cleaned up", async () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const timers: { callback: () => void; delay: number; id: number }[] = [];
    const clearTimer = vi.fn();
    let nextTimerId = 1;
    vi.stubGlobal("setTimeout", ((callback: TimerHandler, delay?: number) => {
      const id = nextTimerId++;
      if (typeof callback === "function") timers.push({ callback: callback as () => void, delay: Number(delay), id });
      return id;
    }) as unknown as typeof setTimeout);
    vi.stubGlobal("clearTimeout", clearTimer);
    let rejectPoll!: (reason: Error) => void;
    fetchWindow.mockReturnValue(new Promise((_, reject) => (rejectPoll = reject)));
    const opts = options({ hints: undefined });
    const { unmount } = renderHook(() => useFollow(opts));

    const first = FakeEventSource.instances[0]!;
    act(() => first.emit("error"));
    act(() => timers.find((timer) => timer.delay === 1_000)?.callback());
    const second = FakeEventSource.instances[1]!;
    act(() => second.emit("error"));
    act(() => timers.find((timer) => timer.delay === 2_000)?.callback());
    const third = FakeEventSource.instances[2]!;
    act(() => third.emit("error"));

    const pollTimer = timers.find((timer) => timer.delay === 250)!;
    const streamRetry = timers.find((timer) => timer.delay === 30_000)!;
    act(() => pollTimer.callback());
    expect(fetchWindow).toHaveBeenCalledOnce();
    unmount();

    act(() => {
      timers.find((timer) => timer.delay === 1_000)?.callback();
      timers.find((timer) => timer.delay === 2_000)?.callback();
      pollTimer.callback();
      streamRetry.callback();
      third.emit("open");
      third.emit("chunk", JSON.stringify({ start: 0, text: "late" }));
      third.emit("eof");
      third.emit("error");
    });
    await act(async () => {
      rejectPoll(new Error("late poll failure"));
      await Promise.resolve();
    });
    expect(opts.onAppend).not.toHaveBeenCalled();
    expect(opts.onEnded).not.toHaveBeenCalled();
    expect(clearTimer).toHaveBeenCalled();
  });

  it("does not append a successful poll that resolves after unmount", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    let resolvePoll!: (value: Awaited<ReturnType<typeof fetchLogWindow>>) => void;
    fetchWindow.mockReturnValue(new Promise((resolve) => (resolvePoll = resolve)));
    const opts = options();
    const { unmount } = renderHook(() => useFollow(opts));
    act(() => FakeEventSource.instances[0]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => FakeEventSource.instances[1]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    act(() => FakeEventSource.instances[2]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    unmount();
    await act(async () => {
      resolvePoll({
        text: "late poll bytes",
        start: 0,
        end: 15,
        size: 15,
        source: "node",
        ended: false,
        responseMeta: { api: null, cache: null, upstream: null, ageMs: null, etag: null },
      });
      await Promise.resolve();
    });
    expect(opts.buffer.toLines()).toEqual([]);
    expect(opts.onAppend).not.toHaveBeenCalled();
  });

  it("starts off when disabled, then streams chunks and marks EOF", () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const opts = options({ enabled: false });
    const { result, rerender, unmount } = renderHook(({ value }) => useFollow(value), { initialProps: { value: opts } });
    expect(result.current.status.mode).toBe("off");
    expect(FakeEventSource.instances).toHaveLength(0);

    rerender({ value: { ...opts, enabled: true } });
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe("/api/logs/stream");
    expect(streamUrl).toHaveBeenCalledWith(opts.containerId, opts.name, opts.hints, 0);
    expect(result.current.status.mode).toBe("connecting");

    act(() => source?.emit("open"));
    expect(result.current.status.mode).toBe("streaming");
    act(() => source?.emit("chunk", JSON.stringify({ start: 0, text: "INFO first\n" })));
    expect(opts.buffer.toLines()).toEqual(["INFO first"]);
    expect(opts.onAppend).toHaveBeenCalledOnce();
    act(() => source?.emit("chunk", "not json"));
    expect(opts.buffer.toLines()).toEqual(["INFO first"]);

    act(() => source?.emit("eof"));
    expect(result.current.status.mode).toBe("ended");
    expect(opts.buffer.ended).toBe(true);
    expect(opts.onEnded).toHaveBeenCalledOnce();
    expect(source?.closed).toBe(true);
    act(() => {
      source?.emit("eof");
      source?.emit("error");
    });
    expect(result.current.status.mode).toBe("ended");
    expect(opts.onEnded).toHaveBeenCalledOnce();
    unmount();
  });

  it("backs off twice, falls back to byte-range polling, and retries the stream", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    fetchWindow.mockResolvedValue({
      text: "INFO polled\n",
      start: 0,
      end: 12,
      size: 12,
      source: "node",
      ended: false,
      responseMeta: { api: null, cache: null, upstream: null, ageMs: null, etag: null },
    });
    const opts = options({ intervalMs: 30_000 });
    const { result, unmount } = renderHook(() => useFollow(opts));

    const first = FakeEventSource.instances[0];
    expect(first).toBeDefined();
    act(() => first?.emit("error"));
    expect(result.current.status).toMatchObject({ mode: "reconnecting", reconnects: 1, detail: "stream connection lost" });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    const second = FakeEventSource.instances[1];
    act(() => second?.emit("error", JSON.stringify({ error: { message: "gateway closed the stream" } })));
    expect(result.current.status).toMatchObject({ mode: "reconnecting", reconnects: 2, detail: "gateway closed the stream" });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    const third = FakeEventSource.instances[2];
    act(() => third?.emit("error", "not json"));
    expect(result.current.status).toMatchObject({ mode: "polling", reconnects: 3, detail: "log stream error" });

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchWindow).toHaveBeenCalledWith(opts.containerId, opts.name, {
      offset: 0,
      length: 128 * 1024,
      follow: true,
      hints: opts.hints,
    });
    expect(opts.buffer.toLines()).toEqual(["INFO polled"]);
    expect(opts.onAppend).toHaveBeenCalledOnce();
    expect(FakeEventSource.instances).toHaveLength(4);
    expect(third?.closed).toBe(true);
    unmount();
    expect(FakeEventSource.instances[3]?.closed).toBe(true);
  });

  it("appends the final poll bytes and stops polling when the backend confirms completion", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    fetchWindow.mockResolvedValue({
      text: "INFO final line\n",
      start: 0,
      end: 16,
      size: 16,
      source: "node",
      ended: true,
      responseMeta: { api: null, cache: null, upstream: null, ageMs: null, etag: null },
    });
    const opts = options({ intervalMs: 100 });
    const { result, unmount } = renderHook(() => useFollow(opts));

    act(() => FakeEventSource.instances[0]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => FakeEventSource.instances[1]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    const third = FakeEventSource.instances[2];
    act(() => third?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(250));

    expect(fetchWindow).toHaveBeenCalledOnce();
    expect(fetchWindow).toHaveBeenCalledWith(opts.containerId, opts.name, {
      offset: 0,
      length: 128 * 1024,
      follow: true,
      hints: opts.hints,
    });
    expect(opts.buffer.toLines()).toEqual(["INFO final line"]);
    expect(opts.buffer.ended).toBe(true);
    expect(result.current.status.mode).toBe("ended");
    expect(opts.onEnded).toHaveBeenCalledOnce();

    act(() => third?.emit("chunk", JSON.stringify({ start: 16, text: "late\n" })));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchWindow).toHaveBeenCalledOnce();
    expect(opts.buffer.toLines()).toEqual(["INFO final line"]);
    expect(FakeEventSource.instances).toHaveLength(3);
    unmount();
  });

  it("does not finish when the final poll synchronously unmounts from onAppend", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    fetchWindow.mockResolvedValue({
      text: "INFO final line\n",
      start: 0,
      end: 16,
      size: 16,
      source: "node",
      ended: true,
      responseMeta: { api: null, cache: null, upstream: null, ageMs: null, etag: null },
    });
    let unmount = () => {};
    const opts = options({
      onAppend: () => flushSync(() => unmount()),
    });
    ({ unmount } = renderHook(() => useFollow(opts)));

    act(() => FakeEventSource.instances[0]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => FakeEventSource.instances[1]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    act(() => FakeEventSource.instances[2]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(250));

    expect(opts.buffer.toLines()).toEqual(["INFO final line"]);
    expect(opts.buffer.ended).toBe(false);
    expect(opts.onEnded).not.toHaveBeenCalled();
  });

  it("reports a failed poll and returns to the original polling reason after recovery", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    fetchWindow.mockRejectedValueOnce("poll endpoint unavailable").mockResolvedValueOnce({
      text: "INFO recovered\n",
      start: 0,
      end: 16,
      size: 16,
      source: "node",
      ended: false,
      responseMeta: { api: null, cache: null, upstream: null, ageMs: null, etag: null },
    });
    const opts = options();
    const { result, unmount } = renderHook(() => useFollow(opts));

    act(() => FakeEventSource.instances[0]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => FakeEventSource.instances[1]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    act(() => FakeEventSource.instances[2]?.emit("error", "invalid payload"));

    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(result.current.status).toMatchObject({ mode: "polling", detail: "poll read failed: poll endpoint unavailable", reconnects: 3 });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(result.current.status).toMatchObject({ mode: "polling", detail: "log stream error", reconnects: 3 });
    expect(opts.buffer.toLines()).toEqual(["INFO recovered"]);
    unmount();
  });

  it("handles empty poll windows and JSON stream errors without messages", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    fetchWindow.mockRejectedValueOnce(new Error("poll failed")).mockResolvedValueOnce({
      text: "",
      start: 0,
      end: 0,
      size: 0,
      source: "node",
      ended: false,
      responseMeta: { api: null, cache: null, upstream: null, ageMs: null, etag: null },
    });
    const opts = options({ intervalMs: 100 });
    const { result, unmount } = renderHook(() => useFollow(opts));

    act(() => FakeEventSource.instances[0]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => FakeEventSource.instances[1]?.emit("error"));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    act(() => FakeEventSource.instances[2]?.emit("error", JSON.stringify({ error: {} })));
    expect(result.current.status).toMatchObject({ mode: "polling", detail: "log stream error", reconnects: 3 });

    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(result.current.status.detail).toBe("poll read failed: poll failed");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(result.current.status.detail).toBe("log stream error");
    expect(opts.onAppend).not.toHaveBeenCalled();
    unmount();
  });
});
