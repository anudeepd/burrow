import { createMemoryHistory, createRoute, createRouter } from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RouterProvider } from "~/__tests__/route-test-utils";
import { ApplicationSectionNav } from "./apps/$appId";
import { Route as RootRoute } from "./__root";
import { setupRouteCoverage } from "./app-route-coverage.setup";

setupRouteCoverage();

describe("application section navigation fallbacks", () => {
  it("renders unavailable tabs with and without a hint, including the selected tab", async () => {
    const navRoute = createRoute({
      getParentRoute: () => RootRoute,
      path: "/coverage-nav",
      component: () => (
        <ApplicationSectionNav
          tabs={[
            { value: "spark", label: "Spark", href: "/apps/$appId/spark/jobs", available: false, hint: "Spark is omitted" },
            { value: "future", label: "Future", href: "/future", available: false },
          ]}
          current="spark"
        />
      ),
    });
    const router = createRouter({
      routeTree: RootRoute.addChildren([navRoute]),
      history: createMemoryHistory({ initialEntries: ["/coverage-nav"] }),
    });
    render(<RouterProvider router={router} />);

    const nav = await screen.findByRole("navigation", { name: "Application sections" });
    expect(nav.querySelector('[data-yt="spark"]')?.getAttribute("aria-current")).toBe("page");
    expect(nav.querySelector('[data-yt="future"]')?.getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About Spark tab is unavailable" }));
    expect(await screen.findByText("Spark is omitted")).toBeTruthy();
    expect(screen.getAllByText("not in build")).toHaveLength(2);
  });
});
