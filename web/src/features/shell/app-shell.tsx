import { useRouter } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import type { NavPath } from "./nav";
import { Rail } from "./rail";
import { RailDrawer } from "./rail-drawer";
import { useShellHotkeys } from "./shortcuts";
import { Topbar } from "./topbar";

const CommandPalette = lazy(() => import("./command-palette").then((module) => ({ default: module.CommandPalette })));
const ShortcutsDialog = lazy(() => import("./shortcuts-dialog").then((module) => ({ default: module.ShortcutsDialog })));

/**
 * Route changes move focus to the page so keyboard and screen-reader users land on the new content. A drawer link is the
 * exception: the drawer closes and returns focus to its trigger, so the shell must not take focus back.
 */
function useRouteFocus({
  drawerNavigation,
  drawerTrigger,
}: {
  drawerNavigation: React.RefObject<NavPath | null>;
  drawerTrigger: React.RefObject<HTMLButtonElement | null>;
}) {
  const router = useRouter();
  useEffect(() => {
    let previousPathname = router.state.location.pathname;
    return router.subscribe("onResolved", ({ pathChanged, toLocation }) => {
      if (!pathChanged || previousPathname === toLocation.pathname) {
        drawerNavigation.current = null;
        return;
      }
      previousPathname = toLocation.pathname;
      const fromDrawer = drawerNavigation.current === toLocation.pathname;
      drawerNavigation.current = null;
      if (fromDrawer) {
        drawerTrigger.current?.focus({ preventScroll: true });
        return;
      }
      const main = document.getElementById("main-content");
      if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
    });
  }, [router, drawerNavigation, drawerTrigger]);
}

/**
 * The application chrome: rail, top bar, content region, palette and shortcut help. Rendered by the root route, so every
 * page gets it; pages own only their content inside `<main>`.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const drawerNavigation = useRef<NavPath | null>(null);
  const railTrigger = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  useShellHotkeys({ onPalette: () => setPaletteOpen(true), onHelp: () => setHelpOpen(true) });
  const openDrawer = () => {
    setDrawerMounted(true);
    setDrawerOpen(true);
  };
  const handleDrawerNavigate = (to: NavPath) => {
    // Only a real route change needs the drawer's focus handoff. Tapping the current page leaves focus where it is.
    drawerNavigation.current = router.state.location.pathname === to ? null : to;
  };
  useRouteFocus({ drawerNavigation, drawerTrigger: railTrigger });

  return (
    <div className={cn("flex h-svh min-h-0 flex-col overflow-hidden bg-ground text-ink", "md:flex-row")}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-toast focus:rounded-md focus:bg-fabric-2 focus:px-3 focus:py-2 focus:text-ink focus:shadow-(--shadow-overlay)"
      >
        Skip to main content
      </a>
      <Rail className="hidden md:flex" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar railTrigger={railTrigger} onOpenRail={openDrawer} onOpenPalette={() => setPaletteOpen(true)} />
        <main id="main-content" tabIndex={-1} className="burrow-main relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* The router preserves shared layouts; changing a leaf route must not remount its navigation or scrollports. */}
          <div className="burrow-page flex min-h-0 flex-1 flex-col">{children}</div>
        </main>
      </div>
      {drawerMounted && (
        <RailDrawer open={drawerOpen} onOpenChange={setDrawerOpen} returnFocus={railTrigger} onNavigate={handleDrawerNavigate} />
      )}
      {/* The palette stays mounted so Base UI can play both the entrance and the exit. Keeping it conditional
          unmounted it before the exit transition could run; the palette itself clears its query on close. */}
      <Suspense fallback={null}>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </Suspense>
      {/* the help sheet is rare, so it keeps its entrance *and* its exit: Base UI mounts the popup only while open,
          which means the root can stay mounted without rendering anything */}
      {helpOpen && (
        <Suspense fallback={null}>
          <ShortcutsDialog open onOpenChange={setHelpOpen} />
        </Suspense>
      )}
    </div>
  );
}
