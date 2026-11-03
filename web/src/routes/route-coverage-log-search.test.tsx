import { expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { APP_ID, CONTAINER_ID, RouterProvider, routerAt, setupRouteCoverage } from "./app-route-coverage.setup";

setupRouteCoverage();

it("parses container-log search parameters for a shared link", async () => {
  const router = routerAt(`/apps/${APP_ID}/logs?container=${CONTAINER_ID}&tail=1&follow=0&ts=relative`);
  render(<RouterProvider router={router} />);

  await waitFor(() => expect(router.state.location.pathname).toBe(`/apps/${APP_ID}/logs`));
  expect(await screen.findByRole("heading", { name: "appdetail-long" })).toBeTruthy();
  expect(router.state.location.search).toEqual(
    expect.objectContaining({
      container: CONTAINER_ID,
      tail: 1,
      follow: false,
      ts: "relative",
    }),
  );
});
