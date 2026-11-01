import { expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  APP_ID,
  ATTEMPT_ID,
  CONTAINER_ID,
  failQuery,
  q,
  queryClient,
  readRm,
  RouterProvider,
  routerAt,
  setupRouteCoverage,
} from "./app-route-coverage.setup";

setupRouteCoverage();

it("retries a missing container and a stale container refresh", async () => {
  const appId = APP_ID.replace(/0001$/, "0013");
  queryClient.setQueryData(q.app(appId).queryKey, readRm("app/running/app.json") as never);
  queryClient.setQueryData(q.appAttempts(appId).queryKey, readRm("app/running/appattempts.json") as never);
  queryClient.setQueryData(q.appContainer(appId, ATTEMPT_ID, CONTAINER_ID).queryKey, {
    container: readRm(`app/running/container-${ATTEMPT_ID}-${CONTAINER_ID}.json`) as never,
  });
  render(<RouterProvider router={routerAt(`/apps/${appId}/containers/${CONTAINER_ID}`)} />);
  expect(await screen.findByRole("heading", { name: `Container ${CONTAINER_ID}` })).toBeTruthy();
  act(() => failQuery(q.appContainer(appId, ATTEMPT_ID, CONTAINER_ID).queryKey, "container detail missing", true));
  expect(await screen.findByText("Could not load the container")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  await waitFor(() => expect(queryClient.getQueryData(q.appContainer(appId, ATTEMPT_ID, CONTAINER_ID).queryKey)).toBeDefined());

  act(() => failQuery(q.appContainer(appId, ATTEMPT_ID, CONTAINER_ID).queryKey, "container detail refresh failed"));
  expect(await screen.findByText("Container refresh failed; showing the last loaded details")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
});
