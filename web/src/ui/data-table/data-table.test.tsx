import { afterEach, describe, expect, it, vi } from "vitest";
import type { SortingState } from "@tanstack/react-table";
import type { ColDef } from "./features";

const motionMocks = vi.hoisted(() => ({
  allowed: false,
  flash: vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation),
}));

vi.mock("~/lib/motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/motion")>()),
  motionAllowed: () => motionMocks.allowed,
  flash: motionMocks.flash,
  tokenMs: (_element: Element | null, _token: string, fallback: number) => fallback,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: Array.from({ length: index }, (_, i) => estimateSize(i)).reduce((sum, height) => sum + height, 0),
      })),
    getTotalSize: () => Array.from({ length: count }, (_, index) => estimateSize(index)).reduce((sum, height) => sum + height, 0),
    measure: vi.fn(),
  }),
}));

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { DataTable, defaultVisibilityOf } = await import("./data-table");
const { Datum } = await import("../datum");
const { EmptyState, ErrorState } = await import("../feedback");
const { parityStore } = await import("~/state/parity");
let originalClientHeight: PropertyDescriptor | null | undefined;
let originalAnimate: PropertyDescriptor | null | undefined;
let originalClientWidth: PropertyDescriptor | null | undefined;
let originalRect: PropertyDescriptor | null | undefined;

interface Row {
  id: string;
  name: string;
  count: number;
}

const rows: Row[] = [
  { id: "n-1", name: "alpha", count: 2 },
  { id: "n-2", name: "beta", count: 4 },
];
const columns: ColDef<Row>[] = [
  { id: "id", accessorKey: "id", size: 100, meta: { label: "ID", pinned: true } },
  { id: "name", accessorKey: "name", meta: { label: "Name", hint: "Node hostname" } },
  { id: "count", accessorKey: "count", meta: { label: "Count", defaultVisible: false, align: "end" } },
];

function renderTable(overrides: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  const onSortingChange = vi.fn<(sorting: SortingState) => void>();
  const onColumnVisibilityChange = vi.fn<(visibility: Record<string, boolean>) => void>();
  const onRowActivate = vi.fn<(row: Row) => void>();
  const view = render(
    <DataTable<Row>
      data={rows}
      columns={columns}
      getRowId={(row) => row.id}
      entityKey={(row) => row.id}
      label="Nodes"
      storageKey="test-data-table"
      sorting={[]}
      onSortingChange={onSortingChange}
      columnVisibility={{}}
      onColumnVisibilityChange={onColumnVisibilityChange}
      defaultVisibility={{ id: true, name: true, count: false }}
      selectable
      onRowActivate={onRowActivate}
      exportName="nodes"
      {...overrides}
    />,
  );
  return { ...view, onSortingChange, onColumnVisibilityChange, onRowActivate };
}

afterEach(() => {
  cleanup();
  parityStore.setState(() => ({ enabled: true }));
  window.__BURROW_PARITY__ = true;
  if (originalClientHeight === null) delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  else if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
  if (originalClientWidth === null) delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  else if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
  if (originalRect === null) delete (HTMLElement.prototype as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
  else if (originalRect) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", originalRect);
  if (originalAnimate === null) delete (HTMLElement.prototype as { animate?: (...args: unknown[]) => Animation }).animate;
  else if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  originalClientHeight = undefined;
  originalAnimate = undefined;
  originalClientWidth = undefined;
  originalRect = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  motionMocks.allowed = false;
  motionMocks.flash.mockClear();
});

describe("DataTable", () => {
  it("uses accessor keys when a column does not declare an id", () => {
    const keyColumns: ColDef<Row>[] = [{ accessorKey: "name", meta: { label: "Name", defaultVisible: false } }, { accessorKey: "count" }];
    expect(defaultVisibilityOf(keyColumns)).toEqual({ name: false, count: true });
  });

  it("updates horizontal overflow cues as the user scrolls across columns", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          const contentRect = { width: 100, height: 300 } as DOMRectReadOnly;
          this.callback([{ target, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
        unobserve() {}
      },
    );
    const { container } = renderTable();
    const table = screen.getByRole("table", { name: "Nodes" });
    Object.defineProperties(table, {
      scrollLeft: { configurable: true, writable: true, value: 0 },
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 80 },
      scrollHeight: { configurable: true, value: 300 },
    });
    fireEvent.scroll(table);
    expect(screen.getByText("Scroll for more columns")).toBeTruthy();
    expect(container.querySelector(".burrow-table-edge-fade")?.className).toContain("opacity-100");

    table.scrollLeft = 450;
    fireEvent.scroll(table);
    expect(container.querySelector(".burrow-table-edge-fade")?.className).toContain("opacity-0");
  });

  it("sorts, selects rows, activates a row, resets columns, and exports CSV/JSON", () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:table-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { onSortingChange, onColumnVisibilityChange, onRowActivate } = renderTable();
    expect(screen.getByRole("table", { name: "Nodes" })).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByText("2 selected")).toBeNull();

    const idHeader = screen.getByRole("table", { name: "Nodes" }).querySelector('[data-col="id"] button');
    expect(idHeader).not.toBeNull();
    fireEvent.click(idHeader!);
    expect(onSortingChange).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(document.body.textContent).toContain("2 selected");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(document.body.textContent).not.toContain("2 selected");
    fireEvent.click(screen.getByRole("row", { name: /n-1 alpha/ }));
    expect(onRowActivate).toHaveBeenCalledWith(rows[0]);

    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset to default columns" }));
    expect(onColumnVisibilityChange).toHaveBeenCalledWith({ id: true, name: true, count: false });
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    expect(onColumnVisibilityChange).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select n-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "JSON (1 selected)" }));
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(clickAnchor).toHaveBeenCalledTimes(2);
  });

  it("manages a multi-column sort from the touch-friendly sort panel", () => {
    const sorting: SortingState = [
      { id: "name", desc: true },
      { id: "count", desc: false },
    ];
    const { onSortingChange } = renderTable({ sorting });
    fireEvent.click(screen.getByRole("button", { name: "Sort order: Name ↓, Count ↑" }));

    fireEvent.click(screen.getByRole("button", { name: "Name sorted descending — switch direction" }));
    expect(onSortingChange).toHaveBeenLastCalledWith([
      { id: "name", desc: false },
      { id: "count", desc: false },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Remove sort on Count" }));
    expect(onSortingChange).toHaveBeenLastCalledWith([{ id: "name", desc: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Clear sort" }));
    expect(onSortingChange).toHaveBeenLastCalledWith([]);
  });

  it("resets a column width and labels a stable, filtered result set", () => {
    const manyRows = [
      ...rows,
      { id: "n-3", name: "gamma", count: 6 },
      { id: "n-4", name: "delta", count: 8 },
      { id: "n-5", name: "epsilon", count: 10 },
    ];
    const { container } = renderTable({
      data: manyRows,
      totalCount: 10,
      stableViewport: true,
      toolbarArrangement: "inline",
      toolbar: <button type="button">Filter</button>,
    });
    expect(screen.getByText("5 of 10 rows")).toBeTruthy();
    expect(container.querySelector('[data-burrow-table-root="test-data-table"]')?.className).toContain("h-[min(34dvh,360px)]");

    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize Name" }));
    expect(screen.getByRole("table", { name: "Nodes" }).querySelector('[data-col="name"]')).not.toBeNull();
  });

  it("shows loading, empty, and unavailable table states with the matching controls", () => {
    const loading = renderTable({ loading: true });
    expect(screen.getByRole("table", { name: "Nodes" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("group", { name: "Nodes table controls" }).getAttribute("disabled")).not.toBeNull();
    loading.unmount();

    const empty = renderTable({ data: [], empty: <p>No nodes found</p> });
    expect(screen.getByText("No nodes found")).toBeTruthy();
    empty.unmount();

    renderTable({ data: [], error: <p>Node list unavailable</p> });
    expect(screen.getByText("Node list unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
  });

  it("keeps first-party feedback compact inside the fixed table viewport", () => {
    renderTable({ data: [], empty: <EmptyState title="Nothing matched" /> });
    expect(screen.getByRole("status").className).toContain("w-fit");
    cleanup();

    renderTable({ data: [], error: <ErrorState title="Unavailable" message="Try again" /> });
    expect(screen.getByRole("alert").className).toContain("flex-row");
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("preserves the declared default sort without offering to remove it", () => {
    const defaultSorting: SortingState = [{ id: "name", desc: false }];
    renderTable({ sorting: defaultSorting, defaultSorting });
    fireEvent.click(screen.getByRole("button", { name: "Sort order: none" }));
    expect(screen.getByText("default")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove sort on Name" })).toBeNull();
    expect(screen.getByText("This is the table's default order")).toBeTruthy();
  });

  it("adds a sort beside an active order, but replaces the caller's default order", async () => {
    const defaultSorting: SortingState = [{ id: "id", desc: false }];
    const first = renderTable({ sorting: defaultSorting, defaultSorting });
    fireEvent.click(screen.getByRole("button", { name: "Sort order: none" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Add sort column" }));
    fireEvent.click(await screen.findByRole("option", { name: "Name" }));
    expect(first.onSortingChange).toHaveBeenLastCalledWith([{ id: "name", desc: false }]);
    first.unmount();

    const active: SortingState = [{ id: "name", desc: true }];
    const second = renderTable({ sorting: active });
    fireEvent.click(screen.getByRole("button", { name: "Sort order: Name ↓" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Add sort column" }));
    fireEvent.click(await screen.findByRole("option", { name: "ID" }));
    expect(second.onSortingChange).toHaveBeenLastCalledWith([...active, { id: "id", desc: false }]);
  });

  it("ignores stale URL sort columns and tolerates invalid saved widths", () => {
    window.localStorage.setItem("burrow.cols.test-data-table", "not-json");
    const stale: SortingState = [{ id: "removed-column", desc: true }];
    renderTable({ sorting: stale, selectable: false });

    expect(screen.queryByRole("checkbox", { name: "Select all rows" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sort order: removed-column/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sort order: none" }));
    expect(screen.queryByText("This is the table's default order")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear sort" }));
  });

  it("animates rows entering and leaving when a live result set changes", async () => {
    originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight") ?? null;
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth") ?? null;
    originalRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect") ?? null;
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    const animations: Array<{ cancel: ReturnType<typeof vi.fn>; oncancel: (() => void) | null; onfinish: (() => void) | null }> = [];
    let reordered = false;
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), oncancel: null, onfinish: null };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: function (this: HTMLElement) {
        const row = this.matches(".burrow-row[data-ye]") ? this : this.closest<HTMLElement>(".burrow-row[data-ye]");
        const top = row?.dataset.ye === "n-2" && reordered ? 0 : row ? 40 : 0;
        return { x: 0, y: top, top, left: 0, right: 600, bottom: top + 40, width: 600, height: 40, toJSON: () => ({}) };
      },
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    motionMocks.allowed = true;

    const view = renderTable({ data: [...rows], rowVersion: (row) => row.count });
    expect(await screen.findByText("alpha")).toBeTruthy();
    reordered = true;
    view.rerender(
      <DataTable<Row>
        data={[
          { ...rows[1]!, count: 5 },
          { id: "n-3", name: "gamma", count: 6 },
        ]}
        columns={columns}
        getRowId={(row) => row.id}
        entityKey={(row) => row.id}
        label="Nodes"
        storageKey="test-data-table"
        sorting={[]}
        onSortingChange={view.onSortingChange}
        columnVisibility={{}}
        onColumnVisibilityChange={view.onColumnVisibilityChange}
        defaultVisibility={{ id: true, name: true, count: false }}
        selectable
        onRowActivate={view.onRowActivate}
        rowVersion={(row) => row.count}
        exportName="nodes"
      />,
    );
    expect(await screen.findByText("gamma")).toBeTruthy();
    expect(animate).toHaveBeenCalled();
    expect(motionMocks.flash).toHaveBeenCalled();
    expect(view.container.querySelector('[aria-hidden="true"][inert][role="presentation"]')).not.toBeNull();
    animations.forEach((animation) => {
      animation.onfinish?.();
    });
    expect(view.container.querySelector('[aria-hidden="true"][inert][role="presentation"]')).toBeNull();
    view.unmount();
    expect(animations.some((animation) => animation.cancel.mock.calls.length > 0)).toBe(true);
  });

  it("cleans parity stamps from exit clones and cancels active row animations on updates and unmount", async () => {
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    const animations: Array<{ cancel: ReturnType<typeof vi.fn>; oncancel: (() => void) | null; onfinish: (() => void) | null }> = [];
    const exitNodes: HTMLElement[] = [];
    const animate = vi.fn(function (this: HTMLElement) {
      if (this.getAttribute("role") === "presentation") exitNodes.push(this);
      const animation = { cancel: vi.fn(), oncancel: null, onfinish: null };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    motionMocks.allowed = true;

    const datumColumns: ColDef<Row>[] = [
      {
        id: "name",
        accessorKey: "name",
        meta: { label: "Name" },
        cell: ({ row }) => (
          <Datum field="node.name" raw={row.original.name}>
            {row.original.name}
          </Datum>
        ),
      },
    ];
    const first = [...rows];
    const second = [rows[1]!, { id: "n-3", name: "gamma", count: 6 }];
    const third = [
      { id: "n-3", name: "gamma", count: 6 },
      { id: "n-4", name: "delta", count: 8 },
    ];
    const view = renderTable({ data: first, columns: datumColumns, selectable: false });
    expect(await screen.findByText("alpha")).toBeTruthy();

    const renderData = (data: readonly Row[]) =>
      view.rerender(
        <DataTable<Row>
          data={data}
          columns={datumColumns}
          getRowId={(row) => row.id}
          entityKey={(row) => row.id}
          label="Nodes"
          storageKey="test-data-table"
          sorting={[]}
          onSortingChange={view.onSortingChange}
          columnVisibility={{}}
          onColumnVisibilityChange={view.onColumnVisibilityChange}
          defaultVisibility={{ name: true }}
          selectable={false}
          rowVersion={(row) => row.count}
          exportName="nodes"
        />,
      );

    renderData(second);
    expect(await screen.findByText("gamma")).toBeTruthy();
    expect(exitNodes).toHaveLength(1);
    expect(exitNodes[0]!.querySelector("[data-yf], [data-yv], [data-ye], [id]")).toBeNull();

    renderData(third);
    expect(await screen.findByText("delta")).toBeTruthy();
    expect(animations.some((animation) => animation.cancel.mock.calls.length > 0)).toBe(true);
    expect(exitNodes.length).toBeGreaterThan(1);
    view.unmount();
    expect(exitNodes.every((element) => element.parentElement === null)).toBe(true);
    expect(animations.every((animation) => animation.cancel.mock.calls.length > 0)).toBe(true);
  });
});
