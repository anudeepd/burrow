import { Link, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { q } from "~/api/queries";
import { useConnection } from "~/api/connection";
import { cn } from "~/lib/cn";
import { fmtInt } from "~/lib/format";
import { useMounted } from "~/lib/use-mounted";
import { usePref, setPrefs } from "~/state/prefs";
import { useParity } from "~/state/parity";
import { Button } from "~/ui/button";
import { Tooltip } from "~/ui/tooltip";
import { BurrowBrand } from "./BurrowBrand";
import { NAV_OVERVIEW, NAV_PRIMARY, NAV_TOOLS, type NavBadge, type NavItem } from "./nav";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Live figures for the rail badges. One query (cluster metrics) feeds every badge. */
function useBadges(): Record<NavBadge, number> {
  const { data } = useQuery(q.metrics());
  return useMemo(
    () => ({
      running: data?.appsRunning ?? 0,
      pending: data?.appsPending ?? 0,
      warnNodes: (data?.unhealthyNodes ?? 0) + (data?.lostNodes ?? 0),
    }),
    [data],
  );
}

/**
 * The live count. Collapsed it becomes a dot — but the *markup* is the same in both states: the server renders this
 * navigation before any `localStorage` pref is known, so a shape change would be a hydration mismatch (React #418) and
 * a mounted-then-unmounted badge could not animate. The dot is the same span, sized and de-texted by classes.
 */
function Badge({ kind, value, collapsed }: { kind: NavBadge; value: number; collapsed: boolean }) {
  if (value <= 0) return null;
  const label = kind === "running" ? `${value} running` : kind === "pending" ? `${value} pending` : `${value} unhealthy or lost`;
  if (collapsed) {
    return (
      <span
        className={cn(
          "absolute top-1 right-1 z-10 size-1.5 overflow-hidden rounded-full text-[0] leading-none",
          kind === "warnNodes" ? "bg-warn" : kind === "running" ? "bg-live" : "bg-fresh",
        )}
      >
        {fmtInt(value)}
      </span>
    );
  }
  return (
    <Tooltip label={label}>
      <span
        className={cn(
          "relative z-10 ml-auto shrink-0 rounded-full px-1.5 text-micro leading-[1.5] tnum",
          kind === "warnNodes"
            ? "bg-[color-mix(in_oklch,var(--warn)_18%,transparent)] text-warn"
            : kind === "running"
              ? "bg-[color-mix(in_oklch,var(--live)_18%,transparent)] text-live"
              : "bg-fabric-3 text-ink-2",
        )}
      >
        {fmtInt(value)}
      </span>
    </Tooltip>
  );
}

function RailItem({
  item,
  collapsed,
  badges,
  onNavigate,
  mounted,
}: {
  item: NavItem;
  collapsed: boolean;
  badges: Record<NavBadge, number>;
  onNavigate?: () => void;
  mounted: boolean;
}) {
  const badgeValue = item.badge ? badges[item.badge] : 0;
  const badgeDescription = item.badge
    ? item.badge === "running"
      ? `${badgeValue} running`
      : item.badge === "pending"
        ? `${badgeValue} pending`
        : `${badgeValue} unhealthy or lost`
    : null;
  const link = (
    <Link
      key={`${mounted ? "client" : "server"}:${item.to}`}
      to={item.to}
      activeOptions={{ exact: item.to === "/", includeSearch: false }}
      onClick={onNavigate}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "burrow-nav-link relative flex h-9 shrink-0 items-center gap-2.5 rounded-sm px-2 text-body text-ink-2 outline-offset-2",
        "transition-[background-color,color] duration-(--dur-base) ease-(--ease-out) hover:text-ink",
        "data-[status=active]:text-ink",
      )}
    >
      <item.icon className="burrow-rail-item-icon relative z-10 size-4 shrink-0" aria-hidden="true" />
      <span className="burrow-rail-collapsible relative z-10 min-w-0 truncate">{item.label}</span>
      {item.badge && <Badge kind={item.badge} value={badges[item.badge]} collapsed={collapsed} />}
    </Link>
  );
  return (
    <Tooltip label={badgeValue > 0 && badgeDescription ? `${item.label} · ${badgeDescription}` : item.label} disabled={!collapsed}>
      {link}
    </Tooltip>
  );
}

function SectionLabel({ children }: { children: string }) {
  // Keep one fixed-height slot so switching between the divider and heading never moves the rows below it.
  return (
    <div className="relative flex h-7 shrink-0 items-end px-2 pb-1">
      <div className="burrow-rail-section-rule pointer-events-none absolute inset-x-2 top-1/2 h-px bg-seam" aria-hidden="true" />
      <div className="burrow-rail-collapsible relative text-micro font-semibold tracking-[0.08em] text-ink-4 uppercase">{children}</div>
    </div>
  );
}

/**
 * A silent state is a bug report waiting to happen: with reduced motion on — the in-app pref or the OS setting — nothing
 * in the product moves, and the only control that said so lived in the DAG preview's toolbar. The chip names the state
 * beside `parity`, and when the cause is the app's own pref it is also the way back.
 *
 * It appears only after mount: the server renders the shell with defaults, so anything that exists only for a
 * `localStorage` pref has to arrive on a later commit (see `lib/use-mounted.ts`).
 */
function MotionChip() {
  const mounted = useMounted();
  const motion = usePref("motion");
  const [osReduced, setOsReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setOsReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  if (!mounted) return null;
  const fromPref = motion === "reduced";
  if (!fromPref && !osReduced) return null;
  if (fromPref) {
    return (
      <Tooltip label="Reduced motion is on. Click to turn motion back on.">
        <button
          type="button"
          data-testid="motion-chip"
          onClick={() => setPrefs({ motion: "system" })}
          className="ml-auto shrink-0 rounded-xs border border-seam-strong px-1 font-mono text-ink-3 hover:bg-fabric-3 hover:text-ink"
        >
          motion off
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label="Your operating system asks for reduced motion; Burrow honours it.">
      <span
        data-testid="motion-chip"
        className="ml-auto shrink-0 rounded-xs border border-dashed border-seam-strong px-1 font-mono text-ink-3"
      >
        os: no motion
      </span>
    </Tooltip>
  );
}

/** The collapse/expand control. It belongs to the *desktop* rail only: a drawer is closed, not collapsed. */
function RailToggle({ collapsed, className }: { collapsed: boolean; className?: string }) {
  const label = collapsed ? "Expand navigation" : "Collapse navigation";
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        // A 24px hit target keeps the toggle compact enough for the collapsed 56px rail.
        size="icon-sm"
        className={cn("size-6 p-0", className)}
        aria-label={label}
        onClick={() => setPrefs({ railCollapsed: !collapsed })}
      >
        {collapsed ? <PanelLeftOpen className="size-3.5" aria-hidden="true" /> : <PanelLeftClose className="size-3.5" aria-hidden="true" />}
      </Button>
    </Tooltip>
  );
}

/** Left rail: brand, live navigation, tools, and the connection footer. Also rendered inside the mobile drawer. */
export function Rail({ inDrawer = false, className, onNavigate }: { inDrawer?: boolean; className?: string; onNavigate?: () => void }) {
  const badges = useBadges();
  const parity = useParity();
  const collapsedPref = usePref("railCollapsed");
  const mounted = useMounted();
  /* A drawer is *closed*, never collapsed: forcing the expanded rail keeps its labels readable on a phone, and the
     collapse control is the desktop rail's — toggling it from the drawer would only shrink the desktop rail behind it.
     `mounted` matters: the server renders this rail expanded (it cannot read `localStorage`), and React keeps the
     server's attributes when it hydrates, so the collapsed attribute has to arrive on a later commit. The *look* is
     already collapsed from the first painted frame through `html[data-rail-collapsed]` + CSS. */
  const isCollapsed = mounted && !inDrawer && collapsedPref;
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<{ top: number } | null>(null);
  const { data: meta } = useQuery(q.meta());
  const consecutiveFailures = useConnection((s) => s.consecutiveFailures);
  const lastCache = useConnection((s) => s.lastCache);

  useIsomorphicLayoutEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>(".burrow-nav-link[data-status='active']");
    if (!nav || !active) {
      setSelection(null);
      return;
    }
    const activeRect = active.getBoundingClientRect();
    const next = {
      top: activeRect.top - nav.getBoundingClientRect().top - nav.clientTop + nav.scrollTop,
    };
    setSelection(next);
  }, [pathname, isCollapsed, inDrawer, mounted]);

  return (
    /* The collapsed state is carried by one attribute and styled in CSS (`app.css`): the server renders this rail before
       any `localStorage` pref exists, so a pref that changed the *markup* would fail hydration (React #418) — and a
       label that mounts/unmounts could not fade the way a mounted one does. */
    <aside
      data-testid="rail"
      data-collapsed={isCollapsed}
      aria-label="Sections"
      className={cn(
        "burrow-rail flex min-h-0 shrink-0 flex-col border-r border-seam bg-fabric",
        !inDrawer && "burrow-rail-docked",
        className,
      )}
    >
      <div className="burrow-rail-brand relative flex h-(--topbar-h) shrink-0 items-center gap-2 overflow-hidden border-b border-seam px-3">
        <BurrowBrand tone="dark" wordmark className="burrow-logo-dark burrow-rail-logo-wordmark h-7 w-auto shrink-0" />
        <BurrowBrand tone="light" wordmark className="burrow-logo-light burrow-rail-logo-wordmark h-7 w-auto shrink-0" />
        <BurrowBrand tone="dark" className="burrow-rail-brand-mark burrow-mark-dark size-7 shrink-0" />
        <BurrowBrand tone="light" className="burrow-rail-brand-mark burrow-mark-light size-7 shrink-0" />
      </div>

      <nav
        ref={navRef}
        aria-label="Primary"
        className="relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto p-1.5"
      >
        {selection && (
          <span
            aria-hidden="true"
            className="burrow-rail-active-selection pointer-events-none absolute rounded-sm"
            style={{
              transform: `translate3d(0, ${selection.top}px, 0)`,
            }}
          />
        )}
        <RailItem item={NAV_OVERVIEW} collapsed={isCollapsed} badges={badges} onNavigate={onNavigate} mounted={mounted} />
        {NAV_PRIMARY.map((item) => (
          <RailItem key={item.to} item={item} collapsed={isCollapsed} badges={badges} onNavigate={onNavigate} mounted={mounted} />
        ))}
        <SectionLabel>Tools</SectionLabel>
        {NAV_TOOLS.map((item) => (
          <RailItem key={item.to} item={item} collapsed={isCollapsed} badges={badges} onNavigate={onNavigate} mounted={mounted} />
        ))}
      </nav>

      {/* Keep the collapse/expand control in the footer. It sits at the trailing edge when expanded and on the rail's
          centerline when collapsed. The drawer has no toggle at all — a drawer is closed, not collapsed. */}
      <div className="shrink-0 border-t border-seam p-2 text-micro text-ink-4">
        <div className="burrow-rail-footer-row relative flex items-center gap-2">
          <span
            className={cn("burrow-rail-footer-status size-1.5 shrink-0 rounded-full", consecutiveFailures > 0 ? "bg-fail" : "bg-ok")}
            aria-hidden="true"
          />
          {/* `useMounted()`: the connection state is client knowledge; the server renders the same text node empty,
              and the value lands on the first commit after mount (never as a hydration mismatch) */}
          <span className="burrow-rail-collapsible truncate">
            {mounted
              ? consecutiveFailures > 0
                ? `${consecutiveFailures} failed request(s)`
                : lastCache === "stale"
                  ? "serving cached data"
                  : "connected"
              : ""}
          </span>
          {/* the toggle's own glyph and label are pref-derived too, so they follow the same rule as the rail: the first
              client render matches the server (expanded), the swap happens on the commit after mount */}
          {!inDrawer && <RailToggle collapsed={mounted && collapsedPref} className="burrow-rail-footer-toggle" />}
        </div>
        <div className="burrow-rail-collapsible burrow-rail-footer-meta mt-1 flex items-center gap-1.5">
          <span className="truncate font-mono">{mounted ? (meta?.rm.hadoopVersion ?? "—") : "—"}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">v{mounted ? (meta?.version ?? "?") : "?"}</span>
          <MotionChip />
          {/* Parity comes from the client URL; defer its chip so the server and first client trees match. */}
          {mounted && parity && <span className="ml-auto rounded-xs border border-seam-strong px-1 text-parity font-mono">parity</span>}
        </div>
      </div>
    </aside>
  );
}
