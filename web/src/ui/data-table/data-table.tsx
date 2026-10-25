/**
 * DataTable — the one table for Burrow (TanStack Table v9 + TanStack Virtual).
 *
 * Features: sticky header · virtualized rows (34px pointer, 44px coarse-pointer row height) · sort (click, shift-click multi) ·
 * column chooser · column resize (persisted) · row selection (checkbox + Space) · CSV/JSON export of the current view ·
 * change flashes · loading/empty/error/stale states.
 * URL-sync is the caller's job: sorting + column visibility are CONTROLLED props (see features/apps for the pattern).
 *
 * Parity mode (docs/contracts/parity-dom.md): every column visible, NO virtualization window (all rows rendered),
 * no animations. Layout is otherwise identical.
 */
import {
  type ColumnSizingState,
  type ColumnVisibilityState,
  type RowData,
  type RowSelectionState,
  type SortingState,
  type ReactTable,
  flexRender,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, Download, X } from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cn } from "~/lib/cn";
import { EASE_OUT, flash, motionAllowed, tokenMs } from "~/lib/motion";
import { useParity } from "~/state/parity";
import { Button } from "../button";
import { Entity } from "../datum";
import { EmptyState, ErrorState, Skeleton, TableSkeleton } from "../feedback";
import { ScrollBottomFade, useHasMoreBelow } from "../scroll-bottom-fade";
import { MenuCheckboxItem, MenuContent, MenuItem, MenuRoot, MenuSeparator, MenuTrigger } from "../menu";
import { PopoverClose, PopoverContent, PopoverRoot, PopoverTrigger } from "../popover";
import { Select } from "../select";
import { HelpTip, Tooltip } from "../tooltip";
import { type ColDef, type ColMeta, type TableFeatureSet, tableFeatureSet } from "./features";
import { useElementWidth } from "~/lib/size";
import { download, toCsv, toJson, type ExportColumn } from "./export";
import type { Row } from "@tanstack/react-table";

export const ROW_HEIGHT = 34;
const TOUCH_ROW_HEIGHT = 44;
const SELECT_W = 36;
const STABLE_VIEWPORT_ROW_THRESHOLD = 4;
type CompactStateProps = { compact?: boolean };

const COARSE_POINTER_QUERY = "(pointer: coarse)";

function subscribeCoarsePointer(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(COARSE_POINTER_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getCoarsePointerSnapshot(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(COARSE_POINTER_QUERY).matches;
}

function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarsePointer, getCoarsePointerSnapshot, () => false);
}

/** DataTable keeps its scrollport size stable; only compress the feedback message inside it. */
function compactFeedback(content: ReactNode): ReactNode {
  if (!isValidElement(content) || (content.type !== EmptyState && content.type !== ErrorState)) return content;
  return cloneElement(content as ReactElement<CompactStateProps>, { compact: true });
}

/** shared empty default so the `defaultSorting` fallback keeps a stable identity */
const NO_SORTING: SortingState = [];
/** shared empty order keeps declaration order without allocating on each table render */
const NO_COLUMN_ORDER: string[] = [];
interface VisibleRowSnapshot {
  top: number;
  width: number;
  height: number;
  background: string;
  element: HTMLElement;
}

export interface DataTableProps<T extends RowData> {
  data: readonly T[];
  columns: ColDef<T>[];
  /** Optional fixed view order; omitted means the columns' declaration order. */
  columnOrder?: string[];
  getRowId: (row: T) => string;
  /** `data-ye` key for the row; defaults to the row id. */
  entityKey?: (row: T) => string;
  label: string;
  /** localStorage key for column widths */
  storageKey: string;
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  /** the sorting the caller treats as "unsorted" (e.g. the legacy default). The sort readout stays hidden while
   *  `sorting` equals it, and its Clear button restores it via `onSortingChange([])`. */
  defaultSorting?: SortingState;
  columnVisibility?: ColumnVisibilityState;
  onColumnVisibilityChange: (v: ColumnVisibilityState) => void;
  /** visibility restored by "Reset to default columns"; defaults to the `meta.defaultVisible` set */
  defaultVisibility?: ColumnVisibilityState;
  onRowActivate?: (row: T) => void;
  /** cheap string that changes iff the row's *live* values changed -> row flash */
  rowVersion?: (row: T) => string | number;
  selectable?: boolean;
  loading?: boolean;
  error?: ReactNode;
  empty?: ReactNode;
  /** rows before filtering, for the "n of m" readout */
  totalCount?: number;
  toolbar?: ReactNode;
  /** inline toolbars share the action row whenever they fit, and wrap naturally on narrow tables */
  toolbarArrangement?: "stacked" | "inline";
  /** On refresh-fed tables, lock the viewport after four rows; shorter result sets keep their compact content height. */
  stableViewport?: boolean;
  exportName: string;
  className?: string;
}

/** Id the table keys visibility and parity by: the explicit `id`, else the `accessorKey`. */
function columnId<T extends RowData>(column: ColDef<T>): string {
  if (column.id != null) return String(column.id);
  return "accessorKey" in column ? String(column.accessorKey) : "";
}

/**
 * Visibility the table starts with: every column except those marked `meta.defaultHidden`.
 *
 * A wide tree (the scheduler queue table carries 39 columns) is four screens of horizontal scroll if it opens fully
 * expanded, so the tail columns declare themselves hidden and stay one click away in the column chooser.
 */
export function defaultVisibilityOf<T extends RowData>(columns: ColDef<T>[]): ColumnVisibilityState {
  return Object.fromEntries(columns.map((c) => [columnId(c), c.meta?.defaultVisible !== false]));
}

export function DataTable<T extends RowData>(props: DataTableProps<T>) {
  const {
    data,
    columns,
    columnOrder = NO_COLUMN_ORDER,
    getRowId,
    entityKey,
    label,
    storageKey,
    sorting,
    onSortingChange,
    defaultSorting = NO_SORTING,
    columnVisibility,
    onColumnVisibilityChange,
    defaultVisibility,
    onRowActivate,
    rowVersion,
    selectable,
    loading,
    error,
    empty,
    totalCount,
    toolbar,
    toolbarArrangement = "stacked",
    stableViewport = false,
    exportName,
    className,
  } = props;
  const parity = useParity();
  const rowH = useCoarsePointer() ? TOUCH_ROW_HEIGHT : ROW_HEIGHT;
  const resetVisibility = defaultVisibility ?? defaultVisibilityOf(columns);

  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => readSizing(storageKey));
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  useEffect(() => writeSizing(storageKey, columnSizing), [storageKey, columnSizing]);

  // parity: show every column regardless of URL/user state
  const effectiveVisibility = useMemo<ColumnVisibilityState>(() => {
    const base = columnVisibility ?? resetVisibility;
    if (!parity) return base;
    return Object.fromEntries(columns.map((c) => [columnId(c), true]));
  }, [parity, columnVisibility, columns, resetVisibility]);

  const table = useTable({
    features: tableFeatureSet,
    columns,
    data: data as T[],
    getRowId: (row) => getRowId(row as T),
    state: { sorting, columnOrder, columnVisibility: effectiveVisibility, columnSizing, rowSelection },
    onSortingChange: (u) => onSortingChange(typeof u === "function" ? u(sorting) : u),
    onColumnVisibilityChange: (u) => onColumnVisibilityChange(typeof u === "function" ? u(columnVisibility ?? resetVisibility) : u),
    onColumnSizingChange: setColumnSizing,
    onRowSelectionChange: setRowSelection,
    columnResizeMode: "onChange",
    enableRowSelection: !!selectable,
    enableMultiSort: true,
    /* The legacy UI is DataTables with the default `asSorting: ['asc','desc']`: the first click on any column sorts
       ascending (every header there says "activate to sort column ascending"), and a second click flips the direction —
       there is no third "unsorted" state to land in. TanStack would otherwise infer `desc` first for numeric columns
       and cycle through removal, which both broke parity and left the *default-sorted* column (the apps id) with a dead
       header click. Clearing a sort is the sort panel's job, where the button says so. */
    enableSortingRemoval: false,
    defaultColumn: { size: 140, minSize: 56, maxSize: 640, sortDescFirst: false },
  });

  const rows = table.getRowModel().rows as Row<TableFeatureSet, T>[];
  const leafCols = table.getVisibleLeafColumns();
  const [widthRef, viewportW] = useElementWidth<HTMLDivElement>(0);
  /* On a phone the table shows two whole columns and scrolls for the rest: a column and a half cut mid-cell reads as
     broken, and the columns that follow are one swipe away. A column that declares its own `size` is content-shaped
     (a 40px id column must not reserve half the screen), so it keeps that; only a default-width grid column takes the
     phone half. Above the breakpoint the designed widths apply and the slack is spread proportionally, so the header
     and rows reach the right edge instead of stopping short of it. */
  const twoUp = viewportW > 0 && viewportW < 640 ? Math.floor(viewportW / 2) : 0;
  const baseWidths = leafCols.map((c, i) => {
    if (twoUp > 0 && i < 2 && c.columnDef.size == null) return twoUp;
    return c.getSize();
  });
  const rawWidth = baseWidths.reduce((a, w) => a + w, 0) + (selectable ? SELECT_W : 0);
  const grow = viewportW > 0 && rawWidth > 0 && rawWidth < viewportW ? viewportW / rawWidth : 1;
  const widths = new Map(leafCols.map((c, i) => [c.id, Math.round((baseWidths[i] ?? c.getSize()) * grow)]));
  const totalWidth = Math.round(rawWidth * grow);
  const hasHorizontalOverflow = viewportW > 0 && totalWidth > viewportW;
  // `pinned` columns form a leading identity strip. Keep that strip in view while users scan wide tables.
  const pinnedOffsets = new Map<string, number>();
  let pinnedPrefix = true;
  let pinnedLeft = selectable ? Math.round(SELECT_W * grow) : 0;
  for (const column of leafCols) {
    const meta = column.columnDef.meta as { pinned?: boolean } | undefined;
    if (!pinnedPrefix || !meta?.pinned) {
      pinnedPrefix = false;
      continue;
    }
    pinnedOffsets.set(column.id, pinnedLeft);
    pinnedLeft += widths.get(column.id) ?? Math.round(column.getSize() * grow);
  }
  const selectionPinned = !!selectable && pinnedOffsets.size > 0;

  // the toolbar readout: which columns are sorted, in order, and whether that is just the caller's default
  const columnLabel = (id: string) => {
    const meta = table.getColumn(id)?.columnDef.meta as { label?: string } | undefined;
    return meta?.label ?? id;
  };
  const sortLabel = (s: SortingState[number]) => `${columnLabel(s.id)} ${s.desc ? "↓" : "↑"}`;
  /* a stale URL can name a column that no longer exists: drop it from the readout (the table itself already ignores it) */
  const activeSorts = sorting.filter((s) => table.getColumn(s.id));
  const sortedBy = activeSorts.map(sortLabel);
  const primarySort = activeSorts[0];
  const sortIsDefault =
    sorting.length === defaultSorting.length &&
    sorting.every((s, i) => s.id === defaultSorting[i]?.id && s.desc === defaultSorting[i]?.desc);
  const isSoleDefaultSort = sortIsDefault && activeSorts.length === 1;
  const addableColumns = leafCols
    .filter((c) => !sorting.some((s) => s.id === c.id))
    .map((c) => ({ value: c.id, label: columnLabel(c.id) }));
  const sortActive = activeSorts.length > 0 && !sortIsDefault;

  const scrollRef = useRef<HTMLDivElement>(null);
  const moreRightRef = useRef(false);
  const [moreRight, setMoreRight] = useState(false);
  const syncOverflowCue = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const next = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
    if (next !== moreRightRef.current) {
      moreRightRef.current = next;
      setMoreRight(next);
    }
  }, []);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 14,
    enabled: !parity,
  });
  useEffect(() => virt.measure(), [rowH, virt]);

  const exportCols = useMemo<ExportColumn[]>(
    () =>
      leafCols.map((c) => {
        const meta = c.columnDef.meta as { label?: string; exportValue?: (r: unknown) => unknown } | undefined;
        return {
          id: c.id,
          label: meta?.label ?? c.id,
          value: (r: unknown) => (meta?.exportValue ? meta.exportValue(r) : (c.accessorFn?.(r as never, 0) as unknown)),
        };
      }),
    [leafCols],
  );
  const doExport = (kind: "csv" | "json") => {
    const selected = rows.filter((r) => r.getIsSelected());
    const source = (selected.length ? selected : rows).map((r) => r.original);
    if (kind === "csv") download(`${exportName}.csv`, "text/csv", toCsv(exportCols, source));
    else download(`${exportName}.json`, "application/json", toJson(exportCols, source));
  };

  const selectedCount = rows.filter((row) => row.getIsSelected()).length;
  const showBody = !loading && !error && rows.length > 0;
  const unavailable = !!error && data.length === 0;
  const hideControls = unavailable;
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { visible: moreBelow, sync: syncVerticalOverflowCue } = useHasMoreBelow(scrollRef, showBody, contentRef);
  const syncScrollCues = useCallback(() => {
    syncOverflowCue();
    syncVerticalOverflowCue();
  }, [syncOverflowCue, syncVerticalOverflowCue]);
  const priorRows = useRef<{
    data: readonly T[];
    ids: Set<string>;
    ready: boolean;
    rows: Map<string, VisibleRowSnapshot>;
  } | null>(null);
  const reflowAnimations = useRef<Animation[]>([]);
  const exitAnimations = useRef(new Map<Animation, HTMLElement>());
  const exitLayerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    reflowAnimations.current.forEach((animation) => {
      animation.cancel();
    });
    reflowAnimations.current = [];

    const scroller = scrollRef.current;
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const currentRows = new Map<string, VisibleRowSnapshot>();
    const rowElements = Array.from(scroller.querySelectorAll<HTMLElement>(".burrow-row[data-ye]"));
    for (const row of rowElements) {
      const id = row.dataset.ye;
      if (!id) continue;
      const rect = row.getBoundingClientRect();
      const background = getComputedStyle(row).backgroundColor;
      currentRows.set(id, {
        top: rect.top - scrollerRect.top - scroller.clientTop + scroller.scrollTop,
        width: rect.width,
        height: rect.height,
        background: background === "rgba(0, 0, 0, 0)" ? getComputedStyle(scroller.parentElement ?? scroller).backgroundColor : background,
        element: row,
      });
    }

    const previous = priorRows.current;
    const dataChanged = !previous || previous.data !== data;
    const currentIds = dataChanged
      ? new Set(data.map((item) => (entityKey ? entityKey(item) : getRowId(item))))
      : (previous?.ids ?? new Set<string>());
    // DataTable owns this behavior for every table. Compare row identities on data changes, but
    // refresh the visible-row snapshot on every commit so virtual scrolling cannot look like removal.
    if (previous && previous.data !== data && previous.ready && motionAllowed()) {
      const duration = tokenMs(scroller, "--dur-content", 220);
      if (duration > 0) {
        const exitLayer = exitLayerRef.current;
        if (exitLayer) {
          for (const [id, snapshot] of previous.rows) {
            if (currentRows.has(id) || currentIds.has(id) || typeof HTMLElement.prototype.animate !== "function") continue;
            const exiting = snapshot.element.cloneNode(true) as HTMLElement;
            exiting.removeAttribute("data-ye");
            exiting.removeAttribute("id");
            exiting.querySelectorAll("[id], [data-ye], [data-yf], [data-yv]").forEach((element) => {
              element.removeAttribute("id");
              element.removeAttribute("data-ye");
              element.removeAttribute("data-yf");
              element.removeAttribute("data-yv");
            });
            exiting.setAttribute("aria-hidden", "true");
            exiting.setAttribute("inert", "");
            exiting.setAttribute("role", "presentation");
            Object.assign(exiting.style, {
              position: "absolute",
              top: `${snapshot.top - scroller.scrollTop}px`,
              left: `${-scroller.scrollLeft}px`,
              width: `${snapshot.width}px`,
              height: `${snapshot.height}px`,
              margin: "0",
              backgroundColor: snapshot.background,
              contentVisibility: "visible",
              transform: "none",
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
            exitAnimations.current.set(animation, exiting);
            const removeExit = () => {
              exiting.remove();
              exitAnimations.current.delete(animation);
            };
            animation.onfinish = removeExit;
            animation.oncancel = removeExit;
          }
        }

        for (const row of rowElements) {
          const id = row.dataset.ye;
          if (!id || previous.ids.has(id) || typeof row.animate !== "function") continue;
          const targetTransform = getComputedStyle(row).transform;
          const startTransform = targetTransform === "none" ? "translateX(8px)" : `translateX(8px) ${targetTransform}`;
          const animation = row.animate(
            [
              { opacity: 0, transform: startTransform },
              { opacity: 1, transform: targetTransform },
            ],
            { duration, easing: EASE_OUT },
          );
          reflowAnimations.current.push(animation);
        }

        for (const row of rowElements) {
          const id = row.dataset.ye;
          const from = id ? previous.rows.get(id)?.top : undefined;
          const to = id ? currentRows.get(id)?.top : undefined;
          if (from === undefined || to === undefined) continue;
          const delta = from - to;
          if (Math.abs(delta) < 1 || typeof row.animate !== "function") continue;
          const targetTransform = getComputedStyle(row).transform;
          const startTransform = targetTransform === "none" ? `translateY(${delta}px)` : `translateY(${delta}px) ${targetTransform}`;
          const animation = row.animate([{ transform: startTransform }, { transform: targetTransform }], {
            duration,
            easing: EASE_OUT,
          });
          reflowAnimations.current.push(animation);
        }
      }
    }
    priorRows.current = { data, ids: currentIds, ready: !loading && !error, rows: currentRows };
    // A filter can shrink the table without changing its scrollport dimensions. Recheck against
    // the committed content height so exit-animation overlays do not count as scrollable rows.
    syncVerticalOverflowCue();
  });
  useLayoutEffect(
    () => () => {
      reflowAnimations.current.forEach((animation) => {
        animation.cancel();
      });
      for (const [animation, element] of exitAnimations.current) {
        animation.cancel();
        element.remove();
      }
      reflowAnimations.current = [];
      exitAnimations.current.clear();
    },
    [],
  );
  const [chromeH, setChromeH] = useState(0);
  const [fitH, setFitH] = useState(0);
  /* Short results should not occupy an empty pane. In the default mode, remember the chrome around the scroller
     (toolbar, footer, borders) and the rendered content (header block + rows). Refresh-fed tables can opt into a
     stable viewport once they exceed a few rows, so later polls cannot keep growing or shrinking the page. */
  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!root || !scroller || !content) return;
    setChromeH(Math.max(0, root.offsetHeight - scroller.offsetHeight));
    setFitH(content.offsetHeight);
    syncOverflowCue();
  });
  const fixedViewport = stableViewport && (!showBody || rows.length > STABLE_VIEWPORT_ROW_THRESHOLD);
  const capH = !fixedViewport && showBody && chromeH > 0 && fitH > 0 ? chromeH + fitH : undefined;
  const vItems = parity ? null : virt.getVirtualItems();

  const renderRow = (index: number, offset: number | null) => {
    const row = rows[index];
    if (!row) return null;
    return (
      <TableRow
        key={row.id}
        row={row}
        index={index}
        entity={entityKey ? entityKey(row.original as T) : row.id}
        height={rowH}
        offset={offset}
        width={totalWidth}
        grow={grow}
        widths={widths}
        selected={row.getIsSelected()}
        selectable={!!selectable}
        selectionPinned={selectionPinned}
        pinnedOffsets={pinnedOffsets}
        version={rowVersion ? rowVersion(row.original as T) : undefined}
        onActivate={onRowActivate ? () => onRowActivate(row.original as T) : undefined}
        /* sizing/visibility are read in the row via columns, so re-render when they change */
        layoutKey={`${columnSizing ? Object.values(columnSizing).join(".") : ""}|${leafCols.map((c) => `${c.id}:${widths.get(c.id)}:${pinnedOffsets.get(c.id) ?? ""}`).join(",")}|${totalWidth}`}
      />
    );
  };

  return (
    <div
      ref={rootRef}
      data-burrow-table-root={storageKey}
      style={capH != null ? { maxHeight: capH } : undefined}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className, fixedViewport && "h-[min(34dvh,360px)]", showBody && "min-h-0")}
    >
      {!hideControls && (
        <fieldset
          disabled={loading}
          aria-label={`${label} table controls`}
          className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0 pb-2"
        >
          {/* Filter toolbars use a full line on narrow screens; inline toolbars wrap naturally with the action buttons. */}
          <div
            className={cn(
              "flex min-w-0 flex-wrap items-center gap-2",
              toolbar ? (toolbarArrangement === "inline" ? "flex-1 basis-auto" : "basis-full xl:flex-1 xl:basis-auto") : "flex-1",
            )}
          >
            {toolbar}
          </div>
          {/* the buttons move as one unit: the group either shares the row with the toolbar or wraps under it whole; on a
            phone the buttons wrap *within* the group (`flex-wrap`, no `shrink-0` — a content-sized box that cannot
            shrink would push the page sideways instead) */}
          <div className="flex min-w-0 flex-wrap items-center gap-2" data-burrow-table-actions>
            {/* Same button bar as Columns/Export: always present, highlighted while a sort is active (the facets' pattern).
              Bounded by design — the trigger names the primary sort plus the count, never a row of chips that grows. */}
            <PopoverRoot>
              <PopoverTrigger
                render={
                  <Button
                    size="sm"
                    variant={sortActive ? "default" : "quiet"}
                    className={cn("max-w-[18rem] gap-1.5", sortActive && "border-live text-live")}
                  />
                }
                aria-label={sortActive ? `Sort order: ${sortedBy.join(", ")}` : "Sort order: none"}
                data-burrow-sort={sortActive ? sortedBy.join(",") : ""}
              >
                <ArrowUpDown className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="shrink-0">Sort</span>
                {sortActive && primarySort && <span className="min-w-0 truncate opacity-80">{sortLabel(primarySort)}</span>}
                {sortActive && activeSorts.length > 1 && (
                  <span className="rounded-full bg-fabric-3 px-1.5 text-micro text-ink-2 tnum">{activeSorts.length}</span>
                )}
              </PopoverTrigger>
              <PopoverContent title="Sort order" align="end" className="w-[20rem]">
                {activeSorts.length > 0 && (
                  <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
                    {activeSorts.map((s, i) => (
                      <li key={s.id} className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-fabric-3">
                        <span className="w-4 shrink-0 text-right text-micro text-ink-4 tnum">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-small text-ink">{columnLabel(s.id)}</span>
                        <Tooltip label={s.desc ? "Descending — click for ascending" : "Ascending — click for descending"}>
                          <button
                            type="button"
                            onClick={() => onSortingChange(sorting.map((x) => (x.id === s.id ? { ...x, desc: !x.desc } : x)))}
                            aria-label={`${columnLabel(s.id)} sorted ${s.desc ? "descending" : "ascending"} — switch direction`}
                            className="shrink-0 rounded-sm p-1 text-live hover:bg-fabric-3"
                          >
                            {s.desc ? (
                              <ArrowDown className="size-3.5" aria-hidden="true" />
                            ) : (
                              <ArrowUp className="size-3.5" aria-hidden="true" />
                            )}
                          </button>
                        </Tooltip>
                        {isSoleDefaultSort ? (
                          /* An empty sort maps back to this default, so it is only removable when another sort remains. */
                          <span className="shrink-0 text-micro text-ink-4">default</span>
                        ) : (
                          <Tooltip label={`Remove sort on ${columnLabel(s.id)}`}>
                            <button
                              type="button"
                              onClick={() => onSortingChange(sorting.filter((x) => x.id !== s.id))}
                              aria-label={`Remove sort on ${columnLabel(s.id)}`}
                              className="shrink-0 rounded-sm p-1 text-ink-4 hover:text-ink"
                            >
                              <X className="size-3.5" aria-hidden="true" />
                            </button>
                          </Tooltip>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                <div className="mt-2 border-t border-seam pt-2">
                  <Select
                    label="Add sort column"
                    value={null}
                    placeholder="Add a column to sort…"
                    options={addableColumns}
                    onValueChange={(id) => {
                      /* with only the caller's default active, the added column becomes the primary sort — appending to
                       the default would silently make every new sort secondary */
                      if (id) onSortingChange(sortIsDefault ? [{ id, desc: false }] : [...sorting, { id, desc: false }]);
                    }}
                    className="w-full"
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-seam pt-2">
                  {!sortIsDefault ? (
                    <Button size="sm" variant="ghost" onClick={() => onSortingChange(NO_SORTING)}>
                      Clear sort
                    </Button>
                  ) : (
                    <span className="text-micro text-ink-4">This is the table's default order</span>
                  )}
                  <PopoverClose render={<Button size="sm" variant="quiet" />}>Done</PopoverClose>
                </div>
              </PopoverContent>
            </PopoverRoot>
            {selectedCount > 0 && (
              <span className="flex items-center gap-1 text-small text-ink-2">
                <span className="tnum">{selectedCount}</span> selected
                <Button variant="ghost" size="sm" onClick={() => setRowSelection({})}>
                  Clear
                </Button>
              </span>
            )}
            <ColumnChooser table={table} onReset={() => onColumnVisibilityChange(resetVisibility)} />
            <MenuRoot>
              <MenuTrigger render={<Button aria-label="Export" />}>
                <Download className="size-3.5" aria-hidden="true" />
                Export
              </MenuTrigger>
              <MenuContent>
                <MenuItem onClick={() => doExport("csv")}>CSV{selectedCount ? ` (${selectedCount} selected)` : " (current view)"}</MenuItem>
                <MenuItem onClick={() => doExport("json")}>
                  JSON{selectedCount ? ` (${selectedCount} selected)` : " (current view)"}
                </MenuItem>
              </MenuContent>
            </MenuRoot>
          </div>
        </fieldset>
      )}

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-seam bg-fabric">
        <div
          ref={(el) => {
            scrollRef.current = el;
            widthRef.current = el;
          }}
          role="table"
          aria-label={label}
          aria-rowcount={rows.length + 1}
          aria-colcount={leafCols.length + (selectable ? 1 : 0)}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the native scrollport needs keyboard scrolling for overflow columns and rows.
          tabIndex={0}
          aria-busy={loading || undefined}
          onScroll={syncScrollCues}
          data-burrow-table={storageKey}
          data-burrow-rows={rows.length}
          className="burrow-scroll burrow-table-scroll relative min-h-0 min-w-0 flex-1 overflow-auto"
        >
          {/* the cap effect measures this box (header block + rows) */}
          <div ref={contentRef} style={{ width: totalWidth, minWidth: "100%" }}>
            {/* header */}
            <div role="rowgroup" className="sticky top-0 z-sticky border-b border-seam bg-fabric-2">
              {table.getHeaderGroups().map((hg) => (
                <div key={hg.id} role="row" className="flex" style={{ height: "var(--table-header-h, 32px)", width: totalWidth }}>
                  {selectable && (
                    <div
                      role="columnheader"
                      className={cn(
                        "grid shrink-0 place-items-center",
                        selectionPinned && "burrow-pinned-header border-r border-seam-soft",
                      )}
                      style={{
                        width: Math.round(SELECT_W * grow),
                        ...(selectionPinned ? { position: "sticky", left: 0, zIndex: 2 } : {}),
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label="Select all rows"
                        checked={table.getIsAllRowsSelected()}
                        ref={(el) => {
                          if (el) el.indeterminate = table.getIsSomeRowsSelected();
                        }}
                        onChange={table.getToggleAllRowsSelectedHandler()}
                        className="size-3.5 accent-(--live)"
                      />
                    </div>
                  )}
                  {hg.headers.map((h) => {
                    const meta = h.column.columnDef.meta as ColMeta | undefined;
                    const label = meta?.label ?? h.column.id;
                    const sort = h.column.getIsSorted();
                    const canSort = h.column.getCanSort();
                    return (
                      <div
                        key={h.id}
                        role="columnheader"
                        aria-sort={sort === "asc" ? "ascending" : sort === "desc" ? "descending" : canSort ? "none" : undefined}
                        data-col={h.column.id}
                        className={cn(
                          "group relative flex shrink-0 items-center text-small font-medium text-ink-3",
                          pinnedOffsets.has(h.column.id) && "burrow-pinned-header border-r border-seam-soft",
                        )}
                        style={{
                          width: widths.get(h.column.id) ?? Math.round(h.getSize() * grow),
                          ...(pinnedOffsets.has(h.column.id)
                            ? { position: "sticky", left: pinnedOffsets.get(h.column.id), zIndex: 2 }
                            : {}),
                        }}
                      >
                        <Tooltip
                          label={
                            <>
                              <span className="block font-medium">{label}</span>
                              {meta?.hint && <span className="block">{meta.hint}</span>}
                              {canSort && (
                                <span className="block text-ink-3">
                                  Sort by this column. Shift-click adds a secondary sort; use Sort for touch controls.
                                </span>
                              )}
                            </>
                          }
                        >
                          <button
                            type="button"
                            aria-disabled={!canSort || undefined}
                            onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                            className={cn(
                              "flex h-full min-w-0 flex-1 items-center gap-1 px-(--cell-px) hover:text-ink",
                              meta?.align === "end" && "flex-row-reverse text-right",
                              sort && "text-ink",
                            )}
                          >
                            <span className={cn("min-w-0", meta?.wrapHeader ? "flex-1 whitespace-normal leading-tight" : "truncate")}>
                              {label}
                            </span>
                            {sort && (
                              // one glyph that rotates: a swap between two mounts could not be transitioned at all
                              <ArrowUp
                                className={cn(
                                  "size-3 shrink-0 text-live transition-transform duration-(--dur-fast) ease-(--ease-out)",
                                  sort === "desc" && "rotate-180",
                                )}
                                aria-hidden="true"
                              />
                            )}
                          </button>
                        </Tooltip>
                        {meta?.hint && (
                          <HelpTip label={label} className="mr-1">
                            {meta.hint}
                          </HelpTip>
                        )}
                        {h.column.getCanResize() && (
                          <Tooltip label={`Drag to resize ${label}; double-click to reset its width`}>
                            <div
                              role="separator"
                              aria-orientation="vertical"
                              aria-label={`Resize ${label}`}
                              onMouseDown={h.getResizeHandler()}
                              onTouchStart={h.getResizeHandler()}
                              onDoubleClick={() => h.column.resetSize()}
                              className={cn(
                                "absolute top-1 right-0 bottom-1 w-1.5 cursor-col-resize touch-none rounded-full bg-transparent hover:bg-seam-strong",
                                h.column.getIsResizing() && "bg-live",
                              )}
                            />
                          </Tooltip>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* body */}
            <div
              role="rowgroup"
              className={cn(
                "relative transition-opacity duration-(--dur-content) ease-(--ease-out)",
                showBody ? "opacity-100" : "opacity-0",
              )}
              style={parity || !showBody ? undefined : { height: rows.length * rowH }}
            >
              {showBody && (parity ? rows.map((_, i) => renderRow(i, null)) : vItems?.map((v) => renderRow(v.index, v.start)))}
            </div>
          </div>
        </div>
        {/* Fading removed rows must never extend the table's native scroll range. */}
        <div ref={exitLayerRef} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 bottom-7 z-10 overflow-hidden" />
        <div
          aria-hidden="true"
          className={cn(
            "burrow-table-edge-fade pointer-events-none absolute top-0 right-0 bottom-7 z-rail w-12 transition-opacity duration-(--dur-fade)",
            hasHorizontalOverflow && moreRight ? "opacity-100" : "opacity-0",
          )}
        />
        <ScrollBottomFade visible={moreBelow} />
        {/* Keep loading and empty states out of flex flow so the scrollport does not resize when data arrives. */}
        {!showBody && (
          <div className="absolute inset-x-0 top-[calc(var(--table-header-h,32px)+1px)] bottom-7 z-10 min-h-0 overflow-x-hidden overflow-y-auto p-4">
            {loading ? (
              <TableSkeleton rows={10} cols={Math.min(8, leafCols.length)} />
            ) : (
              <div className="grid min-h-full place-items-center">{compactFeedback(error ?? empty)}</div>
            )}
          </div>
        )}
        <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-seam bg-fabric-2 px-3 text-small text-ink-3">
          <div className="min-w-0">
            {loading ? (
              <Skeleton className="h-2.5 w-12" />
            ) : !unavailable ? (
              <span className="tnum">
                {rows.length.toLocaleString("en-US")}
                {totalCount != null && totalCount !== rows.length ? ` of ${totalCount.toLocaleString("en-US")}` : ""}{" "}
                {rows.length === 1 ? "row" : "rows"}
              </span>
            ) : null}
          </div>
          {!hideControls && (
            <span className="ml-auto flex min-w-0 items-center gap-2 text-micro">
              {hasHorizontalOverflow && (
                <span className="shrink-0 font-medium text-ink-3">
                  <span className="sm:hidden">Swipe ↔</span>
                  <span className="hidden sm:inline">Scroll for more columns</span>
                </span>
              )}
              <span className="hidden text-ink-3 md:inline">{selectable && <>Space select · </>}shift-click header: multi-sort</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

interface TableRowProps<T extends RowData> {
  row: Row<TableFeatureSet, T>;
  index: number;
  entity: string;
  height: number;
  offset: number | null;
  width: number;
  /** fill factor applied to every cell so the row reaches the viewport's right edge (1 = columns already wider) */
  grow: number;
  /** rendered width per visible column id (phone: two columns fill the viewport, the rest scroll) */
  widths: Map<string, number>;
  selectionPinned: boolean;
  pinnedOffsets: ReadonlyMap<string, number>;
  selected: boolean;
  selectable: boolean;
  version: string | number | undefined;
  onActivate?: () => void;
  layoutKey: string;
}

const TableRowInner = <T extends RowData>({
  row,
  index,
  entity,
  height,
  offset,
  width,
  grow,
  widths,
  selectionPinned,
  pinnedOffsets,
  selected,
  selectable,
  version,
  onActivate,
}: TableRowProps<T>) => {
  const flashRef = useRef<HTMLSpanElement>(null);
  const prev = useRef<{ version: string | number | undefined; hasPulsingStatus: boolean }>({
    version,
    hasPulsingStatus: false,
  });
  const parity = useParity();
  useEffect(() => {
    const row = flashRef.current?.closest<HTMLElement>(".burrow-row");
    const hasPulsingStatus = Boolean(row?.querySelector(".burrow-dot-pulse"));
    if (version === undefined || prev.current.version === version) {
      prev.current = { version, hasPulsingStatus };
      return;
    }
    const wasPulsing = prev.current.hasPulsingStatus;
    prev.current = { version, hasPulsingStatus };
    // The status pill is the live cue, as on Applications; don't stack a transient row flash under its pulse ring.
    if (wasPulsing || hasPulsingStatus) return;
    // one gate for JS motion (`~/lib/motion`), one duration (`--dur-flash`): the cue cannot drift from the token
    const animation = flashRef.current ? flash(flashRef.current) : undefined;
    return () => animation?.cancel();
  }, [version]);

  return (
    <Entity
      id={entity}
      as="div"
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selectable ? selected : undefined}
      data-selected={selected}
      className={cn(
        "burrow-row group/row relative flex items-stretch border-b border-seam-soft",
        parity && "burrow-row-static",
        !parity && "absolute left-0",
      )}
      style={{ height, width, ...(offset == null ? {} : { transform: `translateY(${offset}px)` }) }}
      onClick={onActivate}
    >
      <span ref={flashRef} aria-hidden="true" className="pointer-events-none absolute inset-0 bg-live opacity-0" />
      {selectable && (
        <div
          role="cell"
          className={cn("grid shrink-0 place-items-center", selectionPinned && "burrow-pinned-cell")}
          style={{
            width: Math.round(SELECT_W * grow),
            ...(selectionPinned ? { position: "sticky", left: 0, zIndex: 1 } : {}),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            aria-label={`Select ${entity}`}
            checked={selected}
            onChange={row.getToggleSelectedHandler()}
            className="size-3.5 accent-(--live)"
          />
        </div>
      )}
      {row.getVisibleCells().map((cell) => {
        const meta = cell.column.columnDef.meta as { align?: string } | undefined;
        const pinnedLeft = pinnedOffsets.get(cell.column.id);
        return (
          <div
            key={cell.id}
            role="cell"
            className={cn(
              "flex min-w-0 shrink-0 cursor-default items-center overflow-hidden px-(--cell-px) text-cell",
              pinnedLeft != null && "burrow-pinned-cell",
              meta?.align === "end" && "justify-end text-right",
            )}
            style={{
              width: widths.get(cell.column.id) ?? Math.round(cell.column.getSize() * grow),
              ...(pinnedLeft != null ? { position: "sticky", left: pinnedLeft, zIndex: 1 } : {}),
            }}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </div>
        );
      })}
    </Entity>
  );
};

const TableRow = memo(TableRowInner, (a, b) => {
  // data refs change every poll but `version` captures live changes; layoutKey covers resize/visibility.
  return (
    a.row.original === b.row.original &&
    a.index === b.index &&
    a.offset === b.offset &&
    a.height === b.height &&
    a.width === b.width &&
    a.selected === b.selected &&
    a.layoutKey === b.layoutKey &&
    a.version === b.version
  );
}) as typeof TableRowInner;

function ColumnChooser<T extends RowData>({ table, onReset }: { table: ReactTable<TableFeatureSet, T>; onReset: () => void }) {
  const all = table.getAllLeafColumns();
  const visible = all.filter((c) => c.getIsVisible()).length;
  return (
    <MenuRoot>
      <MenuTrigger render={<Button aria-label="Choose columns" />}>
        <Columns3 className="size-3.5" aria-hidden="true" />
        Columns
        <span className="rounded-full bg-fabric-3 px-1.5 text-micro text-ink-2 tnum">
          {visible}/{all.length}
        </span>
      </MenuTrigger>
      <MenuContent className="max-h-[70dvh] overflow-auto">
        {all.map((c) => {
          const meta = c.columnDef.meta as { label?: string } | undefined;
          return (
            <MenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(v)}>
              {meta?.label ?? c.id}
            </MenuCheckboxItem>
          );
        })}
        <MenuSeparator />
        <MenuItem onClick={onReset}>Reset to default columns</MenuItem>
        <MenuItem onClick={() => table.toggleAllColumnsVisible(true)}>Show all columns</MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}

function readSizing(key: string): ColumnSizingState {
  try {
    return JSON.parse(localStorage.getItem(`burrow.cols.${key}`) ?? "{}") as ColumnSizingState;
  } catch {
    return {};
  }
}
function writeSizing(key: string, s: ColumnSizingState): void {
  try {
    localStorage.setItem(`burrow.cols.${key}`, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
