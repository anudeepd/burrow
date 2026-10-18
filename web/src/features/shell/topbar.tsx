import { useQuery } from "@tanstack/react-query";
import { type Ref, useRef } from "react";
import { Menu, Monitor, Moon, Pause, Play, Search, Sun } from "lucide-react";
import { q } from "~/api/queries";
import { useConnection } from "~/api/connection";
import { cn } from "~/lib/cn";
import { useMounted } from "~/lib/use-mounted";
import { fmtEpoch, fmtRelative } from "~/lib/format";
import { LIVE_INTERVALS, PREF_DEFAULTS, type Theme, type TimeZoneMode, setPrefs, usePref } from "~/state/prefs";
import { useParity } from "~/state/parity";
import { Button, Kbd } from "~/ui/button";
import { Datum, Entity, SINGLETON } from "~/ui/datum";
import { Select } from "~/ui/select";
import { StatusPill } from "~/ui/status";
import { Segmented } from "~/ui/toggles";
import { HelpTip, Tooltip } from "~/ui/tooltip";
import { ConnectionPopover } from "./connection-popover";
import { useResponsePulse } from "./use-response-pulse";
import { useNow } from "./use-now";

/** ⌘ on Apple hardware, Ctrl elsewhere. Read once on the client; the server render shows "Ctrl" (harmless). */
function modKey(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";
}

const THEMES: { value: Theme; label: React.ReactNode; aria: string; hint: string }[] = [
  {
    value: "system",
    label: <Monitor className="size-3.5" aria-hidden="true" />,
    aria: "Theme: follow system",
    hint: "Follow your operating system’s light or dark appearance preference.",
  },
  {
    value: "dark",
    label: <Moon className="size-3.5" aria-hidden="true" />,
    aria: "Theme: dark",
    hint: "Use dark mode regardless of your operating system’s appearance preference.",
  },
  {
    value: "light",
    label: <Sun className="size-3.5" aria-hidden="true" />,
    aria: "Theme: light",
    hint: "Use light mode regardless of your operating system’s appearance preference.",
  },
];

const ZONES: { value: TimeZoneMode; label: React.ReactNode; aria: string; hint: string }[] = [
  {
    value: "local",
    label: "Local",
    aria: "Times in local time zone",
    hint: "Convert displayed timestamps to this browser’s local time zone. Stored timestamps are unchanged.",
  },
  {
    value: "utc",
    label: "UTC",
    aria: "Times in UTC",
    hint: "Display timestamps in Coordinated Universal Time (UTC). Stored timestamps are unchanged.",
  },
];

function ViewControls() {
  const mounted = useMounted();
  const theme = usePref("theme");
  const tz = usePref("tz");
  /* `data-pressed` is an attribute, and React keeps the server's attributes while hydrating: rendering a pref straight
     from the store would leave the control pointing at the wrong option until the user touched it. The defaults render
     first (matching the server), the real value lands in the same painted frame as `mounted`. */
  return (
    <div className="hidden items-center gap-1.5 xl:flex">
      <span data-testid="theme-toggle">
        <Segmented
          value={mounted ? theme : PREF_DEFAULTS.theme}
          onValueChange={(v) => setPrefs({ theme: v })}
          options={THEMES}
          label="Theme"
        />
      </span>
      <span data-testid="tz-toggle" className="inline-flex w-[5rem] shrink-0">
        <Segmented value={mounted ? tz : PREF_DEFAULTS.tz} onValueChange={(v) => setPrefs({ tz: v })} options={ZONES} label="Time zone" />
      </span>
    </div>
  );
}

/** Live controls: pause/resume, cadence, and the age of the last successful response. */
function LiveControls() {
  const mounted = useMounted();
  const paused = usePref("livePaused");
  const tz = usePref("tz");
  /* One gated value for every place the pref is rendered — attribute, glyph classes, label, text. React keeps the
     *server's* attributes and class names at hydration and only patches a prop whose rendered value changed, so a value
     used verbatim would stay wrong until something else forced a re-render. */
  const pausedNow = mounted && paused;
  const interval = usePref("liveIntervalMs");
  const lastOkAt = useConnection((s) => s.lastOkAt);
  const updatedDot = useRef<HTMLSpanElement>(null);
  useResponsePulse(updatedDot, lastOkAt, interval);
  const now = useNow(1000);
  const options = LIVE_INTERVALS.map((ms) => ({ value: String(ms), label: ms < 1000 ? `${ms} ms` : `${ms / 1000} s` }));
  return (
    <div data-testid="live-controls" className="flex h-7 items-center gap-1 rounded-md border border-seam bg-well pr-1.5 pl-0.5">
      <Tooltip label={pausedNow ? "Resume live updates" : "Pause live updates"}>
        <Button
          data-testid="live-pause"
          data-paused={pausedNow}
          variant="ghost"
          size="icon-sm"
          aria-label={pausedNow ? "Resume live updates" : "Pause live updates"}
          onClick={() => setPrefs({ livePaused: !paused })}
        >
          {/* both glyphs stay mounted and cross-fade (better-ui's icon recipe: opacity + scale 0.25 + blur 4px), so the
              control reads as one slot changing state rather than two icons swapping */}
          <span className="relative grid place-items-center">
            <Pause
              className={cn(
                "col-start-1 row-start-1 size-3.5 text-live transition-[opacity,scale,filter] duration-(--dur-fast) ease-(--ease-out)",
                pausedNow && "scale-[0.25] opacity-0 blur-[4px]",
              )}
              aria-hidden="true"
            />
            <Play
              className={cn(
                "col-start-1 row-start-1 size-3.5 text-ink-3 transition-[opacity,scale,filter] duration-(--dur-fast) ease-(--ease-out)",
                !pausedNow && "scale-[0.25] opacity-0 blur-[4px]",
              )}
              aria-hidden="true"
            />
          </span>
        </Button>
      </Tooltip>
      <span data-testid="live-interval" className="inline-flex w-12 shrink-0">
        <Select
          // the trigger's *text* is the pref; before mount it has to read like the server's default (see `mounted`)
          value={String(mounted ? interval : PREF_DEFAULTS.liveIntervalMs)}
          onValueChange={(v) => v && setPrefs({ liveIntervalMs: Number(v) })}
          options={options}
          label="Refresh interval"
          className="h-[calc(var(--ctl-h)-4px)] border-0 bg-transparent px-1 text-small text-ink-2 hover:bg-fabric-3"
        />
      </span>
      <span
        data-testid="last-updated"
        className="hidden h-[calc(var(--ctl-h)-4px)] w-16 shrink-0 items-center gap-1.5 text-left text-small text-ink-3 tnum sm:inline-flex"
      >
        <span ref={updatedDot} className="size-1.5 shrink-0 rounded-full bg-live" aria-hidden="true" />
        {/* `mounted`: the server renders the shell without knowing the paused pref or the last response, so the first
            client paint must say exactly what the server said (`…`) and the real value arrives on the next commit */}
        <span className="min-w-0 truncate">{pausedNow ? "paused" : mounted && lastOkAt ? fmtRelative(lastOkAt, now) : "…"}</span>
      </span>
      <HelpTip label="Last successful response" className="hidden size-5 sm:inline-flex">
        {lastOkAt
          ? `Last successful API response at ${fmtEpoch(lastOkAt, tz)} (${tz === "utc" ? "UTC" : "local time"}).`
          : "Waiting for the first successful API response."}
      </HelpTip>
    </div>
  );
}

/** Top bar: cluster identity on the left, live controls and view settings on the right. */
export function Topbar({
  onOpenRail,
  onOpenPalette,
  railTrigger,
}: {
  onOpenRail: () => void;
  onOpenPalette: () => void;
  railTrigger?: Ref<HTMLButtonElement>;
}) {
  const mounted = useMounted();
  const { data: info } = useQuery(q.info());
  const paused = usePref("livePaused");
  /* an attribute the server cannot know: `live` until mount, then the real state (React only patches an attribute when
     the *value it rendered before* differs — so it must differ *after* mount, never during hydration) */
  const liveState = mounted && paused ? "paused" : "live";
  const parity = useParity();
  const mod = mounted ? modKey() : "Ctrl";
  const tz = usePref("tz");

  return (
    <header
      data-testid="topbar"
      data-live={liveState}
      className="burrow-topbar flex h-(--topbar-h) shrink-0 items-center gap-2 border-b border-seam bg-fabric px-3"
    >
      <Button
        ref={railTrigger}
        data-testid="rail-toggle"
        variant="ghost"
        size="icon-sm"
        className="md:hidden"
        aria-label="Open navigation"
        title="Open navigation"
        onClick={onOpenRail}
      >
        <Menu className="size-4" aria-hidden="true" />
      </Button>

      {/* one singleton entity (`_`): the contract keeps every `data-yf` inside a `data-ye`, and the topbar's cluster
          identity is the same `cluster.info` entity the overview renders. `display: contents` keeps the wrapper out of
          the flex layout, so the topbar's geometry is byte-identical to before. */}
      <Entity id={SINGLETON} className="contents">
        <Tooltip label={info ? `YARN cluster · ID ${info.id} · started ${fmtEpoch(info.startedOn, tz)}` : "YARN cluster"}>
          <div data-testid="cluster-id" className="flex min-w-0 shrink-0 items-center gap-2">
            <span className="shrink-0 text-small font-medium text-ink-2">YARN</span>
            <span className="hidden shrink-0 items-center gap-1 text-small text-ink-3 xl:flex">
              <span>started</span>
              <Datum field="cluster.info.startedOn" raw={info?.startedOn} fmt="epoch" className="tnum" />
            </span>
            <Datum field="cluster.info.id" raw={info?.id} fmt="id" aria-hidden="true" className="sr-only" />
          </div>
        </Tooltip>
        <span data-testid="ha-pill" className="shrink-0">
          <StatusPill domain="rm.haState" state={info?.haState} field="cluster.info.haState" size="sm" />
        </span>
        <span className="hidden shrink-0 items-center gap-1 text-small text-ink-3 md:flex">
          <span aria-hidden="true" className="text-ink-4">
            Hadoop
          </span>
          <Datum field="cluster.info.hadoopVersion" raw={info?.hadoopVersion} />
        </span>
      </Entity>
      {mounted && parity && (
        <Tooltip label="Parity mode: all data shown, no animation, no refresh.">
          <span className="shrink-0 rounded-xs border border-seam-strong px-1 font-mono text-micro text-parity">parity</span>
        </Tooltip>
      )}

      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <LiveControls />
        <Button
          data-testid="palette-trigger"
          variant="default"
          size="sm"
          aria-label={`Search applications and pages (${mod} K)`}
          title={`Search applications and pages (${mod} K)`}
          onClick={onOpenPalette}
          className="shrink-0 justify-center gap-1.5 sm:w-auto sm:min-w-[9rem]"
        >
          <Search className="size-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Search</span>
          <Kbd className="hidden sm:inline-flex">{mod} K</Kbd>
        </Button>
        <ViewControls />
        <ConnectionPopover />
      </div>
    </header>
  );
}
