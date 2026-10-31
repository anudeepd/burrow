import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { CommandPalette } = await import("./command-palette");

const apps = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/overview/apps.json"), "utf8")) as unknown;
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

function renderPalette() {
  const onOpenChange = vi.fn();
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <CommandPalette open onOpenChange={onOpenChange} /> });
  const appsRoute = createRoute({ getParentRoute: () => root, path: "/apps", component: () => null });
  const app = createRoute({ getParentRoute: () => appsRoute, path: "$appId", component: () => null });
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/scheduler", component: () => null }),
    createRoute({ getParentRoute: () => root, path: "/nodes", component: () => null }),
    createRoute({ getParentRoute: () => root, path: "/node-labels", component: () => null }),
    createRoute({ getParentRoute: () => root, path: "/tools/$page", component: () => null }),
  ];
  const router = createRouter({
    routeTree: root.addChildren([home, appsRoute.addChildren([app]), ...routes]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(q.apps().queryKey, apps as never);
  return {
    onOpenChange,
    router,
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (scrollDescriptor) Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
  else delete (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView;
});

describe("command palette", () => {
  it("filters cached applications and opens the selected match with arrow keys and Enter", async () => {
    const { onOpenChange, router } = renderPalette();
    const input = await screen.findByRole("combobox", { name: "Search applications and commands" });
    expect(screen.getByRole("option", { name: /Applications Every YARN application/ })).toBeTruthy();

    fireEvent.change(input, { target: { value: "ys-smoke" } });
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(router.state.location.pathname).toContain("/apps/application_"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("offers a filter for unmatched app names and Escape closes the palette", async () => {
    const { onOpenChange, router } = renderPalette();
    const input = await screen.findByRole("combobox", { name: "Search applications and commands" });
    fireEvent.change(input, { target: { value: "no-such-command-or-app" } });
    const filterOption = await screen.findByRole("option", { name: /Applications named/ });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.click(filterOption);
    await waitFor(() => expect(router.state.location.pathname).toBe("/apps"));
    expect(router.state.location.search).toMatchObject({ name: "no-such-command-or-app" });
  });
});
