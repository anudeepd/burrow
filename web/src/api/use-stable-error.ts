import { hashKey, type QueryKey } from "@tanstack/react-query";
import { useRef } from "react";

/** Query keys are rebuilt on every render; compare them by value so the stored error follows the data view. */
function identityOf(key: unknown): unknown {
  return Array.isArray(key) ? hashKey(key as QueryKey) : key;
}

/**
 * React Query clears `error` and returns to `pending` at the start of a refetch when the query has no cached data.
 * An error banner bound directly to `query.error` therefore disappears and reappears on every retry. Keep the last
 * observed error until the query succeeds or its identity (e.g. the app id) changes.
 */
export function useStableError(query: { error: unknown; status: "pending" | "error" | "success" }, key?: unknown): unknown {
  const id = identityOf(key);
  const last = useRef<{ key: unknown; error: unknown }>({ key: id, error: null });
  if (!Object.is(last.current.key, id)) last.current = { key: id, error: null };
  if (query.error != null) last.current.error = query.error;
  else if (query.status === "success") last.current.error = null;
  return query.error ?? last.current.error;
}
