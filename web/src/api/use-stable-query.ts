import {
  hashKey,
  useQuery,
  type DefaultError,
  type DefinedInitialDataOptions,
  type DefinedUseQueryResult,
  type QueryClient,
  type QueryKey,
  type UndefinedInitialDataOptions,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useRef } from "react";
import { useStableError } from "./use-stable-error";

/**
 * `useQuery` whose failure survives the refetch React Query starts when a query has no cached data.
 *
 * React Query resets `error -> null` and `status -> pending` on that refetch, so every error panel gated on `error`
 * unmounts on each poll and any expanded disclosure inside it is lost. Keeping the last failure (and its error status)
 * until a request succeeds makes the panel and its controls stable while `isFetching` still reports the retry.
 * Query-key identity is used, so a new app, filter or attempt starts clean.
 */
export function useStableQuery<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(
  options: DefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey>,
  queryClient?: QueryClient,
): DefinedUseQueryResult<TData, TError>;
export function useStableQuery<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(
  options: UndefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey>,
  queryClient?: QueryClient,
): UseQueryResult<TData, TError>;
export function useStableQuery<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  queryClient?: QueryClient,
): UseQueryResult<TData, TError>;
export function useStableQuery<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  queryClient?: QueryClient,
): UseQueryResult<TData, TError> {
  const result = useQuery<TQueryFnData, TError, TData, TQueryKey>(options, queryClient);
  const error = useStableError(result, options.queryKey);
  return withStableError(result, error);
}

type QuerySnapshot = {
  data: unknown;
  error: unknown;
  status: string;
  isError: boolean;
  isPending: boolean;
  isLoading: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
};

function withStableError<T extends QuerySnapshot>(query: T, error: unknown): T {
  if (error == null || error === query.error) return query;
  return {
    ...query,
    error,
    status: "error",
    isError: true,
    isPending: false,
    isLoading: false,
    isLoadingError: query.data === undefined,
    isRefetchError: query.data !== undefined,
  } as T;
}

/** `useQueries` for a list of same-shaped results, with the same no-data-refetch guarantee as {@link useStableQuery}. */
export function useStableQueries<T extends QuerySnapshot>(queries: readonly T[], keys: readonly QueryKey[]): T[] {
  const last = useRef(new Map<string, unknown>());
  return queries.map((query, index) => {
    const id = hashKey(keys[index]!);
    if (query.error != null) last.current.set(id, query.error);
    else if (query.status === "success") last.current.delete(id);
    return withStableError(query, query.error ?? last.current.get(id) ?? null);
  });
}
