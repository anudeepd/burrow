import { useLocation } from "@tanstack/react-router";
import { lazy, Suspense, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { Rail } from "./rail";
import { useShellHotkeys } from "./shortcuts";
import { Topbar } from "./topbar";

const CommandPalette = lazy(() => import("./command-palette").then((module) => ({ default: module.CommandPalette })));
const ShortcutsDialog = lazy(() => import("./shortcuts-dialog").then((module) => ({ default: module.ShortcutsDialog })));
const RailDrawer = lazy(() => import("./rail-drawer").then((module) => ({ default: module.RailDrawer })));

/**
 * The application chrome: rail, top bar, content region, palette and shortcut help. Rendered by the root route, so every
 * page gets it; pages own only their content inside `<main>`.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
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

  const { pathname } = useLocation();
  const suppressPageEntrance = pathname === "/nodes" || pathname.startsWith("/nodes/");

  return (
    <div className={cn("flex h-dvh min-h-0 flex-col overflow-hidden bg-ground text-ink", "md:flex-row")}>
      <Rail className="hidden md:flex" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar railTrigger={railTrigger} onOpenRail={openDrawer} onOpenPalette={() => setPaletteOpen(true)} />
        <main className="burrow-main relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Keyed by pathname: the title swaps immediately, then coarse content groups cascade in; rows never move. */}
          <div
            key={pathname}
            data-page-transition={suppressPageEntrance ? "none" : undefined}
            className="burrow-page flex min-h-0 flex-1 flex-col"
          >
            {children}
          </div>
        </main>
      </div>
      {drawerMounted && (
        <Suspense fallback={null}>
          <RailDrawer open={drawerOpen} onOpenChange={setDrawerOpen} returnFocus={railTrigger} />
        </Suspense>
      )}
      {/* the palette is keyboard-first (⌘K, `/`): it opens instantly in both directions, and it is unmounted while
          closed so each open starts from an empty query */}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette open onOpenChange={setPaletteOpen} />
        </Suspense>
      )}
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
