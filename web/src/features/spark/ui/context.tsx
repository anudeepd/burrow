/**
 * Spark application context: resolved per YARN app id by the `spark/route.tsx` layout and consumed by every Spark page.
 *
 * It carries what pages cannot re-derive cheaply (source resolution, Spark application metadata, whether the app is live)
 * plus the resolved refetch kind, so pages pick the same poll policy as the shell.
 */
import { createContext, useContext } from "react";
import type { RefetchKind } from "~/api/refetch";
import type { SparkApplication, SparkSource } from "../data/schemas";

export interface SparkContextValue {
  appId: string;
  /** "live" (driver proxy, polled) or "static" (history server / finished app, fetched once). */
  kind: RefetchKind;
  /** Spark application id reported by the source (usually the same as the YARN app id). */
  sparkAppId: string;
  /** Attempt selector value (`attempts[]` attemptId, else the index) or null for the latest attempt. */
  attempt: string | null;
  source: SparkSource | null;
  application: SparkApplication | null;
  /** True while the source/application resolution is still in flight. */
  resolving: boolean;
}

/** Resolve the version using the same attempt → source attempt → first attempt precedence as the Spark header. */
export function sparkVersionForSelection(
  application: SparkApplication | null,
  attempt: string | null,
  sourceAttempt: string | null,
): string | null {
  const attempts = application?.attempts ?? [];
  const find = (value: string | null) =>
    value == null ? undefined : attempts.find((candidate, index) => (candidate.attemptId ?? String(index)) === value);
  return (find(attempt) ?? find(sourceAttempt) ?? attempts[0])?.appSparkVersion ?? null;
}

const Ctx = createContext<SparkContextValue | null>(null);

export const SparkProvider = Ctx.Provider;

export function useSpark(): SparkContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSpark() used outside the Spark layout route (routes/apps/$appId/spark/route.tsx)");
  return v;
}
