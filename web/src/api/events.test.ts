import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventsStore } from "./refetch";
import { setPrefs } from "~/state/prefs";
import { startEvents, topicsInUse } from "./events";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, EventListener[]>();
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onerror: ((this: EventSource, event: Event) => unknown) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    const event = new Event(type) as MessageEvent<string>;
    if (data !== undefined) Object.defineProperty(event, "data", { value: data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    if (type === "error") this.onerror?.call(this as unknown as EventSource, event);
  }
}

const originalEventSource = globalThis.EventSource;
const observers: (() => void)[] = [];

function makeClient(topics: { topic: string; kind?: string }[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [index, item] of topics.entries()) {
    const observer = new QueryObserver(client, {
      queryKey: ["event-test", index],
      queryFn: async () => index,
      enabled: false,
      meta: { topic: item.topic, refetchKind: item.kind ?? "live" },
    });
    observers.push(observer.subscribe(() => {}));
  }
  return client;
}

function resetStores(): void {
  eventsStore.setState(() => ({ state: "idle", lastEventAt: null, topics: [] }));
  setPrefs({ livePaused: false, liveIntervalMs: 1000 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const unsubscribe of observers.splice(0)) unsubscribe();
  FakeEventSource.instances = [];
  if (originalEventSource) globalThis.EventSource = originalEventSource;
  else Reflect.deleteProperty(globalThis, "EventSource");
  resetStores();
});

describe("SSE topics and lifecycle", () => {
  it("selects only active live topics, sorts them, and caps the set at 64", () => {
    const topics: { topic: string; kind?: string }[] = Array.from({ length: 70 }, (_, i) => ({
      topic: `topic-${String(i).padStart(2, "0")}`,
    }));
    topics.push({ topic: "slow-topic", kind: "slow" });
    const client = makeClient(topics);
    const active = topicsInUse(client);
    expect(active).toHaveLength(64);
    expect(active).toEqual([...active].sort((a, b) => a.localeCompare(b)));
    expect(active).not.toContain("slow-topic");
    client.clear();
  });

  it("encodes topic commas independently, opens on hello, and throttles duplicate invalidations", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const topic = "yarn/apps?states=NEW,NEW_SAVING";
    const client = makeClient([{ topic }]);
    const actualInvalidateQueries = client.invalidateQueries.bind(client);
    const invalidate = vi.spyOn(client, "invalidateQueries").mockImplementation((...args) => actualInvalidateQueries(...args));
    const stop = startEvents(client, () => true);
    await vi.advanceTimersByTimeAsync(250);

    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe("/api/events?topics=yarn%2Fapps%3Fstates%3DNEW%2CNEW_SAVING");
    expect(eventsStore.get().state).toBe("connecting");
    source?.emit("hello");
    expect(eventsStore.get().state).toBe("open");
    expect(eventsStore.get().topics).toEqual([topic]);

    source?.emit("invalidate", JSON.stringify({ topic }));
    expect(invalidate).toHaveBeenCalledTimes(1);
    source?.emit("invalidate", JSON.stringify({ topic }));
    source?.emit("invalidate", JSON.stringify({ topic }));
    source?.emit("invalidate", "malformed");
    source?.emit("invalidate", JSON.stringify({ topic: 42 }));
    source?.emit("invalidate", JSON.stringify({ topic: "not-observed" }));
    expect(invalidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(invalidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(eventsStore.get().lastEventAt).not.toBeNull();

    stop();
    expect(source?.closed).toBe(true);
    client.clear();
  });

  it("reconnects after transport failure, then pauses and closes when live mode is paused", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const client = makeClient([{ topic: "rm/cluster" }]);
    const stop = startEvents(client, () => true);
    await vi.advanceTimersByTimeAsync(250);
    const first = FakeEventSource.instances[0];
    first?.emit("error");
    expect(eventsStore.get().state).toBe("down");
    expect(first?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000 + 250);
    const second = FakeEventSource.instances[1];
    expect(second).toBeDefined();

    setPrefs({ livePaused: true });
    await vi.advanceTimersByTimeAsync(250);
    expect(eventsStore.get()).toMatchObject({ state: "idle", topics: [] });
    expect(second?.closed).toBe(true);
    stop();
    client.clear();
  });

  it("keeps one stream for an unchanged topic set and ignores non-string topic values", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const client = makeClient([{ topic: "rm/cluster" }]);
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    const stop = startEvents(client, () => true);
    await vi.advanceTimersByTimeAsync(250);
    const source = FakeEventSource.instances[0]!;
    source.emit("hello");
    source.emit("invalidate", JSON.stringify({ topic: 42 }));
    expect(invalidate).not.toHaveBeenCalled();

    const extra = new QueryObserver(client, {
      queryKey: ["same-topic"],
      queryFn: async () => true,
      enabled: false,
      meta: { topic: "rm/cluster", refetchKind: "live" },
    });
    const unsubscribe = extra.subscribe(() => {});
    observers.push(unsubscribe);
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeEventSource.instances).toHaveLength(1);

    stop();
    client.clear();
  });

  it("replaces a delayed invalidation at the cadence boundary", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    setPrefs({ livePaused: false, liveIntervalMs: 1000 });
    const client = makeClient([{ topic: "rm/cluster" }]);
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    const stop = startEvents(client, () => true);
    await vi.advanceTimersByTimeAsync(250);
    const source = FakeEventSource.instances[0]!;
    const firstAt = Date.now();
    source.emit("invalidate", JSON.stringify({ topic: "rm/cluster" }));
    await vi.advanceTimersByTimeAsync(100);
    source.emit("invalidate", JSON.stringify({ topic: "rm/cluster" }));
    vi.setSystemTime(firstAt + 1000);
    source.emit("invalidate", JSON.stringify({ topic: "rm/cluster" }));

    expect(invalidate).toHaveBeenCalledTimes(2);
    stop();
    client.clear();
  });

  it("drops pending invalidations when updates pause or the topic becomes inactive", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    setPrefs({ livePaused: false, liveIntervalMs: 20 });
    const pausedClient = makeClient([{ topic: "rm/paused" }]);
    const pausedInvalidate = vi.spyOn(pausedClient, "invalidateQueries").mockResolvedValue(undefined);
    const stopPaused = startEvents(pausedClient, () => true);
    await vi.advanceTimersByTimeAsync(250);
    const pausedSource = FakeEventSource.instances[0]!;
    pausedSource.emit("invalidate", JSON.stringify({ topic: "rm/paused" }));
    await vi.advanceTimersByTimeAsync(5);
    pausedSource.emit("invalidate", JSON.stringify({ topic: "rm/paused" }));
    setPrefs({ livePaused: true });
    pausedSource.emit("invalidate", JSON.stringify({ topic: "rm/paused" }));
    await vi.advanceTimersByTimeAsync(15);
    expect(pausedInvalidate).toHaveBeenCalledOnce();
    stopPaused();
    pausedClient.clear();

    setPrefs({ livePaused: false, liveIntervalMs: 1000 });
    const inactiveClient = makeClient([{ topic: "rm/inactive" }]);
    const inactiveInvalidate = vi.spyOn(inactiveClient, "invalidateQueries").mockResolvedValue(undefined);
    const stopInactive = startEvents(inactiveClient, () => true);
    await vi.advanceTimersByTimeAsync(250);
    const inactiveSource = FakeEventSource.instances.at(-1)!;
    inactiveSource.emit("invalidate", JSON.stringify({ topic: "rm/inactive" }));
    await vi.advanceTimersByTimeAsync(100);
    inactiveSource.emit("invalidate", JSON.stringify({ topic: "rm/inactive" }));
    const query = inactiveClient.getQueryCache().getAll()[0]!;
    query.setOptions({ ...query.options, meta: { topic: "rm/inactive", refetchKind: "static" } });
    await vi.advanceTimersByTimeAsync(900);
    expect(inactiveInvalidate).toHaveBeenCalledOnce();
    stopInactive();
    inactiveClient.clear();
  });

  it("responds to enablement, query removal, and document visibility changes", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const client = makeClient([{ topic: "rm/cluster" }]);
    let enabled = false;
    const stop = startEvents(client, () => enabled);
    await vi.advanceTimersByTimeAsync(250);
    expect(eventsStore.get()).toMatchObject({ state: "unsupported", topics: [] });
    expect(FakeEventSource.instances).toHaveLength(0);

    enabled = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeEventSource.instances).toHaveLength(1);

    const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(250);
    expect(eventsStore.get()).toMatchObject({ state: "idle", topics: [] });
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    if (hidden) Object.defineProperty(document, "hidden", hidden);
    else Reflect.deleteProperty(document, "hidden");

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeEventSource.instances).toHaveLength(2);
    setPrefs({ motion: "reduced" });
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeEventSource.instances).toHaveLength(2);
    client.clear();
    await vi.advanceTimersByTimeAsync(250);
    expect(eventsStore.get()).toMatchObject({ state: "idle", topics: [] });
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
    stop();
    client.clear();
  });

  it("reports unsupported when EventSource is unavailable", () => {
    Reflect.deleteProperty(globalThis, "EventSource");
    const stop = startEvents(new QueryClient(), () => true);
    expect(eventsStore.get().state).toBe("unsupported");
    stop();
  });
});
