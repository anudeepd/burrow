import { expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { APP_ID, q, queryClient, RouterProvider, routerAt, setupRouteCoverage, serveFixtures } from "./app-route-coverage.setup";

setupRouteCoverage();

it("shows and retries unavailable attempt history beside a loaded overview", async () => {
  const appId = APP_ID.replace(/0001$/, "0010");
  serveFixtures({
    [`/api/yarn/apps/${appId}/appattempts`]: new Response(JSON.stringify({ error: { message: "attempts unavailable" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  });
  render(<RouterProvider router={routerAt(`/apps/${appId}`)} />);

  expect(await screen.findByText("Application attempt history unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  await waitFor(() => expect(queryClient.getQueryState(q.appAttempts(appId).queryKey)?.fetchStatus).toBe("idle"));
});
