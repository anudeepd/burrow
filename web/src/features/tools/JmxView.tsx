/**
 * JMX / Server metrics — `/tools/jmx`. The modern replacement for the RM's legacy "JMX" tool page, and for the same page on
 * a NodeManager (`?host=<nm:port>`, linked from node detail).
 *
 * 75 beans / ~2400 attributes / 464 KB of open-ended JSON cannot be a table: the payload is a tree. So the page renders a
 * virtualized tree browser (bean groups -> beans -> attributes -> nested objects/arrays), with type-aware rendering,
 * 1024-based hints for byte/memory/time attributes, a search that auto-expands the path to every match, and a details pane
 * for the selected bean/attribute. `?qry=` selects the daemon-side MBean pattern, so a filtered view stays linkable.
 *
 * Parity: entity = MBean name (`data-ye`), field = `"jmx." + attribute path` (`data-yf`), raw upstream value = `data-yv`.
 * JMX is open-ended, so that field-id grammar is the documented deviation (see features/tools/jmx.ts header).
 */
import { useQuery } from "@tanstack/react-query";
import type { JmxBean } from "~/api/schemas";
import { getRouteApi } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Layers, Minus, PanelRight, RotateCw, Search, X } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nq } from "~/api/queries/nodes";
import { tq } from "~/api/queries/tools";
import { CopyButton, PageHead, SearchField, Section, Stat } from "~/features/nodes/page";
import { cn } from "~/lib/cn";
import { utilizationTone } from "~/lib/progress-tone";
import { revealDetail } from "~/lib/reveal";
import { fmtBytes, fmtClock, type TzMode } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { useParity } from "~/state/parity";
import { Button } from "~/ui/button";
import { ROW_HEIGHT } from "~/ui/data-table/data-table";
import { Datum, Entity } from "~/ui/datum";
import { CenteredPageState, EmptyState, ErrorState, Skeleton, StaleErrorBanner, TableSkeleton } from "~/ui/feedback";
import { ScrollBottomFade, useHasMoreBelow } from "~/ui/scroll-bottom-fade";
import { ProgressBar } from "~/ui/progress-bar";
import { Select } from "~/ui/select";
import {
  allExpandableIds,
  ancestorIds,
  attrFieldId,
  beanShort,
  buildJmxTree,
  findBeanNode,
  findValueNode,
  flattenJmxTree,
  JMX_PATTERNS,
  jmxBranchSummary,
  jmxErrorBean,
  jmxMemoryShape,
  jmxNumberHint,
  jmxScalarText,
  jmxValueJson,
  jmxValueKind,
  jmxValueText,
  matchJmxTree,
  memoryPercent,
  memorySummary,
  parseObjectName,
  truncateMiddle,
  type JmxMemory,
  type JmxNode,
  type JmxTree,
} from "./jmx";
import { HighlightedText } from "./highlighted-text";
import { handleTreeNavigationKey } from "./tree-navigation";
import { OptionalTooltip } from "~/ui/tooltip";

const route = getRouteApi("/tools/jmx");

/** Render probe the e2e spec reads: `performance.now()` of the paint that followed a row-count change. */
interface JmxProbe {
  paintedAt: number;
  rows: number;
  paints: number;
}
declare global {
  interface Window {
    __BURROW_JMX__?: JmxProbe;
  }
}

export function JmxView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const parity = useParity();
  const tz = usePref("tz");
  const rowH = ROW_HEIGHT;

  const host = search.host;
  const pattern = search.qry ?? "";
  // `tq.jmx` already selects the bean array; the NM factory returns the raw `{beans}` envelope, so it gets the same select.
  const query = useMemo(
    () => (host ? { ...nq.nmJmx(host, pattern), select: (r: { beans: JmxBean[] }): JmxBean[] => r.beans } : tq.jmx(pattern)),
    [host, pattern],
  );
  const { data, error, isPending, isFetching, dataUpdatedAt, refetch } = useQuery(query);
  const beans = useMemo(() => data ?? [], [data]);

  const tree = useMemo(() => buildJmxTree(beans), [beans]);
  const errorBean = useMemo(() => {
    for (const bean of beans) {
      const err = jmxErrorBean(bean);
      if (err) return err;
    }
    return null;
  }, [beans]);

  const [expandedOverride, setExpandedOverride] = useState<ReadonlySet<string> | null>(null);
  // Default: the bean groups are open (25 groups + 75 beans on the first paint). `null` means "not touched yet".
  const expanded = useMemo(() => expandedOverride ?? new Set(tree.roots.map((root) => root.id)), [expandedOverride, tree]);
  const setExpanded = useCallback(
    (action: SetStateAction<ReadonlySet<string>>) => {
      setExpandedOverride((prev) => {
        const base = prev ?? new Set(tree.roots.map((root) => root.id));
        return typeof action === "function" ? action(base) : action;
      });
    },
    [tree],
  );
  const match = useMemo(() => matchJmxTree(tree, search.q ?? ""), [tree, search.q]);
  const rows = useMemo(
    () => (errorBean ? [] : flattenJmxTree(tree, { expanded, match, all: parity })),
    [tree, expanded, match, parity, errorBean],
  );

  // A search auto-expands the path to each match, and leaves it open once the query is cleared.
  useEffect(() => {
    if (!match.active || match.expand.size === 0) return;
    setExpanded((prev) => new Set([...prev, ...match.expand]));
  }, [match]);

  // Deep link (`?bean=` / `?attr=`) — open the path so the selection is visible.
  useEffect(() => {
    if (!search.bean) return;
    const node = search.attr
      ? (findValueNode(tree, search.bean, search.attr.split(".")) ?? findBeanNode(tree, search.bean))
      : findBeanNode(tree, search.bean);
    if (!node) return;
    const ids = [...ancestorIds(node), node.id];
    setExpanded((prev) => new Set([...prev, ...ids]));
  }, [tree, search.bean, search.attr]);

  const selectedId = useMemo(() => {
    if (!search.bean) return null;
    if (search.attr) return findValueNode(tree, search.bean, search.attr.split("."))?.id ?? null;
    return findBeanNode(tree, search.bean)?.id ?? null;
  }, [tree, search.bean, search.attr]);
  const selected = selectedId ? (tree.byId.get(selectedId) ?? null) : null;
  /* selecting a bean on a narrow screen should show the pane it opened, not leave it below the fold */
  useEffect(() => {
    if (selected) revealDetail();
  }, [selected]);

  const setSearch = useCallback(
    (patch: Record<string, string | undefined>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
    },
    [navigate],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { visible: moreBelow, sync: syncScrollHint } = useHasMoreBelow(scrollRef, !isPending && !error);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 16,
    enabled: !parity,
  });
  useEffect(() => virt.measure(), [rowH, virt]);

  // One frame after the visible rows changed, so the number is "rows painted", not "state updated".
  const probe = useRef<JmxProbe>({ paintedAt: 0, rows: 0, paints: 0 });
  useEffect(() => {
    if (rows.length === 0) return;
    const frame = requestAnimationFrame(() => {
      probe.current = { paintedAt: Math.round(performance.now()), rows: rows.length, paints: probe.current.paints + 1 };
      window.__BURROW_JMX__ = probe.current;
      rootRef.current?.setAttribute("data-burrow-jmx-painted", String(probe.current.paintedAt));
    });
    return () => cancelAnimationFrame(frame);
  }, [rows]);

  const [active, setActive] = useState(0);
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));
  const rowDomId = (i: number) => `jmx-row-${i}`;

  const toggle = useCallback((node: JmxNode) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, []);

  const select = useCallback(
    (node: JmxNode) => {
      if (node.kind === "group") return;
      if (node.kind === "bean") setSearch({ bean: node.bean, attr: undefined });
      else setSearch({ bean: node.bean, attr: node.path.join(".") });
    },
    [setSearch],
  );

  const move = useCallback(
    (next: number) => {
      const n = Math.max(0, Math.min(rows.length - 1, next));
      setActive(n);
      if (!parity) virt.scrollToIndex(n, { align: "auto" });
      else document.getElementById(rowDomId(n))?.scrollIntoView({ block: "nearest" });
    },
    [rows.length, parity, virt],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowH) - 2);
    if (handleTreeNavigationKey(e.key, activeIndex, rows.length, page, move)) {
      e.preventDefault();
      return;
    }
    const row = rows[activeIndex];
    switch (e.key) {
      case "ArrowRight": {
        const open = row ? isOpenNext(rows, activeIndex) : false;
        if (row && row.children.length > 0 && !open) toggle(row);
        else move(activeIndex + 1);
        break;
      }
      case "ArrowLeft":
        if (row && isOpenNext(rows, activeIndex) && !parity && !match.active) toggle(row);
        else if (row?.parent) {
          const at = rows.findIndex((n) => n.id === row.parent?.id);
          if (at >= 0) move(at);
        }
        break;
      case " ":
        if (row && row.children.length > 0) toggle(row);
        break;
      case "Enter":
        if (row) select(row);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const valueRows = useMemo(() => rows.reduce((a, r) => a + (r.kind === "value" ? 1 : 0), 0), [rows]);

  const expandAll = useCallback(() => setExpanded(new Set(allExpandableIds(tree))), [tree]);
  const collapseAll = useCallback(() => {
    setExpanded((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (id.startsWith("g:")) next.add(id);
      return next;
    });
  }, []);

  const source = host ? `NodeManager ${host}` : "ResourceManager";

  return (
    <div
      ref={rootRef}
      className="burrow-scroll burrow-page-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-6"
      data-burrow-jmx-root="1"
    >
      <PageHead
        title={host ? `JMX · NodeManager ${host}` : "JMX"}
        description="Inspect live JMX metrics and MBeans from the selected ResourceManager or NodeManager."
        actions={
          <>
            {host && (
              <Button variant="quiet" size="sm" onClick={() => setSearch({ host: undefined })}>
                ResourceManager
              </Button>
            )}
            <span className="text-small text-ink-3 tnum">
              {isFetching && dataUpdatedAt === 0 ? "reading…" : dataUpdatedAt > 0 ? `read ${fmtClock(dataUpdatedAt, tz)}` : ""}
            </span>
            <Button variant="quiet" size="sm" onClick={() => void refetch()}>
              <RotateCw className="size-3.5" aria-hidden="true" />
              Reload
            </Button>
            <Select
              label="MBean pattern"
              value={pattern}
              onValueChange={(v) => setSearch({ qry: v || undefined })}
              options={JMX_PATTERNS}
              className="w-52"
            />
          </>
        }
      />

      {error && data !== undefined && <StaleErrorBanner title="Could not refresh JMX beans" error={error} onRetry={() => void refetch()} />}
      {error && data === undefined ? (
        <CenteredPageState>
          <ErrorState
            title="Cannot read the JMX beans"
            message={error instanceof Error ? error.message : String(error)}
            hint={
              host
                ? `Burrow proxies /api/nm/${host}/jmx (the node must be in the RM's node list).`
                : "Burrow proxies /jmx from the active ResourceManager."
            }
            onRetry={() => void refetch()}
          />
        </CenteredPageState>
      ) : isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-64" />
          <TableSkeleton rows={16} cols={3} />
        </div>
      ) : errorBean ? (
        <EmptyState title="The daemon rejected this MBean pattern" icon={<Search className="size-5" aria-hidden="true" />}>
          {errorBean.message} Clear the pattern to list every bean.
        </EmptyState>
      ) : beans.length === 0 ? (
        <EmptyState title="This JVM exposes no MBeans">
          {source} answered <code className="text-micro">{'{"beans":[]}'}</code>. That usually means the daemon just started.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4" data-testid="jmx-summary">
            <Stat label="Beans" value={tree.beans} sub={`in ${tree.groups} groups`} />
            <Stat label="Attributes" value={tree.attributes} sub="top-level per bean" />
            <Stat label="Values" value={tree.values} sub="scalars, nested included" />
            <Stat
              label={match.active ? "Matches" : "Visible rows"}
              value={match.active ? match.count : rows.length}
              sub={match.active ? (valueRows > 0 ? `${valueRows} of them values` : `for “${search.q}”`) : `${valueRows} values on screen`}
              tone={match.active ? "live" : undefined}
            />
          </div>

          <div className="grid shrink-0 grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex shrink-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <SearchField
                  value={search.q ?? ""}
                  onChange={(q) => setSearch({ q: q || undefined })}
                  label="Search attributes and values"
                  placeholder="attribute path or value…"
                  className="w-full sm:w-72"
                />
                {match.active && <span className="text-small text-ink-3 tnum">{match.count} matches</span>}
                <Button variant="quiet" size="sm" onClick={expandAll} title="Expand every group, bean and nested value">
                  <Layers className="size-3.5" aria-hidden="true" /> Expand all
                </Button>
                <Button variant="quiet" size="sm" onClick={collapseAll} title="Collapse back to the bean groups">
                  <Minus className="size-3.5" aria-hidden="true" /> Contract
                </Button>
                {search.q && (
                  <Button variant="ghost" size="sm" onClick={() => setSearch({ q: undefined })}>
                    <X className="size-3.5" aria-hidden="true" /> Clear search
                  </Button>
                )}
              </div>

              <div className="relative flex h-[min(32dvh,400px)] min-h-60 flex-col overflow-hidden rounded-lg border border-seam bg-fabric sm:h-[min(48dvh,640px)] sm:min-h-72 xl:h-[min(64dvh,calc(100dvh_-_21rem),640px)]">
                <div
                  ref={scrollRef}
                  role="tree"
                  tabIndex={0}
                  aria-label={`JMX beans of the ${source}`}
                  aria-activedescendant={rows.length > 0 ? rowDomId(activeIndex) : undefined}
                  onKeyDown={onKeyDown}
                  onScroll={syncScrollHint}
                  data-burrow-jmx-tree="1"
                  data-burrow-jmx-rows={rows.length}
                  className="burrow-scroll burrow-table-scroll relative min-h-0 flex-1 overflow-auto outline-none focus-visible:outline-offset-[-2px]"
                >
                  <div role="group" className="relative" style={parity ? undefined : { height: virt.getTotalSize() }}>
                    {(parity
                      ? rows.map((node, index) => ({ node, index, start: null as number | null }))
                      : virt
                          .getVirtualItems()
                          .map((v) => ({ node: rows[v.index] as JmxNode | undefined, index: v.index, start: v.start as number | null }))
                    ).map(({ node, index, start }) =>
                      node ? (
                        <JmxRow
                          key={node.id}
                          node={node}
                          index={index}
                          height={rowH}
                          offset={start}
                          query={search.q ?? ""}
                          tz={tz}
                          open={isOpenNext(rows, index)}
                          expandable={node.children.length > 0}
                          selected={node.id === selectedId}
                          active={index === activeIndex}
                          domId={rowDomId(index)}
                          onToggle={() => toggle(node)}
                          onSelect={() => select(node)}
                        />
                      ) : null,
                    )}
                  </div>
                  {rows.length === 0 && (
                    <p className="p-6 text-center text-body text-ink-3">
                      No attribute or value contains “{search.q}”. Widen the pattern, or clear the search.
                    </p>
                  )}
                </div>
                <ScrollBottomFade visible={moreBelow} />
                <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-seam bg-fabric-2 px-3 text-small text-ink-3">
                  <span className="tnum">
                    {rows.length.toLocaleString("en-US")} of {tree.nodes.toLocaleString("en-US")} nodes
                    {match.active && ` · ${match.count.toLocaleString("en-US")} matches`}
                  </span>
                  <span className="hidden text-micro text-ink-4 md:inline">↑↓ move · →← expand/collapse · Enter select · Space toggle</span>
                </div>
              </div>
            </div>

            <JmxDetails
              node={selected}
              tree={tree}
              tz={tz}
              onSelect={(node) => {
                setExpanded((prev) => new Set([...prev, ...ancestorIds(node), node.id]));
                select(node);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** In depth-first order a branch is open exactly when the next visible row is deeper — true in every mode. */
function isOpenNext(rows: JmxNode[], index: number): boolean {
  const node = rows[index];
  const next = rows[index + 1];
  return !!node && node.children.length > 0 && !!next && next.depth > node.depth;
}

interface JmxRowProps {
  node: JmxNode;
  index: number;
  height: number;
  offset: number | null;
  query: string;
  tz: TzMode;
  open: boolean;
  expandable: boolean;
  selected: boolean;
  active: boolean;
  domId: string;
  onToggle: () => void;
  onSelect: () => void;
}

function JmxRow({ node, index, height, offset, query, tz, open, expandable, selected, active, domId, onToggle, onSelect }: JmxRowProps) {
  const style: CSSProperties = { height, ...(offset == null ? {} : { transform: `translateY(${offset}px)` }) };
  return (
    <Entity
      id={node.bean || node.label}
      as="div"
      role="treeitem"
      domId={domId}
      aria-level={node.depth + 1}
      aria-expanded={expandable ? open : undefined}
      aria-selected={selected}
      data-active={active}
      data-selected={selected}
      data-kind={node.kind}
      data-burrow-jmx-node={node.id}
      data-index={index}
      className={cn(
        "flex items-center gap-1 border-b border-seam-soft pr-2 text-cell hover:bg-fabric-3",
        selected && "bg-live/10",
        active && !selected && "bg-fabric-2",
        offset == null ? "relative" : "absolute left-0 right-0",
      )}
      style={style}
      onClick={onSelect}
      onDoubleClick={expandable ? onToggle : undefined}
    >
      <span className="flex shrink-0 items-center" style={{ paddingLeft: 4 + node.depth * 14 }}>
        {expandable ? (
          <OptionalTooltip
            label={`${open ? "Collapse" : "Expand"} ${node.kind === "group" ? "group" : node.kind === "bean" ? "bean" : "value"} ${node.label}`}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="grid size-4 place-items-center rounded-sm text-ink-3 hover:bg-fabric-2 hover:text-ink"
            >
              <ChevronRight className={cn("size-3.5 transition-transform duration-(--dur-fast) ease-(--ease-out)", open && "rotate-90")} />
            </button>
          </OptionalTooltip>
        ) : (
          <span className="size-4" />
        )}
      </span>
      <JmxRowBody node={node} query={query} tz={tz} />
    </Entity>
  );
}

/** The key + value halves of a row. Values are `Datum`s (data-yf/data-yv); keys are decorative labels. */
function JmxRowBody({ node, query, tz }: { node: JmxNode; query: string; tz: TzMode }) {
  if (node.kind === "group") {
    return (
      <>
        <span className="min-w-0 flex-1 truncate font-medium text-ink">
          <HighlightedText text={node.label} query={query} />
        </span>
        <span className="shrink-0 text-micro text-ink-4 tnum">
          {node.children.length === 1 ? "1 bean" : `${node.children.length} beans`}
        </span>
      </>
    );
  }
  if (node.kind === "bean") {
    // The group row above already shows the shared prefix, so the bean row shows the distinguishing part.
    const shortLabel = beanShort(node.label) || node.label;
    return (
      <>
        <OptionalTooltip label={node.label}>
          <span className="min-w-0 shrink-0 basis-[38%] truncate text-ink">
            <HighlightedText text={shortLabel} query={query} />
          </span>
        </OptionalTooltip>
        <OptionalTooltip label={String(node.value ?? "")}>
          <span className="hidden min-w-0 flex-1 truncate text-right text-micro text-ink-4 sm:block">{String(node.value ?? "")}</span>
        </OptionalTooltip>
        <span className="shrink-0 text-micro text-ink-4 tnum">
          {node.children.length === 1 ? "1 attr" : `${node.children.length} attrs`}
        </span>
      </>
    );
  }
  const kind = jmxValueKind(node.value);
  if (kind === "object" || kind === "array") {
    const memory = jmxMemoryShape(node.value);
    const field = attrFieldId(node.path);
    return (
      <>
        <OptionalTooltip label={node.path.join(".")}>
          <span className="min-w-0 shrink-0 basis-[42%] truncate font-mono text-small text-ink-2">
            <HighlightedText text={node.label} query={query} />
          </span>
        </OptionalTooltip>
        <span className="min-w-0 flex-1" />
        {memory ? (
          <MemoryBar memory={memory} field={field} raw={node.value} />
        ) : (
          <Datum field={field} raw={node.value} className="shrink-0 text-micro text-ink-4 tnum">
            {jmxBranchSummary(kind, node.children.length)}
          </Datum>
        )}
      </>
    );
  }
  return <JmxValueCell node={node} query={query} tz={tz} />;
}

function JmxValueCell({ node, query, tz }: { node: JmxNode; query: string; tz: TzMode }) {
  const kind = jmxValueKind(node.value);
  const hint = kind === "number" ? jmxNumberHint(node.path, node.value as number, tz) : null;
  const text = jmxScalarText(node.value);
  const field = attrFieldId(node.path);
  return (
    <>
      <OptionalTooltip label={node.path.join(".")}>
        <span className="min-w-0 shrink-0 basis-[42%] truncate font-mono text-small text-ink-3">
          <HighlightedText text={node.label} query={query} />
        </span>
      </OptionalTooltip>
      <span className="min-w-0 flex-1" />
      {kind === "boolean" ? (
        <Datum
          field={field}
          raw={node.value}
          className={cn("shrink-0 rounded-full px-1.5 text-micro", node.value ? "bg-ok/15 text-ok" : "bg-idle/15 text-ink-3")}
        >
          {text}
        </Datum>
      ) : (
        <Datum
          field={field}
          raw={node.value}
          fmt={kind === "number" ? "int" : "text"}
          className={cn(
            "min-w-0 max-w-[22rem] shrink-0 truncate text-right",
            kind === "number" && "tnum text-ink",
            (kind === "null" || kind === "string") && "text-ink-2",
          )}
          title={jmxValueText(node.value).length > 40 ? jmxValueText(node.value) : undefined}
        >
          <HighlightedText text={kind === "number" ? text : truncateMiddle(text, 80)} query={query} />
        </Datum>
      )}
      {hint && <span className="shrink-0 text-micro text-ink-4 tnum">{hint.text}</span>}
    </>
  );
}

function MemoryBar({ memory, field, raw }: { memory: JmxMemory; field: string; raw: unknown }) {
  const percent = memoryPercent(memory);
  return (
    <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
      <span className="hidden truncate text-micro text-ink-3 sm:inline tnum">{memorySummary(memory)}</span>
      <ProgressBar
        percent={percent}
        tone={utilizationTone(percent)}
        valueText={`${percent.toFixed(1)}% used`}
        label={`${field} used`}
        className="w-24 shrink-0"
        datum={{ "data-yf": field, "data-yv": JSON.stringify(raw) ?? "", "data-yfmt": "pct" }}
      />
    </span>
  );
}

function JmxDetails({ node, tree, tz, onSelect }: { node: JmxNode | null; tree: JmxTree; tz: TzMode; onSelect: (node: JmxNode) => void }) {
  if (!node) {
    return (
      <aside className="flex flex-col gap-2 rounded-lg border border-dashed border-seam-strong bg-well p-3 text-body text-ink-3">
        <p className="flex items-center gap-2 font-medium text-ink-2">
          <PanelRight className="size-4" aria-hidden="true" /> Details
        </p>
        <p>Select a bean or an attribute to inspect its raw value, its parsed object name and a copy button.</p>
        <p className="text-micro text-ink-4">The selection lives in the URL (?bean=…&amp;attr=…), so it can be shared.</p>
      </aside>
    );
  }

  if (node.kind === "bean") {
    const info = parseObjectName(node.label);
    return (
      <aside data-burrow-detail="1" className="flex flex-col gap-3 rounded-lg border border-seam bg-fabric p-3">
        <header className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-micro uppercase tracking-wide text-ink-4">MBean</p>
            <h2 className="break-all font-mono text-small text-ink">{node.label}</h2>
          </div>
          <CopyButton value={node.label} label="Copy MBean name" />
        </header>
        <Section title="Object name" className="gap-1.5">
          <dl className="flex flex-col gap-1 text-small">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-micro uppercase tracking-wide text-ink-4">Domain</dt>
              <dd className="min-w-0 break-all text-ink-2">{info.domain}</dd>
            </div>
            {info.properties.map((p) => (
              <div key={p.key} className="flex gap-2">
                <dt className="w-20 shrink-0 text-micro uppercase tracking-wide text-ink-4">{p.key}</dt>
                <dd className="min-w-0 break-all text-ink-2">{p.value || "—"}</dd>
              </div>
            ))}
          </dl>
        </Section>
        <Section title={`Attributes (${node.children.length})`} className="min-h-0 flex-1">
          <ul className="burrow-scroll min-h-0 flex-1 overflow-auto rounded-md border border-seam-soft">
            {node.children.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => onSelect(child)}
                  className="flex w-full items-center gap-2 border-b border-seam-soft px-2 py-1 text-left text-small hover:bg-fabric-3"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-ink-2">{child.label}</span>
                  <span
                    className={cn(
                      "max-w-[9rem] shrink-0 truncate text-right",
                      jmxValueKind(child.value) === "number" ? "tnum text-ink" : "text-ink-3",
                    )}
                  >
                    {child.kind === "value"
                      ? truncateMiddle(jmxScalarText(child.value), 40)
                      : jmxBranchSummary(jmxValueKind(child.value), child.children.length)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
        <p className="text-micro text-ink-4">
          {node.leaves} values under this bean · {tree.groups} groups in total
        </p>
      </aside>
    );
  }

  const kind = jmxValueKind(node.value);
  const hint = kind === "number" ? jmxNumberHint(node.path, node.value as number, tz) : null;
  const memory = jmxMemoryShape(node.value);
  const field = attrFieldId(node.path);
  const rawJson = jmxValueJson(node.value);
  return (
    <aside data-burrow-detail="1" className="flex flex-col gap-3 rounded-lg border border-seam bg-fabric p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-micro uppercase tracking-wide text-ink-4">{node.bean}</p>
          <h2 className="break-all font-mono text-small text-ink">{node.path.join(".")}</h2>
        </div>
        <CopyButton value={rawJson} label="Copy value" />
      </header>

      <Section title="Value" className="gap-1.5">
        <Entity id={node.bean} className="rounded-md border border-seam-soft bg-well p-2">
          <Datum
            field={field}
            raw={node.value}
            fmt={kind === "number" ? "int" : "text"}
            as="p"
            className="break-all font-mono text-body whitespace-pre-wrap text-ink"
          >
            {kind === "object" || kind === "array" ? jmxBranchSummary(kind, node.children.length) : jmxScalarText(node.value)}
          </Datum>
        </Entity>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-small">
          <dt className="text-micro uppercase tracking-wide text-ink-4">Type</dt>
          <dd className="text-ink-2">{kind}</dd>
          <dt className="text-micro uppercase tracking-wide text-ink-4">Field</dt>
          <dd className="break-all font-mono text-micro text-ink-3">{field}</dd>
          {hint && (
            <>
              <dt className="text-micro uppercase tracking-wide text-ink-4">
                {hint.kind === "bytes" ? "Human" : hint.kind === "epoch" ? "Time" : "Duration"}
              </dt>
              <dd className="text-ink-2 tnum">{hint.text}</dd>
            </>
          )}
          {memory && (
            <>
              <dt className="text-micro uppercase tracking-wide text-ink-4">Used</dt>
              <dd className="text-ink-2 tnum">
                {fmtBytes(memory.used)} · {memoryPercent(memory).toFixed(1)}%
              </dd>
            </>
          )}
        </dl>
      </Section>

      {memory && (
        <Section title="Memory" className="gap-1.5">
          <ProgressBar
            percent={memoryPercent(memory)}
            tone={utilizationTone(memoryPercent(memory))}
            valueText={`${memoryPercent(memory).toFixed(1)}% used`}
            label={`${field} used`}
            datum={{ "data-yf": field, "data-yv": JSON.stringify(node.value) ?? "", "data-yfmt": "pct" }}
          />
          <p className="text-small text-ink-3 tnum">{memorySummary(memory)}</p>
        </Section>
      )}

      {node.children.length > 0 ? (
        <Section title={`Children (${node.children.length})`} className="min-h-0 flex-1">
          <ul className="burrow-scroll min-h-0 flex-1 overflow-auto rounded-md border border-seam-soft">
            {node.children.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => onSelect(child)}
                  className="flex w-full items-center gap-2 border-b border-seam-soft px-2 py-1 text-left text-small hover:bg-fabric-3"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-ink-2">{child.label}</span>
                  <span className="shrink-0 text-right text-ink-3">
                    {child.kind === "value"
                      ? truncateMiddle(jmxScalarText(child.value), 40)
                      : jmxBranchSummary(jmxValueKind(child.value), child.children.length)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <Section title="Raw JSON" className="min-h-0 flex-1">
          <pre className="burrow-scroll min-h-0 flex-1 overflow-auto rounded-md border border-seam-soft bg-well p-2 font-mono text-micro break-all whitespace-pre-wrap text-ink-2">
            {rawJson}
          </pre>
        </Section>
      )}

      <p className="text-micro text-ink-4">
        {node.children.length > 0 ? `${node.leaves} values under this node · raw value in data-yv` : "leaf value of the bean"}
      </p>
    </aside>
  );
}
