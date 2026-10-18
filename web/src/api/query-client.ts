import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";
import { isParity } from "~/state/parity";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // a 404 (unknown app) is an answer, not a transient failure; everything else gets two quick retries
        retry: (count, err) =>
          !(err instanceof ApiError && (err.status === 404 || err.kind === "schema" || err.kind === "abort")) && count < 2,
        retryDelay: (n) => Math.min(1000 * 2 ** n, 4000),
        // SSR's prerender client must not keep the Vite process alive for the browser cache's five-minute GC timer.
        gcTime: typeof window === "undefined" ? Number.POSITIVE_INFINITY : 5 * 60_000,
        structuralSharing: true,
        refetchOnReconnect: !isParity(),
      },
    },
  });
}
