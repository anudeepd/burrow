import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchQueryOverride = vi.hoisted(() => ({
  enabled: false,
  data: undefined as unknown,
  error: undefined as unknown,
  refetch: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options: { queryKey: readonly unknown[]; enabled?: boolean }) => {
      const result = actual.useQuery(searchQueryOverride.enabled ? { ...options, enabled: false } : (options as never));
      return searchQueryOverride.enabled
        ? { data: searchQueryOverride.data, error: searchQueryOverride.error, refetch: searchQueryOverride.refetch }
        : result;
    },
  };
});

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { CommandPalette } = await import("./command-palette");

const apps = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/overview/apps.json"), "utf8")) as unknown;
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

function renderPalette(options: { appsError?: unknown; cachedApps?: boolean; open?: boolean } = {}) {
  const onOpenChange = vi.fn();
  const root = createRootRoute();
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <CommandPalette open={options.open ?? true} onOpenChange={onOpenChange} />,
  });
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
  if ("appsError" in options) {
    const query = client.getQueryCache().find({ queryKey: q.apps().queryKey })!;
    query.setState({
      ...query.state,
      data: options.cachedApps === false ? undefined : query.state.data,
      status: "error",
      error: options.appsError instanceof Error ? options.appsError : new Error(String(options.appsError)),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
  }
  return {
    onOpenChange,
    router,
    client,
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
  vi.unstubAllGlobals();
  searchQueryOverride.enabled = false;
  searchQueryOverride.data = undefined;
  searchQueryOverride.error = undefined;
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
    fireEvent.mouseEnter(filterOption);
    fireEvent.keyDown(input, { key: "x" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.click(filterOption);
    await waitFor(() => expect(router.state.location.pathname).toBe("/apps"));
    expect(router.state.location.search).toMatchObject({ name: "no-such-command-or-app" });
  });

  it("runs theme and live-update actions", async () => {
    const { prefsStore, setPrefs } = await import("~/state/prefs");
    setPrefs({ theme: "light", livePaused: false });
    const { client } = renderPalette();

    fireEvent.click(await screen.findByRole("option", { name: /Switch theme: dark/ }));
    await waitFor(() => expect(prefsStore.get().theme).toBe("dark"));
    fireEvent.click(await screen.findByRole("option", { name: /Switch theme: light/ }));
    await waitFor(() => expect(prefsStore.get().theme).toBe("light"));
    fireEvent.click(await screen.findByRole("option", { name: "Theme: follow system" }));
    await waitFor(() => expect(prefsStore.get().theme).toBe("system"));
    fireEvent.click(await screen.findByRole("option", { name: "Pause live updates" }));
    await waitFor(() => expect(prefsStore.get().livePaused).toBe(true));
    setPrefs({ livePaused: false, theme: "dark" });
    client.clear();
  });

  it("runs a built-in navigation result", async () => {
    const { router } = renderPalette();
    const input = await screen.findByRole("combobox", { name: "Search applications and commands" });
    fireEvent.change(input, { target: { value: "Scheduler" } });
    await waitFor(() => expect(document.getElementById("palette-nav:/scheduler")).not.toBeNull());
    const scheduler = document.getElementById("palette-nav:/scheduler");
    expect(scheduler).not.toBeNull();
    fireEvent.click(scheduler!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/scheduler"));
  });

  it("shows and retries a failed application lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ apps: { app: [] } }), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    renderPalette({ appsError: new Error("applications unavailable") });
    expect((await screen.findByRole("alert")).textContent).toContain("Application search refresh failed; showing cached results");
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("limits application results and reports a raw failure without cached apps", async () => {
    const { client } = renderPalette();
    const limitedApps = Array.from({ length: 25 }, (_, i) => ({
      id: `application_limit_${i}`,
      name: `Limit Match ${i}`,
      user: "tester",
      queue: "root.default",
      state: "RUNNING",
    }));
    client.setQueryData(q.apps().queryKey, { apps: { app: limitedApps } } as never);
    const input = await screen.findByRole("combobox", { name: "Search applications and commands" });
    fireEvent.change(input, { target: { value: "limit match" } });
    expect(await screen.findAllByRole("option", { name: /Limit Match/ })).toHaveLength(24);

    cleanup();
    searchQueryOverride.enabled = true;
    searchQueryOverride.data = undefined;
    searchQueryOverride.error = "raw lookup failure";
    renderPalette();
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load applications for search");
    expect(screen.getByRole("alert").textContent).toContain("raw lookup failure");
  });

  it("skips result scrolling while the palette is closed", () => {
    renderPalette({ open: false });
    expect(screen.queryByRole("combobox", { name: "Search applications and commands" })).toBeNull();
  });
});
