import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Boxes, CornerDownLeft, Moon, Pause, Play, Search, Sun, SunMoon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { q } from "~/api/queries";
import { cn } from "~/lib/cn";
import { setPrefs, usePref } from "~/state/prefs";
import { Kbd } from "~/ui/button";
import { Modal } from "~/ui/dialog";
import { ErrorState } from "~/ui/feedback";
import { StatusPill } from "~/ui/status";
import { NAV_ALL, type NavItem } from "./nav";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  right?: ReactNode;
  run: () => void;
}

function appItems(
  apps: readonly { id: string; name: string; user: string; queue: string; state: string }[],
  query: string,
  navigate: (appId: string) => void,
): Item[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: Item[] = [];
  for (const app of apps) {
    if (out.length >= 24) break;
    const haystack = `${app.id} ${app.name} ${app.user} ${app.queue}`.toLowerCase();
    if (!haystack.includes(needle)) continue;
    out.push({
      id: `app:${app.id}`,
      group: "Applications",
      label: app.name,
      hint: `${app.id} · ${app.user} · ${app.queue}`,
      icon: <Boxes className="size-4 text-ink-3" aria-hidden="true" />,
      right: <StatusPill domain="app.state" state={app.state} size="sm" />,
      run: () => navigate(app.id),
    });
  }
  return out;
}

/**
 * Command palette (⌘K / Ctrl-K, also `/`). Navigates, runs the handful of view actions, and searches applications that
 * are already in the query cache — opening the palette is what pulls the app list, so the palette never costs an extra
 * upstream request when /apps has been visited.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const theme = usePref("theme");
  const paused = usePref("livePaused");
  const appsQuery = useQuery({ ...q.apps(), enabled: open });
  const apps = appsQuery.data;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const go = (item: NavItem): Item => ({
      id: `nav:${item.to}`,
      group: "Go to",
      label: item.label,
      hint: item.description,
      icon: <item.icon className="size-4 text-ink-3" aria-hidden="true" />,
      run: () => {
        void navigate({ to: item.to });
      },
    });
    const actions: Item[] = [
      {
        id: "act:theme",
        group: "Actions",
        label: theme === "light" ? "Switch theme: dark" : "Switch theme: light",
        hint: "Dark is the default; light is equal-class",
        icon:
          theme === "light" ? (
            <Moon className="size-4 text-ink-3" aria-hidden="true" />
          ) : (
            <Sun className="size-4 text-ink-3" aria-hidden="true" />
          ),
        run: () => setPrefs({ theme: theme === "light" ? "dark" : "light" }),
      },
      {
        id: "act:theme-system",
        group: "Actions",
        label: "Theme: follow system",
        icon: <SunMoon className="size-4 text-ink-3" aria-hidden="true" />,
        run: () => setPrefs({ theme: "system" }),
      },
      {
        id: "act:live",
        group: "Actions",
        label: paused ? "Resume live updates" : "Pause live updates",
        icon: paused ? (
          <Play className="size-4 text-ink-3" aria-hidden="true" />
        ) : (
          <Pause className="size-4 text-ink-3" aria-hidden="true" />
        ),
        run: () => setPrefs({ livePaused: !paused }),
      },
    ];
    const needle = query.trim().toLowerCase();
    const nav = NAV_ALL.filter((n) => !needle || `${n.label} ${n.description} ${n.to}`.toLowerCase().includes(needle)).map(go);
    const acts = actions.filter((a) => !needle || a.label.toLowerCase().includes(needle));
    const appMatches = appItems(apps ?? [], query, (appId) => {
      void navigate({ to: "/apps/$appId", params: { appId } });
    });
    const scoped: Item[] = needle
      ? [
          {
            id: "nav:apps-filtered",
            group: "Go to",
            label: `Applications named “${query.trim()}”`,
            hint: "Opens /apps with the name filter applied",
            icon: <Search className="size-4 text-ink-3" aria-hidden="true" />,
            run: () => {
              void navigate({ to: "/apps", search: { name: query.trim() } });
            },
          },
        ]
      : [];
    return [...scoped, ...appMatches, ...nav, ...acts];
  }, [query, apps, navigate, theme, paused]);

  const shown = items.slice(0, 40);
  const activeIdx = Math.min(active, Math.max(0, shown.length - 1));
  const activeItem = shown[activeIdx];

  useEffect(() => {
    if (!open) return;
    resultsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeItem?.id, open, query]);

  const runItem = (item: Item | undefined) => {
    if (!item) return;
    onOpenChange(false);
    setQuery("");
    item.run();
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      instant
      title="Search and navigate"
      description="Applications, views and view settings"
      className="w-[min(44rem,calc(100vw-2rem))]"
      initialFocus={inputRef}
    >
      <div data-testid="command-palette" className="flex flex-col">
        <div className="flex items-center gap-2 rounded-md border border-seam-strong bg-well px-2.5">
          <Search className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search applications by id, name, user or queue…"
            aria-label="Search applications and commands"
            aria-controls="palette-results"
            aria-activedescendant={activeItem ? `palette-${activeItem.id}` : undefined}
            role="combobox"
            aria-expanded="true"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                setActive(Math.min(shown.length - 1, activeIdx + 1));
                e.preventDefault();
              } else if (e.key === "ArrowUp") {
                setActive(Math.max(0, activeIdx - 1));
                e.preventDefault();
              } else if (e.key === "Enter") {
                runItem(activeItem);
                e.preventDefault();
              } else if (e.key === "Escape") {
                onOpenChange(false);
              }
            }}
            className="h-9 min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-4"
          />
          <Kbd>esc</Kbd>
        </div>

        {appsQuery.error && (
          <ErrorState
            compact
            title={apps ? "Application search refresh failed; showing cached results" : "Could not load applications for search"}
            message={appsQuery.error instanceof Error ? appsQuery.error.message : String(appsQuery.error)}
            onRetry={() => void appsQuery.refetch()}
          />
        )}

        <div ref={resultsRef} id="palette-results" role="listbox" aria-label="Results" className="mt-2 max-h-[50vh] overflow-auto">
          {shown.length === 0 && <p className="px-2 py-6 text-center text-small text-ink-3">No matches.</p>}
          {shown.map((item, i) => (
            <div key={item.id}>
              {(i === 0 || shown[i - 1]?.group !== item.group) && (
                <div className="px-2 pt-3 pb-1 text-micro font-semibold tracking-[0.08em] text-ink-4 uppercase">{item.group}</div>
              )}
              <div
                id={`palette-${item.id}`}
                role="option"
                aria-selected={i === activeIdx}
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => runItem(item)}
                className={cn(
                  "flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5",
                  i === activeIdx ? "bg-fabric-3 text-ink" : "text-ink-2",
                )}
              >
                {item.icon}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body">{item.label}</span>
                  {item.hint && <span className="block truncate text-micro text-ink-4">{item.hint}</span>}
                </span>
                {item.right}
                {i === activeIdx && <CornerDownLeft className="size-3.5 shrink-0 text-ink-4" aria-hidden="true" />}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 flex items-center gap-3 border-t border-seam pt-2 text-micro text-ink-4">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
          <span className="ml-auto flex items-center gap-1">
            <ArrowRight className="size-3" aria-hidden="true" /> search covers cached applications
          </span>
        </div>
      </div>
    </Modal>
  );
}
