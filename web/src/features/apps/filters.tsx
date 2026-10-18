import { useDebouncedValue } from "@tanstack/react-pacer";
import { CalendarRange, Filter, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { fmtDuration } from "~/lib/format";
import { EASE_OUT, motionAllowed, tokenMs } from "~/lib/motion";
import { Button } from "~/ui/button";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "~/ui/popover";
import { Select } from "~/ui/select";
import { Tooltip } from "~/ui/tooltip";
import type { Facets } from "./view";
import { finalStatusLabel, type AppsSearch } from "./search";

export type Patch = (patch: Partial<AppsSearch>) => void;

const ANY = "__any";
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type FilterChipSnapshot = { left: number; top: number; width: number; height: number; element: HTMLElement };

function facetOptions(list: { value: string; count: number }[], anyLabel: string) {
  return [{ value: ANY, label: anyLabel }, ...list.map((f) => ({ value: f.value, label: `${f.value} (${f.count})` }))];
}

/** A facet `<Select>`: `null` = no filter. Counts come from the unfiltered list, like the legacy facets. */
function FacetSelect({
  label,
  anyLabel,
  value,
  options,
  onSelect,
  className,
}: {
  label: string;
  anyLabel: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onSelect: (value: string | undefined) => void;
  className?: string;
}) {
  return (
    <Select
      label={label}
      value={value ?? null}
      placeholder={anyLabel}
      options={options}
      onValueChange={(v) => onSelect(v === ANY || v === null ? undefined : v)}
      className={cn("max-w-[13rem] text-small", className)}
    />
  );
}

/** Local-time `datetime-local` value <-> epoch ms. The picker is always local time (the pref affects display only). */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

const PRESETS: { label: string; ms: number }[] = [
  { label: "Last hour", ms: 3600_000 },
  { label: "Last 6 hours", ms: 6 * 3600_000 },
  { label: "Last 24 hours", ms: 24 * 3600_000 },
  { label: "Last 7 days", ms: 7 * 86400_000 },
  { label: "Last 30 days", ms: 30 * 86400_000 },
];

/** A from/to range over one epoch field, with presets. Both bounds are optional and live in the URL. */
function RangeFilter({
  label,
  field,
  from,
  to,
  onFrom,
  onTo,
  now,
}: {
  label: string;
  field: "started" | "finished";
  from: number | undefined;
  to: number | undefined;
  onFrom: (v: number | undefined) => void;
  onTo: (v: number | undefined) => void;
  now: number;
}) {
  const active = from !== undefined || to !== undefined;
  return (
    <PopoverRoot>
      <PopoverTrigger
        render={<Button variant={active ? "default" : "quiet"} size="sm" className={cn("gap-1.5", active && "border-live text-live")} />}
        aria-label={`${label} range`}
      >
        <CalendarRange className="size-3.5" aria-hidden="true" />
        {label}
        {active && (
          <span className="text-micro text-ink-3">
            {from !== undefined ? `from ${fmtDuration(now - from)} ago` : ""}
            {from !== undefined && to !== undefined ? " " : ""}
            {to !== undefined ? `to ${fmtDuration(now - to)} ago` : ""}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent title={`${label} range`} align="start" className="w-[20rem]">
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-small text-ink-3">
            From
            <input
              type="datetime-local"
              value={from !== undefined ? toLocalInput(from) : ""}
              onChange={(e) => onFrom(fromLocalInput(e.target.value))}
              aria-label={`${label} from`}
              className="h-(--ctl-h) rounded-md border border-seam-strong bg-well px-2 text-body text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-small text-ink-3">
            To
            <input
              type="datetime-local"
              value={to !== undefined ? toLocalInput(to) : ""}
              onChange={(e) => onTo(fromLocalInput(e.target.value))}
              aria-label={`${label} to`}
              className="h-(--ctl-h) rounded-md border border-seam-strong bg-well px-2 text-body text-ink"
            />
          </label>
          <div className="flex flex-wrap gap-1 pt-1">
            {PRESETS.map((p) => (
              <Button key={p.label} size="sm" variant="quiet" onClick={() => onFrom(now - p.ms)}>
                {p.label}
              </Button>
            ))}
          </div>
          {active && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => {
                onFrom(undefined);
                onTo(undefined);
              }}
            >
              Clear {field} range
            </Button>
          )}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * The filter bar. Everything writes straight to the URL (the route validates it), so the view is shareable and the back
 * button works. The name box is Pacer-debounced so typing does not push a history entry per keystroke.
 */
export function AppFilters({
  search,
  facets,
  patch,
  now,
  showLegacyFinishedLabel = false,
}: {
  search: AppsSearch;
  facets: Facets;
  patch: Patch;
  now: number;
  showLegacyFinishedLabel?: boolean;
}) {
  const [draft, setDraft] = useState(search.name ?? "");
  const [debounced] = useDebouncedValue(draft, { wait: 250 });
  const pushed = useRef(search.name ?? "");
  const filterBarRef = useRef<HTMLDivElement>(null);
  const filterExitLayerRef = useRef<HTMLDivElement>(null);
  const previousFilterChips = useRef(new Map<string, FilterChipSnapshot>());
  const filterAnimations = useRef<Animation[]>([]);

  useEffect(() => {
    if (debounced === pushed.current) return;
    pushed.current = debounced;
    patch({ name: debounced.trim() || undefined });
  }, [debounced, patch]);

  useEffect(() => {
    const current = search.name ?? "";
    if (current !== pushed.current) {
      pushed.current = current;
      setDraft(current);
    }
  }, [search.name]);

  const active = [
    search.final
      ? { key: "final", label: `Final status: ${finalStatusLabel(search.final)}`, clear: () => patch({ final: undefined }) }
      : null,
    search.user ? { key: "user", label: `User: ${search.user}`, clear: () => patch({ user: undefined }) } : null,
    search.queue ? { key: "queue", label: `Queue: ${search.queue}`, clear: () => patch({ queue: undefined }) } : null,
    search.type ? { key: "type", label: `Type: ${search.type}`, clear: () => patch({ type: undefined }) } : null,
    search.tag ? { key: "tag", label: `Tag: ${search.tag}`, clear: () => patch({ tag: undefined }) } : null,
    search.name ? { key: "name", label: `Name: ${search.name}`, clear: () => patch({ name: undefined }) } : null,
  ].filter((x): x is { key: string; label: string; clear: () => void } => x !== null);

  useIsomorphicLayoutEffect(() => {
    const root = filterBarRef.current;
    if (!root) return;
    filterAnimations.current.forEach((animation) => {
      animation.cancel();
    });
    filterAnimations.current = [];

    const rootRect = root.getBoundingClientRect();
    const current = new Map<string, FilterChipSnapshot>();
    for (const element of root.querySelectorAll<HTMLElement>("[data-filter-motion-key]")) {
      const key = element.dataset.filterMotionKey;
      if (!key) continue;
      const rect = element.getBoundingClientRect();
      current.set(key, {
        left: rect.left - rootRect.left,
        top: rect.top - rootRect.top,
        width: rect.width,
        height: rect.height,
        element,
      });
    }

    const previous = previousFilterChips.current;
    if (previous.size > 0 && motionAllowed()) {
      const duration = tokenMs(root, "--dur-content", 220);
      const exitLayer = filterExitLayerRef.current;
      if (duration > 0 && exitLayer) {
        for (const [key, snapshot] of previous) {
          if (current.has(key) || typeof HTMLElement.prototype.animate !== "function") continue;
          const exiting = snapshot.element.cloneNode(true) as HTMLElement;
          exiting.removeAttribute("data-filter-motion-key");
          exiting.removeAttribute("id");
          exiting.querySelectorAll("[id]").forEach((element) => {
            element.removeAttribute("id");
          });
          exiting.setAttribute("aria-hidden", "true");
          exiting.setAttribute("inert", "");
          exiting.setAttribute("role", "presentation");
          Object.assign(exiting.style, {
            position: "absolute",
            top: `${snapshot.top}px`,
            left: `${snapshot.left}px`,
            width: `${snapshot.width}px`,
            height: `${snapshot.height}px`,
            margin: "0",
            pointerEvents: "none",
            zIndex: "1",
            willChange: "transform, opacity",
          });
          exitLayer.appendChild(exiting);
          const animation = exiting.animate(
            [
              { opacity: 1, transform: "translateX(0)" },
              { opacity: 0, transform: "translateX(-8px)" },
            ],
            { duration, easing: EASE_OUT },
          );
          const removeExit = () => exiting.remove();
          animation.onfinish = removeExit;
          animation.oncancel = removeExit;
          filterAnimations.current.push(animation);
        }

        for (const [key, snapshot] of current) {
          const from = previous.get(key);
          if (!from || typeof snapshot.element.animate !== "function") continue;
          const dx = from.left - snapshot.left;
          const dy = from.top - snapshot.top;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
          const targetTransform = getComputedStyle(snapshot.element).transform;
          const startTransform =
            targetTransform === "none" ? `translate(${dx}px, ${dy}px)` : `translate(${dx}px, ${dy}px) ${targetTransform}`;
          filterAnimations.current.push(
            snapshot.element.animate([{ transform: startTransform }, { transform: targetTransform }], {
              duration,
              easing: EASE_OUT,
            }),
          );
        }
      }
    }

    previousFilterChips.current = current;
  }, [active]);

  useEffect(
    () => () => {
      filterAnimations.current.forEach((animation) => {
        animation.cancel();
      });
    },
    [],
  );

  return (
    <div ref={filterBarRef} data-testid="apps-filters" className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      <div className="burrow-apps-name-filter flex h-(--ctl-h) items-center gap-1.5 rounded-md border border-seam-strong bg-well px-2">
        <Search className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
        <input
          data-testid="apps-name-filter"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Name or application id…"
          aria-label="Filter by name or application id"
          className="burrow-apps-name-filter-input h-full w-[13rem] min-w-0 bg-transparent text-small text-ink outline-none placeholder:text-ink-4"
        />
        {draft && (
          <Tooltip label="Clear name filter">
            <button
              type="button"
              aria-label="Clear name filter"
              className="burrow-control burrow-control--icon text-ink-4 hover:text-ink"
              onClick={() => setDraft("")}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>

      <FacetSelect
        label="User"
        anyLabel="Any user"
        value={search.user}
        options={facetOptions(facets.users, "Any user")}
        onSelect={(v) => patch({ user: v })}
      />
      <FacetSelect
        label="Queue"
        anyLabel="Any queue"
        value={search.queue}
        options={facetOptions(facets.queues, "Any queue")}
        onSelect={(v) => patch({ queue: v })}
      />
      <FacetSelect
        label="Application type"
        anyLabel="Any type"
        value={search.type}
        options={facetOptions(facets.types, "Any type")}
        onSelect={(v) => patch({ type: v })}
      />
      <FacetSelect
        label="Tag"
        anyLabel="Any tag"
        value={search.tag}
        options={facetOptions(facets.tags, "Any tag")}
        onSelect={(v) => patch({ tag: v })}
      />

      <RangeFilter
        label="Started"
        field="started"
        now={now}
        from={search.startedAfter}
        to={search.startedBefore}
        onFrom={(v) => patch({ startedAfter: v })}
        onTo={(v) => patch({ startedBefore: v })}
      />
      <RangeFilter
        label="Finished"
        field="finished"
        now={now}
        from={search.finishedAfter}
        to={search.finishedBefore}
        onFrom={(v) => patch({ finishedAfter: v })}
        onTo={(v) => patch({ finishedBefore: v })}
      />
      {showLegacyFinishedLabel && <span className="text-micro text-ink-4">URL-synced</span>}

      {active.length > 0 && (
        <>
          <span data-filter-motion-key="summary" className="burrow-enter flex items-center gap-1 text-micro text-ink-4">
            <Filter className="size-3" aria-hidden="true" />
            {active.length} active
          </span>
          {active.map((a) => (
            <button
              key={a.key}
              data-filter-motion-key={a.key}
              type="button"
              onClick={a.clear}
              // chips mount as facets are picked and can be cleared a dozen times in a row: a transition (not a
              // keyframe) so a re-trigger retargets instead of restarting
              className="burrow-control burrow-enter-pop inline-flex items-center gap-1 rounded-full border border-seam-strong bg-fabric-2 px-2 py-0.5 text-micro text-ink-2 transition-colors duration-(--dur-fast) ease-(--ease-out) hover:border-live hover:text-ink"
            >
              {a.label}
              <X className="size-3" aria-hidden="true" />
            </button>
          ))}
          <Button
            data-filter-motion-key="clear"
            className="burrow-enter"
            size="sm"
            variant="ghost"
            onClick={() =>
              patch({
                final: undefined,
                user: undefined,
                queue: undefined,
                type: undefined,
                tag: undefined,
                name: undefined,
                startedAfter: undefined,
                startedBefore: undefined,
                finishedAfter: undefined,
                finishedBefore: undefined,
              })
            }
          >
            Clear filters
          </Button>
        </>
      )}
      <div ref={filterExitLayerRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-visible" />
    </div>
  );
}
