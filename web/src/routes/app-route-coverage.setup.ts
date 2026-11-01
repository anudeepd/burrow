import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { queryClient, serveFixtures } from "~/__tests__/route-test-utils";
import { q } from "~/api/queries";
import { parityStore } from "~/state/parity";
import { setPrefs } from "~/state/prefs";

window.__BURROW_PARITY__ = false;

export function setupRouteCoverage() {
  beforeEach(() => {
    parityStore.setState(() => ({ enabled: false }));
    setPrefs({ motion: "reduced" });
    serveFixtures();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    parityStore.setState(() => ({ enabled: false }));
    setPrefs({ motion: "system" });
    document.documentElement.removeAttribute("data-motion");
  });
}

export function failQuery(queryKey: readonly unknown[], message: string, clearData = false) {
  const query = queryClient.getQueryCache().find({ queryKey });
  if (!query) throw new Error(`Missing query ${JSON.stringify(queryKey)}`);
  query.setState({
    ...query.state,
    ...(clearData ? { data: undefined } : {}),
    status: "error",
    error: new Error(message),
    errorUpdatedAt: Date.now(),
    errorUpdateCount: query.state.errorUpdateCount + 1,
    fetchStatus: "idle",
  });
}

export {
  APP_ID,
  ATTEMPT_ID,
  CONTAINER_ID,
  queryClient,
  readRm,
  RouterProvider,
  routerAt,
  serveFixtures,
} from "~/__tests__/route-test-utils";
export { q };
