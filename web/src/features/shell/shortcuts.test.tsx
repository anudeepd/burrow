import { afterEach, describe, expect, it, vi } from "vitest";

const registrations = vi.hoisted(() => ({
  hotkeys: [] as { hotkey: string; callback: () => void }[],
  sequences: [] as { keys: string[]; callback: () => void }[],
}));

vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkeys: (hotkeys: { hotkey: string; callback: () => void }[]) => {
    registrations.hotkeys = hotkeys;
  },
  useHotkeySequence: (keys: string[], callback: () => void) => {
    registrations.sequences.push({ keys, callback });
  },
}));

const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { useShellHotkeys } = await import("./shortcuts");

afterEach(() => {
  cleanup();
  registrations.hotkeys = [];
  registrations.sequences = [];
});

describe("shell keyboard shortcuts", () => {
  it("registers palette and help keys and navigates through each sequence", async () => {
    const onPalette = vi.fn();
    const onHelp = vi.fn();
    const root = createRootRoute();
    const home = createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => {
        useShellHotkeys({ onPalette, onHelp });
        return <div>Shortcuts mounted</div>;
      },
    });
    const routes = [
      createRoute({ getParentRoute: () => root, path: "/apps", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/scheduler", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/nodes", component: () => null }),
    ];
    const router = createRouter({
      routeTree: root.addChildren([home, ...routes]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("Shortcuts mounted")).toBeTruthy();

    registrations.hotkeys.find(({ hotkey }) => hotkey === "Mod+K")?.callback();
    registrations.hotkeys.find(({ hotkey }) => hotkey === "/")?.callback();
    registrations.hotkeys.find(({ hotkey }) => hotkey === "?")?.callback();
    expect(onPalette).toHaveBeenCalledTimes(2);
    expect(onHelp).toHaveBeenCalledOnce();

    for (const [keys, pathname] of [
      [["G", "A"], "/apps"],
      [["G", "S"], "/scheduler"],
      [["G", "N"], "/nodes"],
    ] as const) {
      const sequence = registrations.sequences.find((entry) => entry.keys.join("") === keys.join(""));
      expect(sequence).toBeTruthy();
      sequence!.callback();
      await waitFor(() => expect(router.state.location.pathname).toBe(pathname));
    }

    registrations.sequences.find((entry) => entry.keys.join("") === "GO")!.callback();
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.search).toMatchObject({ window: "all" });
  });
});
