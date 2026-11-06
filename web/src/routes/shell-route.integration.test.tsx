import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRoute, createRouter } from "@tanstack/react-router";
import { renderRootDocument, routerAt, RouterProvider, serveFixtures } from "~/__tests__/route-test-utils";
import { parityStore } from "~/state/parity";
import { Route as RootRoute } from "./__root";

window.__BURROW_PARITY__ = true;
let restoreRouteWarning: (() => void) | undefined;
let restoreRouteBoundaryError: (() => void) | undefined;

function muteExpectedRouteMatchWarning() {
  const warn = console.warn;
  const spy = vi.spyOn(console, "warn").mockImplementation((...args) => {
    // TanStack Router warns when its error boundary catches these deliberately thrown route fixtures.
    // Keep all unrelated warnings visible; only the known expected route-match warning is omitted.
    if (args[0] === "Warning: Error in route match: __root__/") return;
    warn(...args);
  });
  restoreRouteWarning = () => spy.mockRestore();
}
function muteExpectedRouteBoundaryError() {
  const error = console.error;
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
    const message = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ");
    if (message.includes("broken route fixture")) return;
    if (message.includes("The above error occurred in the <")) return;
    if (message.includes("React will try to recreate this component tree")) return;
    error(...args);
  });
  restoreRouteBoundaryError = () => spy.mockRestore();
}

beforeEach(() => {
  parityStore.setState(() => ({ enabled: true }));
  serveFixtures();
});
afterEach(() => {
  cleanup();
  restoreRouteWarning?.();
  restoreRouteWarning = undefined;
  restoreRouteBoundaryError?.();
  restoreRouteBoundaryError = undefined;
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
    muteExpectedRouteBoundaryError();
    muteExpectedRouteMatchWarning();
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

  it("stringifies a non-Error thrown from a child route", async () => {
    muteExpectedRouteBoundaryError();
    muteExpectedRouteMatchWarning();
    const failingRoute = createRoute({
      getParentRoute: () => RootRoute,
      path: "/fails-raw",
      component: () => {
        throw "broken route fixture";
      },
    });
    const router = createRouter({
      routeTree: RootRoute.addChildren([failingRoute]),
      history: createMemoryHistory({ initialEntries: ["/fails-raw"] }),
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText(/broken route fixture/)).toBeTruthy();
  });

  it("renders the root document shell when no browser document exists", async () => {
    vi.stubGlobal("document", undefined);
    try {
      const router = routerAt("/");
      await router.load();
      const html = renderRootDocument(router);
      expect(html).toContain("<html");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
