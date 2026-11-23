import { useLocation } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { Rail } from "./rail";
import { RailDrawer } from "./rail-drawer";
import { useShellHotkeys } from "./shortcuts";
import { Topbar } from "./topbar";

const CommandPalette = lazy(() => import("./command-palette").then((module) => ({ default: module.CommandPalette })));
const ShortcutsDialog = lazy(() => import("./shortcuts-dialog").then((module) => ({ default: module.ShortcutsDialog })));

/**
 * The application chrome: rail, top bar, content region, palette and shortcut help. Rendered by the root route, so every
 * page gets it; pages own only their content inside `<main>`.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const railTrigger = useRef<HTMLButtonElement>(null);
  useShellHotkeys({ onPalette: () => setPaletteOpen(true), onHelp: () => setHelpOpen(true) });
  const openDrawer = () => {
    setDrawerMounted(true);
    setDrawerOpen(true);
  };
  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    const main = document.getElementById("main-content");
    if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
  }, [pathname]);

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
      {drawerMounted && <RailDrawer open={drawerOpen} onOpenChange={setDrawerOpen} returnFocus={railTrigger} />}
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
