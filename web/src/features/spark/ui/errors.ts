/**
 * Turning a Spark API failure into an honest, specific state.
 *
 * Three failure classes matter and must never be conflated:
 *  1. `backend-missing` — this Burrow build has no `/api/spark/*` routes at all (Rust backend returns
 *     `404 {"error":{"code":"not_found","message":"unknown API group '/api/spark'"}}`). The UI is fixture-verified only.
 *  2. `unavailable`     — routes exist but the data source does not (`503 unavailable`, e.g. a finished app with no
 *     Spark History Server configured, or a live app whose driver UI is gone). The contract's `hint` explains it.
 *  3. `not-found`       — the app/entity genuinely is not in the source (Spark's own 404).
 */
import { ApiError } from "~/api/client";

export type SparkFailureKind = "backend-missing" | "unavailable" | "not-found" | "unreachable" | "schema" | "other";

export interface SparkFailure {
  kind: SparkFailureKind;
  /** Short title for the state panel. */
  title: string;
  /** What happened, in the user's terms. */
  message: string;
  /** What to do about it. */
  hint?: string;
  /** Raw detail (upstream message / body) collapsed under the message. */
  detail?: string;
  status: number | null;
  code: string | null;
}

const BACKEND_MISSING_RE = /unknown api group|not implemented|no route/i;

export function classifySparkError(err: unknown, subject: string): SparkFailure {
  if (err instanceof ApiError) {
    const detailParts = [
      err.message,
      err.code,
      err.upstream ? `${err.upstream.url}${err.upstream.status ? ` → ${err.upstream.status}` : ""}` : null,
    ];
    const detail = detailParts.filter(Boolean).join(" · ");
    if (err.status === 404 && BACKEND_MISSING_RE.test(`${err.message} ${err.code ?? ""}`)) {
      return {
        kind: "backend-missing",
        title: "Spark API routes are not implemented by this backend build",
        message: `This Burrow binary has no \`/api/spark/*\` routes yet, so ${subject} cannot be fetched from the cluster. Nothing is faked: the view stays empty and says so.`,
        hint: "The Spark UI is verified against captured fixtures — run the fixture-backed dev server (`bun run dev:mock`) to explore every page, or use a build whose backend includes the Spark slice.",
        detail,
        status: err.status,
        code: err.code,
      };
    }
    if (err.status === 503 || err.code === "unavailable") {
      return {
        kind: "unavailable",
        title: "No Spark data source for this application",
        message: err.message || `The backend could not resolve a Spark REST source for ${subject}.`,
        hint: err.hint ?? "A finished application needs the Spark History Server; a live one needs the running driver's web proxy.",
        detail,
        status: err.status,
        code: err.code,
      };
    }
    if (err.status === 404) {
      return {
        kind: "not-found",
        title: "Not found in the Spark source",
        message: err.message || `Spark reports no ${subject}.`,
        hint: "It may have been evicted by the history server's retention limit, or belong to a different application attempt.",
        detail,
        status: err.status,
        code: err.code,
      };
    }
    if (err.isUnreachable) {
      return {
        kind: "unreachable",
        title: "The Spark source is unreachable",
        message: err.message,
        hint: err.hint ?? "Check the ResourceManager web proxy / Spark History Server and retry.",
        detail,
        status: err.status,
        code: err.code,
      };
    }
    return {
      kind: err.kind === "schema" ? "schema" : "other",
      title: err.kind === "schema" ? "Unexpected Spark payload shape" : "Spark request failed",
      message: err.message,
      hint: err.hint ?? undefined,
      detail,
      status: err.status,
      code: err.code,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "other", title: "Spark request failed", message, detail: message, status: null, code: null };
}

/** True when a `source` payload says the app has no usable Spark REST base (distinct from a route failure). */
export function sourceUnavailableReason(
  source: { available?: boolean | null; mode?: string | null; reason?: string | null } | null | undefined,
): string | null {
  if (!source) return null;
  if (source.available === false) return source.reason ?? "The backend resolved no Spark REST base for this application.";
  if (source.mode === "none" && !source.reason) return "No Spark REST base is available for this application.";
  return null;
}
