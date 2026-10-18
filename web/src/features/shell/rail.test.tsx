/**
 * The shell must render the same tree on the server and on the client's first paint.
 *
 * The server renders the shell (TanStack Start prerenders it and serves that HTML for every route) before it can read
 * `localStorage`; the client's first render *does* read prefs. Any pref that changes the markup or the text — not just an
 * attribute — makes React give up on hydration (error #418: the tree is thrown away and rebuilt, and the console shows an
 * uncaught error on every load). That is exactly what `railCollapsed: true` used to do: the collapsed rail unmounted its
 * labels, badges, wordmark and footer text.
 *
 * This test pins the invariant: the rail's element structure is identical whatever the prefs say. The visual state is
 * allowed to differ (classes, `data-collapsed`, the rail's width) — React patches those silently.
 */
import { render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The rail only needs its *shape* here: the queries, the connection store and the router link are stubbed. */
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined }),
}));
vi.mock("~/api/connection", () => ({
  useConnection: (select: (s: { consecutiveFailures: number; lastCache: string | null }) => unknown) =>
    select({ consecutiveFailures: 0, lastCache: null }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => createElement("a", rest, children),
  useLocation: () => ({ pathname: "/" }),
}));

const { Rail } = await import("./rail");
const { setPrefs } = await import("~/state/prefs");

/** Every element, in document order, by tag — sensitive to structure, blind to class names. */
function signature(root: HTMLElement): string {
  return [...root.querySelectorAll("*")].map((el) => el.tagName.toLowerCase()).join(",");
}

function text(root: HTMLElement): string {
  return (root.textContent ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  setPrefs({ railCollapsed: false });
});

describe("rail hydration shape", () => {
  it("renders the same structure whether the rail is collapsed or not", () => {
    setPrefs({ railCollapsed: false });
    const expanded = render(<Rail />).container as HTMLElement;
    const expandedSignature = signature(expanded);

    setPrefs({ railCollapsed: true });
    const collapsed = render(<Rail />).container as HTMLElement;

    expect(signature(collapsed)).toBe(expandedSignature);
    // the labels keep existing (hidden by `[data-collapsed="true"] .burrow-rail-collapsible`, never unmounted)
    expect(text(collapsed)).toContain("Applications");
    expect(collapsed.querySelector("[data-testid='rail']")?.getAttribute("data-collapsed")).toBe("true");
    // and the pre-paint hook is mirrored so the first painted frame is already collapsed
    expect(document.documentElement.getAttribute("data-rail-collapsed")).toBe("true");
  });

  it("keeps the drawer variant expanded (it is client-only, so its own shape is free)", () => {
    setPrefs({ railCollapsed: true });
    const drawer = render(<Rail inDrawer />).container as HTMLElement;
    const rail = drawer.querySelector("[data-testid='rail']");
    expect(rail?.getAttribute("data-collapsed")).toBe("false");
    // the drawer is closed, never collapsed: labels are present and there is no collapse control inside it
    expect(text(drawer)).toContain("Applications");
    expect(drawer.querySelector("button[aria-label*='navigation' i]")).toBeNull();
  });
});
