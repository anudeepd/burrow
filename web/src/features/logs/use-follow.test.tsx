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
  vi.restoreAllMocks();
  FakeEventSource.instances = [];
  if (originalEventSource) globalThis.EventSource = originalEventSource;
  else Reflect.deleteProperty(globalThis, "EventSource");
});

describe("useFollow", () => {
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
      responseMeta: { api: null, cache: null, upstream: null, ageMs: null, etag: null },
    });
    const opts = options();
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

    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(fetchWindow).toHaveBeenCalledWith(opts.containerId, opts.name, {
      offset: 0,
      length: 128 * 1024,
      hints: opts.hints,
    });
    expect(opts.buffer.toLines()).toEqual(["INFO polled"]);
    expect(opts.onAppend).toHaveBeenCalledOnce();

    act(() => result.current.retry());
    expect(FakeEventSource.instances).toHaveLength(4);
    expect(third?.closed).toBe(true);
    unmount();
    expect(FakeEventSource.instances[3]?.closed).toBe(true);
  });
});
