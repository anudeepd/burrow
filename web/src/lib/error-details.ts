/**
 * One presentation model for every request/runtime error.
 *
 * The UI only ever shows a one-line message plus an optional hint; anything technical (codes, upstream status, raw
 * envelope, schema issues, stack) goes into a copyable "Technical details" block. This keeps a multi-line Java
 * RemoteException or a JS stack trace out of the normal state without losing it.
 */
import { ApiError } from "~/api/client";

export interface ErrorSummary {
  /** One-line human summary; never a stack frame, Java class, or raw HTML. */
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

/**
 * A human error message names the failure. A technical payload starts with a Java/Python/JavaScript exception,
 * a stack frame, an HTML page, or a raw error envelope, and must not become the visible summary.
 */
export function isTechnicalErrorText(text: string): boolean {
  const line = simpleErrorText(text);
  return (
    /\b(?:java|javax|jdk|sun|com\.sun|org\.apache|com\.[a-z][\w$]*)\.[\w.$]+/.test(line) ||
    /^\s*at\s+[^(]+\(/.test(line) ||
    /^(?:Caused by:\s*)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:Exception|Error)\b\s*:/.test(line) ||
    /^(?:Exception in thread\b|Traceback \(most recent call last\):|panic:)/.test(line) ||
    /^\s*(?:<!DOCTYPE\b|<html\b|<body\b|<head\b|<h1\b|<pre\b)/i.test(line) ||
    /^\s*\{\s*"(?:error|RemoteException)"\s*:/.test(line) ||
    /\bRemoteException\b/.test(line)
  );
}

/** The human fallback for a technical payload. The operation title supplies the specific context. */
function technicalSummary(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === "network") return "The upstream service could not be reached.";
    if (error.kind === "timeout") return "The upstream service did not respond in time.";
    if (error.kind === "abort") return "The request was cancelled.";
    if (error.kind === "schema") return "The upstream response did not match the expected shape.";
    if (error.status != null) return `The upstream service returned HTTP ${error.status}.`;
  }
  return "The request failed.";
}

/** First line when it is human, otherwise a short summary. The raw payload is always in `details`. */
function summarizedMessage(error: unknown, raw: string, fallback: string): string {
  if (!raw) return fallback;
  return isTechnicalErrorText(raw) ? technicalSummary(error) : raw;
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
    const raw = simpleErrorText(error.message);
    return {
      message: summarizedMessage(error, raw, "Unknown error"),
      hint: error.hint ?? undefined,
      details: errorDetails(error),
    };
  }
  if (error instanceof Error) {
    const raw = simpleErrorText(error.message);
    return { message: summarizedMessage(error, raw, "Unknown error"), details: errorDetails(error) };
  }
  const record = isRecord(error) ? error : null;
  const raw = simpleErrorText(record && typeof record.message === "string" ? record.message : typeof error === "string" ? error : "");
  return {
    message: summarizedMessage(error, raw, "An unexpected error occurred"),
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
