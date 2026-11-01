import { expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { APP_ID, ATTEMPT_ID, RouterProvider, routerAt, setupRouteCoverage, serveFixtures } from "./app-route-coverage.setup";

setupRouteCoverage();

it("offers a retry when the RM loses an attempt list", async () => {
  const appId = APP_ID.replace(/0001$/, "0012");
  serveFixtures({
    [`/api/yarn/apps/${appId}/appattempts`]: new Response(JSON.stringify({ error: { message: "attempt list unavailable" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  });
  render(<RouterProvider router={routerAt(`/apps/${appId}/attempts/${ATTEMPT_ID}`)} />);

  expect(await screen.findByText("Could not load application attempts")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Retry now" }).at(-1)!);
});
