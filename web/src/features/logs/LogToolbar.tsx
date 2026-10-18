/**
 * The sticky header of the container-log viewer: file selection + provenance on the first row, search and display
 * controls on the second. Everything that changes what is rendered is URL state, so the toolbar only emits changes.
 *
 * Provenance is not decoration: `source` says whether the bytes came from the NodeManager (live container) or
 * JobHistory/ATS (aggregated), the byte range says exactly which window is loaded, and the size is the YARN value
 * (`log.fileSize`) stamped through `Datum`.
 */
import { AlertTriangle, CaseSensitive, ChevronDown, ChevronUp, Download, Radio, Regex, RotateCw, WrapText } from "lucide-react";
import type { LogFileInfo } from "~/api/queries/logs";
import { CopyButton, SearchField } from "~/features/nodes/page";
import { cn } from "~/lib/cn";
import { fmtBytes } from "~/lib/format";
import { Button } from "~/ui/button";
import { Datum } from "~/ui/datum";
import { Select } from "~/ui/select";
import { Switch, Toggle } from "~/ui/toggles";
import { Tooltip, OptionalTooltip } from "~/ui/tooltip";
import { LEVEL_ORDER, type LogLevel, sourceLabel } from "./model";
import { useLogSearchHotkey } from "./use-log-search-hotkey";

export interface LogToolbarProps {
  containerId: string;
  file: string | null;
  files: LogFileInfo[];
  onFile: (name: string) => void;
  size: number;
  source: string | null;
  node: string | null;
  start: number;
  end: number;
  onRefresh: () => void;
  follow: boolean;
  onFollow: (v: boolean) => void;
  followDisabled: boolean;
  onDownload: () => void;
  downloading: boolean;
  copyValue: string;
  // search
  q: string;
  onQ: (v: string) => void;
  regex: boolean;
  onRegex: (v: boolean) => void;
  caseSensitive: boolean;
  onCase: (v: boolean) => void;
  hits: number;
  onPrev: () => void;
  onNext: () => void;
  onFirstError: () => void;
  badRegex: boolean;
  scanning: boolean;
  // display
  filter: LogLevel | null;
  onFilter: (level: LogLevel | null) => void;
  wrap: boolean;
  onWrap: (v: boolean) => void;
  timestamp: "absolute" | "relative";
  onTimestamp: (v: "absolute" | "relative") => void;
}

const LEVEL_OPTIONS = [
  { value: "all", label: "All levels" },
  ...LEVEL_ORDER.map((level) => ({ value: level, label: `${level} and above` })),
];

export function LogToolbar(props: LogToolbarProps) {
  useLogSearchHotkey();

  const {
    containerId,
    file,
    files,
    onFile,
    size,
    source,
    node,
    start,
    end,
    onRefresh,
    follow,
    onFollow,
    followDisabled,
    onDownload,
    downloading,
    copyValue,
    q,
    onQ,
    regex,
    onRegex,
    caseSensitive,
    onCase,
    hits,
    onPrev,
    onNext,
    onFirstError,
    badRegex,
    scanning,
    filter,
    onFilter,
    wrap,
    onWrap,
    timestamp,
    onTimestamp,
  } = props;

  const fileOptions = files.map((f) => ({ value: f.name, label: `${f.name} · ${fmtBytes(f.size)}` }));

  return (
    <div className="burrow-log-toolbar sticky top-0 z-sticky shrink-0 border-b border-seam bg-fabric/95 backdrop-blur">
      {/* row 1 — provenance */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <span className="flex items-center gap-2 text-small">
          <Datum field="log.containerId" raw={containerId} fmt="text" className="font-mono text-ink" title={containerId} />
        </span>
        {fileOptions.length > 0 ? (
          <Select
            value={file}
            onValueChange={(v) => v && onFile(v)}
            options={fileOptions}
            label="Log file"
            className="min-w-40"
            placeholder="Select a file"
          />
        ) : (
          <span className="text-small text-ink-3">No files</span>
        )}

        <span className="flex items-center gap-1.5 text-small text-ink-3">
          <Datum field="log.fileSize" raw={size} fmt="bytes" className="tnum text-ink-2" />
          <span aria-hidden="true">·</span>
          <span className="tnum" data-burrow-log-range={`${start}-${end}`}>
            bytes {start.toLocaleString("en-US")}–{Math.max(start, end - 1).toLocaleString("en-US")}
          </span>
        </span>

        <span className="flex items-center gap-2">
          <OptionalTooltip label={source ? `Served by ${sourceLabel(source)}` : "Upstream not reported"}>
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-seam-strong bg-fabric-2 px-2 py-0.5 text-caption text-ink-2"
              data-burrow-log-source={source ?? "unknown"}
            >
              <span className="size-1.5 rounded-full bg-live" aria-hidden="true" />
              {sourceLabel(source)}
            </span>
          </OptionalTooltip>

          {node && (
            <span className="flex items-center gap-1.5 text-small text-ink-3">
              <Datum field="log.nodeId" raw={node} fmt="text" className="font-mono text-ink-2" />
            </span>
          )}
        </span>

        <span className="flex basis-full items-center gap-2 sm:ml-auto sm:basis-auto">
          <Tooltip label="Re-read the current window">
            <Button variant="quiet" size="sm" onClick={onRefresh} aria-label="Refresh window">
              <RotateCw className="size-3.5" aria-hidden="true" />
              Refresh
            </Button>
          </Tooltip>
          <span className="flex items-center gap-1.5 text-small text-ink-2 max-sm:min-h-10">
            <Switch
              checked={follow}
              onCheckedChange={onFollow}
              label="Follow new log output"
              disabled={followDisabled}
              hint={follow ? "Stop following new output as it arrives." : "Follow new log output as it arrives."}
            />
            <Radio className={cn("size-3.5", follow ? "text-live" : "text-ink-4")} aria-hidden="true" />
            Follow
          </span>
          <CopyButton value={copyValue} label="Copy the loaded log text" />
          <Tooltip label={`Download ${file ?? "the log"} (${fmtBytes(size)})`}>
            <Button variant="quiet" size="sm" onClick={onDownload} disabled={downloading || !file} aria-label={`Download ${file ?? "log"}`}>
              <Download className={cn("size-3.5", downloading && "animate-pulse")} aria-hidden="true" />
              Download
            </Button>
          </Tooltip>
        </span>
      </div>

      {/* row 2 — search + display */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-seam-soft px-3 py-2">
        <div className="flex min-w-64 flex-1 items-center gap-2" data-burrow-search data-burrow-log-search>
          <SearchField
            value={q}
            onChange={onQ}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
              event.preventDefault();
              if (event.shiftKey) onPrev();
              else onNext();
            }}
            label="Search the log"
            placeholder="Search (literal)"
            wait={200}
            className={cn("flex-1", badRegex && "ring-1 ring-fail rounded-md")}
          />
          <span className="whitespace-nowrap text-small text-ink-3 tnum" aria-live="polite">
            {scanning ? "searching…" : q ? `${hits.toLocaleString("en-US")} match${hits === 1 ? "" : "es"}` : ""}
          </span>
          <div className="flex items-center">
            <Tooltip label={hits > 0 ? "Go to the previous search match (Shift+Enter)" : "Search for text to enable match navigation"}>
              <span data-testid="previous-match-trigger" className="inline-flex">
                <Button variant="quiet" size="icon-sm" onClick={onPrev} aria-label="Previous match" disabled={hits === 0}>
                  <ChevronUp className="size-3.5" aria-hidden="true" />
                </Button>
              </span>
            </Tooltip>
            <Tooltip label={hits > 0 ? "Go to the next search match (Enter)" : "Search for text to enable match navigation"}>
              <span data-testid="next-match-trigger" className="inline-flex">
                <Button variant="quiet" size="icon-sm" onClick={onNext} aria-label="Next match" disabled={hits === 0}>
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                </Button>
              </span>
            </Tooltip>
          </div>
          <Tooltip label="Jump to the first ERROR/FATAL line">
            <Button variant="quiet" size="icon-sm" onClick={onFirstError} aria-label="Jump to first error">
              <AlertTriangle className="size-3.5 text-fail" aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={filter ?? "all"}
            onValueChange={(v) => onFilter(v && v !== "all" ? (v as LogLevel) : null)}
            options={LEVEL_OPTIONS}
            label="Minimum log level"
            className="min-w-36"
          />
          <Toggle
            pressed={regex}
            onPressedChange={onRegex}
            label="Regular expression search"
            hint="Treat special characters as regular-expression operators."
          >
            <Regex className="size-3.5" aria-hidden="true" />
          </Toggle>
          <Toggle
            pressed={caseSensitive}
            onPressedChange={onCase}
            label="Case-sensitive search"
            hint="Match uppercase and lowercase letters exactly."
          >
            <CaseSensitive className="size-3.5" aria-hidden="true" />
          </Toggle>
          <Toggle pressed={wrap} onPressedChange={onWrap} label="Wrap long lines" hint="Wrap long log lines to fit the viewer.">
            <WrapText className="size-3.5" aria-hidden="true" />
          </Toggle>
          <div className="inline-flex rounded-md border border-seam bg-well p-0.5" role="group" aria-label="Timestamp rendering">
            {(["absolute", "relative"] as const).map((mode) => (
              <Tooltip
                key={mode}
                label={
                  mode === "absolute"
                    ? "Show each dated timestamp as a clock time in the selected timezone."
                    : "Show milliseconds elapsed since the previous timestamp."
                }
              >
                <button
                  type="button"
                  aria-pressed={timestamp === mode}
                  aria-label={mode === "absolute" ? "Show clock time" : "Show elapsed time since previous timestamp"}
                  onClick={() => onTimestamp(mode)}
                  className={cn(
                    "inline-flex h-6 items-center rounded-sm px-2 text-small",
                    timestamp === mode ? "bg-fabric-3 text-ink" : "text-ink-3 hover:text-ink",
                  )}
                >
                  {mode === "absolute" ? "Clock time" : "Elapsed"}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
      {followDisabled && (
        <p className="border-t border-seam-soft px-3 py-1 text-caption text-ink-4">
          Follow is off in parity mode — the view is frozen so screenshots and DOM reads are stable.
        </p>
      )}
    </div>
  );
}
