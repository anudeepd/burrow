/**
 * One presentation model for every request/runtime error.
 *
 * The UI only ever shows a one-line message plus an optional hint; anything technical (codes, upstream status, raw
 * envelope, schema issues, stack) goes into a copyable "Technical details" block. This keeps a multi-line Java
 * RemoteException or a JS stack trace out of the normal state without losing it.
 */
import { ApiError } from "~/api/client";

export interface ErrorSummary {
  /** First non-empty line of the error message. */
  message: string;
  hint?: string;
  /** Full technical payload: code/status/upstream/raw envelope/stack. */
  details: string;
}

/** The simple state is one line: a stack trace or a wrapped Java message must not leak into it. */
export function simpleErrorText(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return text.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Errors do not serialise their own fields, so normalise them (recursively) before stringifying. */
function serializable(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause === undefined ? undefined : serializable(value.cause, seen),
    };
  }
  if (Array.isArray(value)) return value.map((item) => serializable(item, seen));
  if (isRecord(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item, seen)]));
    seen.delete(value);
    return out;
  }
  return value;
}

function asJson(value: unknown): string {
  try {
    return JSON.stringify(serializable(value), null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Full technical payload, formatted for a monospace copyable block. */
export function errorDetails(error: unknown): string {
  if (error instanceof ApiError) {
    return asJson({
      name: error.name,
      message: error.message,
      kind: error.kind,
      status: error.status,
      code: error.code,
      upstream: error.upstream,
      hint: error.hint,
      response: error.responseMeta,
      body: error.body,
      stack: error.stack,
    });
  }
  if (error instanceof Error) return asJson(error);
  if (typeof error === "string") return error;
  return asJson(error);
}

/** Normalise anything a query/route can throw into the shared presentation model. */
export function describeError(error: unknown): ErrorSummary {
  if (error instanceof ApiError) {
    return {
      message: simpleErrorText(error.message) || "Unknown error",
      hint: error.hint ?? undefined,
      details: errorDetails(error),
    };
  }
  if (error instanceof Error) {
    return { message: simpleErrorText(error.message) || "Unknown error", details: errorDetails(error) };
  }
  const record = isRecord(error) ? error : null;
  const message = record && typeof record.message === "string" ? record.message : typeof error === "string" ? error : "";
  return {
    message: simpleErrorText(message) || "An unexpected error occurred",
    hint: record && typeof record.hint === "string" ? record.hint : undefined,
    details: errorDetails(error),
  };
}

/** Clipboard write that reports failure instead of throwing; callers show "Copy failed". */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
