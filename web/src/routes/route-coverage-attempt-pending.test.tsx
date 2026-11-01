import { expect, it } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import {
  APP_ID,
  ATTEMPT_ID,
  queryClient,
  readRm,
  q,
  RouterProvider,
  routerAt,
  setupRouteCoverage,
  serveFixtures,
} from "./app-route-coverage.setup";

setupRouteCoverage();

it("keeps attempt details loading while their required list is pending", async () => {
  const appId = APP_ID.replace(/0001$/, "0014");
  let resolveAttempts: ((value: unknown) => void) | undefined;
  queryClient.setQueryData(q.app(appId).queryKey, readRm("app/running/app.json") as never);
  serveFixtures({
    [`/api/yarn/apps/${appId}/appattempts`]: () =>
      new Promise((resolve) => {
        resolveAttempts = resolve;
      }),
  });
  const view = render(<RouterProvider router={routerAt(`/apps/${appId}/attempts/${ATTEMPT_ID}`)} />);

  await waitFor(() => expect(resolveAttempts).toBeTypeOf("function"));
  expect(view.container.querySelector('[aria-busy="true"]')).toBeTruthy();
  view.unmount();
  await act(async () => resolveAttempts?.(readRm("app/running/appattempts.json")));
});
