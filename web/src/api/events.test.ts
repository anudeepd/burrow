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
    const topics: { topic: string; kind?: string }[] = Array.from({ length: 70 }, (_, i) => ({ topic: `topic-${String(i).padStart(2, "0")}` }));
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
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
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

  it("reports unsupported when EventSource is unavailable", () => {
    Reflect.deleteProperty(globalThis, "EventSource");
    const stop = startEvents(new QueryClient(), () => true);
    expect(eventsStore.get().state).toBe("unsupported");
    stop();
  });
});
