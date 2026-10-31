/**
 * Live follow for a container log: SSE first, ranged polling as the fallback, both resuming from the last byte held.
 *
 * Why not `EventSource` alone: the browser's auto-reconnect re-requests the *same* URL, so it would replay the whole
 * log from the original offset forever. This hook takes control — it closes and reopens with `?offset=<watermark>`,
 * backs off, and after two stream failures switches to byte-range polling so a backend whose SSE route is broken (or
 * a proxy that buffers event streams) still shows new lines. The active transport is surfaced to the status bar; it is
 * never silent.
 */
import { useEffect, useRef, useState } from "react";
import { type LogHints, fetchLogWindow, logStreamUrl } from "~/api/queries/logs";
import type { LineBuffer } from "./model";

export type FollowMode = "off" | "connecting" | "streaming" | "reconnecting" | "polling" | "ended" | "error";

export interface FollowStatus {
  mode: FollowMode;
  /** human-readable reason for the current non-happy mode (shown in the status bar) */
  detail: string | null;
  /** how many times the stream has failed since follow started */
  reconnects: number;
}

export interface FollowOptions {
  enabled: boolean;
  /** user paused live mode (prefs) — follow suspends without forgetting the URL state */
  paused: boolean;
  /** selected live polling cadence, used when the stream falls back to ranged polling */
  intervalMs: number;
  containerId: string | null;
  name: string | null;
  hints?: LogHints;
  buffer: LineBuffer;
  /** called after the buffer mutates (throttle in the caller) */
  onAppend: () => void;
  onEnded: () => void;
}

const STREAM_BACKOFF_MS = [1_000, 2_000, 5_000];
const POLL_BACKOFF_CAP_MS = 30_000;
/** A polling read is a plain ranged GET; 128 KiB keeps a fast-growing file close to the tail without hammering. */
const POLL_BYTES = 128 * 1024;
/** After falling back to polling, keep trying the stream occasionally so a transient SSE failure self-heals. */
const STREAM_RETRY_MS = 30_000;

const OFF: FollowStatus = { mode: "off", detail: null, reconnects: 0 };

export function useFollow(opts: FollowOptions): { status: FollowStatus; retry: () => void } {
  const { enabled, paused, intervalMs, containerId, name, hints, buffer, onAppend, onEnded } = opts;
  const [status, setStatus] = useState<FollowStatus>(OFF);
  const [nonce, setNonce] = useState(0);
  const intervalMsRef = useRef(intervalMs);
  intervalMsRef.current = intervalMs;

  // Keep the newest callbacks without making them effect dependencies (they change every render).
  const onAppendRef = useRef(onAppend);
  const onEndedRef = useRef(onEnded);
  onAppendRef.current = onAppend;
  onEndedRef.current = onEnded;

  // Stable hint identity so a new object literal does not restart the stream.
  const hintKey = `${hints?.node ?? ""}|${hints?.user ?? ""}|${hints?.app ?? ""}`;
  const hintsRef = useRef(hints);
  hintsRef.current = hints;

  useEffect(() => {
    if (!enabled || paused || !containerId || !name) {
      setStatus(OFF);
      return;
    }
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let streamRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let mode: FollowMode = "off";
    let failures = 0;
    let pollFailures = 0;
    let pollingReason = "stream unavailable";

    const publish = (next: FollowMode, detail: string | null = null) => {
      if (cancelled) return;
      if (next === mode && detail === null) return;
      mode = next;
      setStatus({ mode: next, detail, reconnects: failures });
    };

    const closeStream = () => {
      es?.close();
      es = null;
    };

    const startPolling = (detail: string) => {
      pollingReason = detail;
      publish("polling", detail);
      const tick = () => {
        if (cancelled) return;
        const delay = Math.min(POLL_BACKOFF_CAP_MS, Math.max(250, intervalMsRef.current) * 2 ** Math.min(pollFailures, 5));
        pollTimer = setTimeout(() => {
          void (async () => {
            if (cancelled) return;
            try {
              const w = await fetchLogWindow(containerId, name, {
                offset: buffer.resumeOffset,
                length: POLL_BYTES,
                hints: hintsRef.current,
              });
              if (cancelled) return;
              if (w.text) {
                buffer.append(w.text, w.start);
                onAppendRef.current();
              }
              if (pollFailures > 0) publish("polling", pollingReason);
              pollFailures = 0;
            } catch (error) {
              pollFailures++;
              const message = error instanceof Error ? error.message : String(error);
              publish("polling", `poll read failed: ${message}`);
            }
            tick();
          })();
        }, delay);
      };
      tick();
    };

    const handleStreamFailure = (detail: string) => {
      closeStream();
      failures++;
      if (failures <= 2) {
        publish("reconnecting", detail);
        reconnectTimer = setTimeout(startStream, STREAM_BACKOFF_MS[failures - 1]);
      } else {
        startPolling(detail);
        streamRetryTimer = setTimeout(() => {
          if (cancelled) return;
          clearTimeout(pollTimer);
          startStream();
        }, STREAM_RETRY_MS);
      }
    };

    const startStream = () => {
      if (cancelled) return;
      clearTimeout(reconnectTimer);
      clearTimeout(pollTimer);
      publish(failures === 0 ? "connecting" : "reconnecting");
      const url = logStreamUrl(containerId, name, hintsRef.current, buffer.resumeOffset);
      const source = new EventSource(url);
      es = source;
      source.addEventListener("open", () => {
        if (cancelled) return;
        failures = 0;
        publish("streaming");
      });
      source.addEventListener("chunk", (ev) => {
        if (cancelled) return;
        try {
          const d = JSON.parse((ev as MessageEvent<string>).data) as { start: number; text: string };
          buffer.append(d.text, d.start);
          onAppendRef.current();
        } catch {
          /* malformed chunk: the next one still arrives; polling covers a persistently broken stream */
        }
      });
      source.addEventListener("eof", () => {
        if (cancelled) return;
        buffer.markEnded();
        closeStream();
        publish("ended");
        onEndedRef.current();
      });
      source.addEventListener("error", (ev) => {
        if (cancelled) return;
        // A server-sent `event: error` carries data; the browser's connection error does not.
        const data = (ev as MessageEvent<string>).data;
        let detail = "stream connection lost";
        if (data) {
          try {
            const parsed = JSON.parse(data) as { error?: { message?: string } };
            detail = parsed.error?.message ?? "log stream error";
          } catch {
            detail = "log stream error";
          }
        }
        handleStreamFailure(detail);
      });
    };

    startStream();
    return () => {
      cancelled = true;
      closeStream();
      clearTimeout(reconnectTimer);
      clearTimeout(pollTimer);
      clearTimeout(streamRetryTimer);
    };
    // `hintKey` stands in for the hints object; `buffer` identity is stable (a ref-held LineBuffer).
  }, [enabled, paused, containerId, name, hintKey, buffer, nonce]);

  return { status, retry: () => setNonce((n) => n + 1) };
}
