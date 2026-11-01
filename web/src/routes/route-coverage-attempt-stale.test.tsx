import { expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { APP_ID, ATTEMPT_ID, q, queryClient, RouterProvider, routerAt, setupRouteCoverage } from "./app-route-coverage.setup";

setupRouteCoverage();

it("retries an attempt-history refresh while keeping the selected attempt visible", async () => {
  const appId = APP_ID.replace(/0001$/, "0018");
  render(<RouterProvider router={routerAt(`/apps/${appId}/attempts/${ATTEMPT_ID}`)} />);
  expect(await screen.findByText("Attempt 1")).toBeTruthy();
  act(() => {
    const attempts = queryClient.getQueryCache().find({ queryKey: q.appAttempts(appId).queryKey })!;
    attempts.setState({
      ...attempts.state,
      status: "error",
      error: new Error("attempt history refresh failed"),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });
  });
  expect(await screen.findByText("Attempt list refresh failed; showing the last loaded attempt")).toBeTruthy();
  for (const retry of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(retry);
  await waitFor(() => expect(queryClient.getQueryState(q.appAttempts(appId).queryKey)?.fetchStatus).toBe("idle"));
});
