import { expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { APP_ID, q, queryClient, RouterProvider, routerAt, setupRouteCoverage } from "./app-route-coverage.setup";

setupRouteCoverage();

it("shows stale attempt banners, retries, and saves expanded columns", async () => {
  const appId = APP_ID.replace(/0001$/, "0017");
  const router = routerAt(`/apps/${appId}/attempts?cols=appAttemptId`);
  render(<RouterProvider router={router} />);
  const table = await screen.findByRole("table", { name: "Application attempts" });
  await waitFor(() => expect(queryClient.getQueryData(q.appAttempts(appId).queryKey)).toBeDefined());

  act(() => {
    const app = queryClient.getQueryCache().find({ queryKey: q.app(appId).queryKey })!;
    const attempts = queryClient.getQueryCache().find({ queryKey: q.appAttempts(appId).queryKey })!;
    app.setState({
      ...app.state,
      status: "error",
      error: new Error("application summary refresh failed"),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });
    attempts.setState({
      ...attempts.state,
      status: "error",
      error: new Error("attempt list refresh failed"),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });
  });
  expect(await screen.findByText("Application summary refresh failed; attempts remain available")).toBeTruthy();
  expect(await screen.findByText("Attempt refresh failed; showing the last loaded attempts")).toBeTruthy();
  for (const retry of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(retry);
  await waitFor(() => {
    expect(queryClient.getQueryState(q.app(appId).queryKey)?.fetchStatus).toBe("idle");
    expect(queryClient.getQueryState(q.appAttempts(appId).queryKey)?.fetchStatus).toBe("idle");
  });

  fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
  expect(router.state.location.search.cols).toBe("all");
  expect(table.querySelector('[data-col="appAttemptId"]')).toBeTruthy();
});
