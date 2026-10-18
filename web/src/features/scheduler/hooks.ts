/** One shape for every fetch on this page: loading · error · stale (cached data while the upstream is failing) · retry. */
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "~/api/client";

export interface Remote<T> {
  data: T | undefined;
  loading: boolean;
  /** true while the query is fetching initial or refreshed data */
  fetching: boolean;
  error: ApiError | Error | null;
  /** true when we have data AND the last refresh failed (the backend serves stale on upstream failure) */
  stale: boolean;
  retry: () => void;
}

export function useRemote<T>(q: UseQueryResult<T, Error>): Remote<T> {
  const error = q.error ?? null;
  return {
    data: q.data,
    loading: q.isPending,
    fetching: q.isFetching,
    error,
    stale: !!error && q.data !== undefined,
    retry: () => void q.refetch(),
  };
}

/** Human-facing error text + the actionable hint the API envelope carries. */
export function errorInfo(e: ApiError | Error | null): { title: string; message: string; hint?: string; detail?: string } {
  if (!e) return { title: "Something went wrong", message: "No error detail was provided." };
  if (e instanceof ApiError) {
    return {
      title:
        e.kind === "schema"
          ? "Unexpected response shape"
          : e.isUnreachable
            ? "Cannot reach the ResourceManager"
            : "The ResourceManager returned an error",
      message: e.message,
      hint: e.hint ?? undefined,
      detail: e.upstream ? `${e.upstream.url}${e.upstream.status ? ` → HTTP ${e.upstream.status}` : ""}` : undefined,
    };
  }
  return { title: "Request failed", message: e.message };
}
