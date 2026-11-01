import { expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { APP_ID, q, queryClient, RouterProvider, routerAt, setupRouteCoverage } from "./app-route-coverage.setup";

setupRouteCoverage();

it("retries stale app and attempt data on the overview", async () => {
  const appId = APP_ID.replace(/0001$/, "0016");
  render(<RouterProvider router={routerAt(`/apps/${appId}`)} />);
  expect(await screen.findByRole("heading", { name: "appdetail-long" })).toBeTruthy();
  await waitFor(() => expect(queryClient.getQueryData(q.appAttempts(appId).queryKey)).toBeDefined());

  act(() => {
    const app = queryClient.getQueryCache().find({ queryKey: q.app(appId).queryKey })!;
    const attempts = queryClient.getQueryCache().find({ queryKey: q.appAttempts(appId).queryKey })!;
    app.setState({
      ...app.state,
      status: "error",
      error: new Error("application refresh failed"),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });
    attempts.setState({
      ...attempts.state,
      status: "error",
      error: new Error("attempt history refresh failed"),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });
  });
  expect(await screen.findByText("Application refresh failed; showing the last loaded details")).toBeTruthy();
  expect(await screen.findByText("Attempt history refresh failed; showing the last loaded attempts")).toBeTruthy();
  for (const retry of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(retry);
  await waitFor(() => {
    expect(queryClient.getQueryState(q.app(appId).queryKey)?.fetchStatus).toBe("idle");
    expect(queryClient.getQueryState(q.appAttempts(appId).queryKey)?.fetchStatus).toBe("idle");
  });
});
