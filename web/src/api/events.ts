/**
 * SSE client (contract §6): ONE EventSource per tab. Subscribes to the topics of the queries that are currently observed,
 * maps `invalidate` pushes to those queries, and falls back to polling automatically (refetch.ts reads eventsStore:
 * polling is relaxed to a 30 s safety net only while the stream is OPEN).
 */
import type { QueryClient } from "@tanstack/react-query";
import { isParity } from "~/state/parity";
import { prefsStore } from "~/state/prefs";
import { configuredInterval, eventsStore } from "./refetch";

const MAX_TOPICS = 64;
const RECONNECT_MS = [1000, 2000, 5000, 10_000, 20_000];

export function topicsInUse(qc: QueryClient): string[] {
  const set = new Set<string>();
  for (const query of qc.getQueryCache().getAll()) {
    const meta = query.meta as { topic?: string; refetchKind?: string } | undefined;
    // Push invalidations are for fast-changing live data. Slow data follows the selected 4× cadence; static data
    // doesn't refresh. Keeping both out of the topic set also prevents expensive JMX/config topics being polled by SSE.
    if (meta?.topic && meta.refetchKind === "live" && query.getObserversCount() > 0) set.add(meta.topic);
  }
  return [...set].sort().slice(0, MAX_TOPICS);
}

export function startEvents(qc: QueryClient, enabled: () => boolean): () => void {
  if (typeof EventSource === "undefined" || isParity()) {
    eventsStore.setState((s) => ({ ...s, state: "unsupported" }));
    return () => {};
  }
  let es: EventSource | null = null;
  let current = "";
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const lastInvalidated = new Map<string, number>();
  const pendingInvalidations = new Map<string, ReturnType<typeof setTimeout>>();

  const clearPendingInvalidations = () => {
    for (const pending of pendingInvalidations.values()) clearTimeout(pending);
    pendingInvalidations.clear();
  };

  const hasActiveLiveQuery = (topic: string) =>
    qc
      .getQueryCache()
      .getAll()
      .some((query) => {
        const meta = query.meta as { topic?: string; refetchKind?: string } | undefined;
        return meta?.topic === topic && meta.refetchKind === "live" && query.getObserversCount() > 0;
      });

  const invalidateNow = (topic: string) => {
    if (configuredInterval("live") === false || !hasActiveLiveQuery(topic)) return;
    void qc.invalidateQueries({
      predicate: (query) => {
        const meta = query.meta as { topic?: string; refetchKind?: string } | undefined;
        return meta?.topic === topic && meta.refetchKind === "live";
      },
      refetchType: "active",
    });
  };

  const onInvalidate = (topic: string) => {
    if (!hasActiveLiveQuery(topic)) return;
    const cadence = configuredInterval("live");
    if (cadence === false) return;

    const now = Date.now();
    const last = lastInvalidated.get(topic);
    if (last == null || now - last >= cadence) {
      const pending = pendingInvalidations.get(topic);
      if (pending) clearTimeout(pending);
      pendingInvalidations.delete(topic);
      lastInvalidated.set(topic, now);
      invalidateNow(topic);
      return;
    }

    if (pendingInvalidations.has(topic)) return;
    const pending = setTimeout(
      () => {
        pendingInvalidations.delete(topic);
        const currentCadence = configuredInterval("live");
        if (currentCadence === false || !hasActiveLiveQuery(topic)) return;
        lastInvalidated.set(topic, Date.now());
        invalidateNow(topic);
      },
      cadence - (now - last),
    );
    pendingInvalidations.set(topic, pending);
  };

  const close = () => {
    es?.close();
    es = null;
  };

  const connect = () => {
    clearTimeout(timer);
    if (prefsStore.get().livePaused || (typeof document !== "undefined" && document.hidden)) {
      close();
      current = "";
      clearPendingInvalidations();
      eventsStore.setState((s) => ({ ...s, state: "idle", topics: [] }));
      return;
    }
    if (!enabled()) {
      close();
      current = "";
      clearPendingInvalidations();
      eventsStore.setState((s) => ({ ...s, state: "unsupported", topics: [] }));
      return;
    }
    const topics = topicsInUse(qc);
    const key = topics.join(",");
    if (topics.length === 0) {
      close();
      current = "";
      clearPendingInvalidations();
      eventsStore.setState((s) => ({ ...s, state: "idle", topics: [] }));
      return;
    }
    if (es && key === current && es.readyState !== EventSource.CLOSED) return;
    clearPendingInvalidations();
    lastInvalidated.clear();
    close();
    current = key;
    eventsStore.setState((s) => ({ ...s, state: "connecting", topics: [] }));
    /* Each topic is encoded on its own and joined with a literal comma: the comma between topics is the separator while
       a comma inside a topic's query (`yarn/apps?…&states=NEW,NEW_SAVING,…`) must arrive as `%2C`. Encoding the joined
       string (the old behaviour) made the two indistinguishable and the hub answered 400. */
    es = new EventSource(`/api/events?topics=${topics.map(encodeURIComponent).join(",")}`);
    es.addEventListener("hello", () => {
      attempt = 0;
      eventsStore.setState((s) => ({ ...s, state: "open", lastEventAt: Date.now(), topics }));
    });
    es.addEventListener("invalidate", (ev) => {
      eventsStore.setState((s) => ({ ...s, lastEventAt: Date.now() }));
      try {
        const { topic } = JSON.parse((ev as MessageEvent<string>).data) as { topic: string };
        if (typeof topic === "string") onInvalidate(topic);
      } catch {
        /* malformed event: ignore, polling fallback still covers us */
      }
    });
    es.onerror = () => {
      // EventSource would retry silently forever; take control so the UI shows "polling" and backoff is bounded.
      close();
      eventsStore.setState((s) => ({ ...s, state: "down", topics: [] }));
      timer = setTimeout(connect, RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)]);
    };
  };

  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(connect, 250);
  };
  const unsub = qc.getQueryCache().subscribe((e) => {
    if (e.type === "observerAdded" || e.type === "observerRemoved" || e.type === "added" || e.type === "removed") schedule();
  });
  let prevPrefs = prefsStore.get();
  const prefsSubscription = prefsStore.subscribe((p) => {
    const changed = p.livePaused !== prevPrefs.livePaused || p.liveIntervalMs !== prevPrefs.liveIntervalMs;
    prevPrefs = p;
    if (!changed) return;
    clearPendingInvalidations();
    lastInvalidated.clear();
    schedule();
  });
  const onVisibilityChange = () => {
    if (document.hidden) clearPendingInvalidations();
    schedule();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  schedule();
  return () => {
    unsub();
    prefsSubscription.unsubscribe();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    clearTimeout(timer);
    clearTimeout(debounce);
    clearPendingInvalidations();
    close();
  };
}
