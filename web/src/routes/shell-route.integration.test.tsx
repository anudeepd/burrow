import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRoute, createRouter } from "@tanstack/react-router";
import { routerAt, RouterProvider, serveFixtures } from "~/__tests__/route-test-utils";
import { parityStore } from "~/state/parity";
import { Route as RootRoute } from "./__root";

window.__BURROW_PARITY__ = true;

beforeEach(() => {
  parityStore.setState(() => ({ enabled: true }));
  serveFixtures();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  parityStore.setState(() => ({ enabled: false }));
});

describe("top-level route screens", () => {
  it("navigates the overview, applications, scheduler, node, and tools routes", async () => {
    const router = routerAt("/?window=unknown");
    render(<RouterProvider router={router} />);
    const navigate = async (path: string) =>
      act(async () => {
        await router.navigate({ to: path as never });
      });

    expect(await screen.findByTestId("overview")).toBeTruthy();
    await screen.findByTestId("identity");
    fireEvent.click(screen.getByTestId("history-window-5m"));
    await waitFor(() => expect(router.state.location.search.window).toBe("5m"));

    await navigate("/apps");
    expect(await screen.findByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(await screen.findByText("appdetail-long")).toBeTruthy();
    const appsTable = screen.getByRole("table", { name: "Applications" });
    fireEvent.click(appsTable.querySelector('[data-col="name"] button')!);
    await waitFor(() => expect(router.state.location.search.sort).toBeTruthy());
    fireEvent.click(appsTable.querySelectorAll('[role="row"]')[1]!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/apps\/[^/]+$/));

    await navigate("/scheduler");
    expect(await screen.findByRole("heading", { name: "Scheduler" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Activities" }));
    await waitFor(() => expect(router.state.location.search.tab).toBe("activities"));

    await navigate("/scheduler/root.default");
    expect(await screen.findByRole("heading", { name: "root.default" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Applications" }));
    await waitFor(() => expect(router.state.location.search.tab).toBe("apps"));

    await navigate("/nodes");
    expect(await screen.findByRole("table", { name: "Cluster nodes" })).toBeTruthy();

    await navigate("/node-labels");
    expect(await screen.findByRole("heading", { name: "Node labels" })).toBeTruthy();
    await navigate("/tools/conf");
    expect(await screen.findByRole("table", { name: "Configuration properties" })).toBeTruthy();

    await navigate("/tools/jmx");
    expect(await screen.findByText("Attributes")).toBeTruthy();

    await navigate("/tools/stacks");
    expect(await screen.findByText("Cannot read the thread dump")).toBeTruthy();
  });

  it("renders the root error boundary when a child route throws", async () => {
    const failingRoute = createRoute({
      getParentRoute: () => RootRoute,
      path: "/fails",
      component: () => {
        throw new Error("broken route fixture");
      },
    });
    const router = createRouter({
      routeTree: RootRoute.addChildren([failingRoute]),
      history: createMemoryHistory({ initialEntries: ["/fails"] }),
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "This view failed to render" })).toBeTruthy();
    expect(screen.getByText(/broken route fixture/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry now" })).toBeTruthy();
  });
});
