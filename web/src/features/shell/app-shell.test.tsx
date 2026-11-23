import { afterEach, describe, expect, it, vi } from "vitest";

const shellHotkeys = vi.hoisted(() => ({
  current: null as null | { onPalette: () => void; onHelp: () => void },
}));

vi.mock("./rail", () => ({ Rail: () => <nav aria-label="Desktop navigation" /> }));
vi.mock("./topbar", () => ({
  Topbar: ({ onOpenRail, onOpenPalette }: { onOpenRail: () => void; onOpenPalette: () => void }) => (
    <header>
      <button type="button" onClick={onOpenRail}>
        Open navigation
      </button>
      <button type="button" onClick={onOpenPalette}>
        Open command palette
      </button>
      <button type="button" onClick={() => shellHotkeys.current?.onPalette()}>
        Open palette shortcut
      </button>
      <button type="button" onClick={() => shellHotkeys.current?.onHelp()}>
        Open keyboard shortcuts
      </button>
    </header>
  ),
}));
vi.mock("./shortcuts", () => ({
  useShellHotkeys: (callbacks: NonNullable<typeof shellHotkeys.current>) => {
    shellHotkeys.current = callbacks;
  },
}));
vi.mock("./rail-drawer", () => ({
  RailDrawer: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div role="dialog" aria-label="Navigation">
        <button type="button" onClick={() => onOpenChange(false)}>
          Close navigation
        </button>
      </div>
    ) : null,
}));
vi.mock("./command-palette", () => ({
  CommandPalette: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div role="dialog" aria-label="Command palette">
        <button type="button" onClick={() => onOpenChange(false)}>
          Close command palette
        </button>
      </div>
    ) : null,
}));
vi.mock("./shortcuts-dialog", () => ({
  ShortcutsDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div role="dialog" aria-label="Keyboard shortcuts">
        <button type="button" onClick={() => onOpenChange(false)}>
          Close keyboard shortcuts
        </button>
      </div>
    ) : null,
}));

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } = await import(
  "@tanstack/react-router"
);
const { AppShell } = await import("./app-shell");

afterEach(() => {
  cleanup();
  shellHotkeys.current = null;
});

function renderShell() {
  const root = createRootRoute({
    component: () => (
      <AppShell>
        <Outlet />
      </AppShell>
    ),
  });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <div>
        Shell content
        <Link to="/apps">Open apps</Link>
      </div>
    ),
  });
  const apps = createRoute({
    getParentRoute: () => root,
    path: "/apps",
    component: () => <div>Apps content</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, apps]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("AppShell overlays", () => {
  it("exposes a skip link that targets the main content", async () => {
    renderShell();
    expect(await screen.findByText("Shell content")).toBeTruthy();
    const skip = screen.getByRole("link", { name: "Skip to main content" }) as HTMLAnchorElement;
    const main = document.getElementById("main-content");
    expect(skip.getAttribute("href")).toBe("#main-content");
    expect(main?.getAttribute("tabindex")).toBe("-1");
  });

  it("moves focus to the main content after a route change", async () => {
    renderShell();
    expect(await screen.findByText("Shell content")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Open apps" }));
    expect(await screen.findByText("Apps content")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("main-content")));
  });

  it("mounts and closes the navigation drawer and command palette", async () => {
    renderShell();
    expect(await screen.findByText("Shell content")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(await screen.findByRole("dialog", { name: "Navigation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close command palette" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open palette shortcut" }));
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close command palette" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open keyboard shortcuts" }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close keyboard shortcuts" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull());
  });
});
