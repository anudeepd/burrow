import { afterEach, describe, expect, it, vi } from "vitest";
import type { SortingState } from "@tanstack/react-table";
import type { ColDef } from "./features";

const motionMocks = vi.hoisted(() => ({
  allowed: false,
  duration: null as number | null,
  flash: vi.fn(
    () =>
      ({
        cancel: vi.fn(),
        finished: Promise.resolve(null as unknown as Animation),
      }) as unknown as Animation,
  ),
}));
const scrollBottomMocks = vi.hoisted(() => ({ skipObserver: false }));
const widthMocks = vi.hoisted(() => ({ width: 0 }));

vi.mock("~/lib/motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/motion")>()),
  motionAllowed: () => motionMocks.allowed,
  flash: motionMocks.flash,
  tokenMs: (_element: Element | null, _token: string, fallback: number) => motionMocks.duration ?? fallback,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    getScrollElement,
  }: {
    count: number;
    estimateSize: (index: number) => number;
    getScrollElement: () => Element | null;
  }) => ({
    getScrollElement: getScrollElement(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: Array.from({ length: index }, (_, i) => estimateSize(i)).reduce((sum, height) => sum + height, 0),
      })),
    getTotalSize: () => Array.from({ length: count }, (_, index) => estimateSize(index)).reduce((sum, height) => sum + height, 0),
    measure: vi.fn(),
  }),
}));

vi.mock("~/lib/size", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/size")>()),
  useElementWidth: () => [{ current: null }, widthMocks.width],
}));

vi.mock("../scroll-bottom-fade", async (importOriginal) => {
  const original = await importOriginal<typeof import("../scroll-bottom-fade")>();
  return {
    ...original,
    useHasMoreBelow: (...args: Parameters<typeof original.useHasMoreBelow>) => {
      const [ref, enabled, contentRef] = args;
      const shouldObserve = !scrollBottomMocks.skipObserver && enabled;
      return original.useHasMoreBelow(ref, shouldObserve, contentRef);
    },
  };
});

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { DataTable, defaultVisibilityOf } = await import("./data-table");
const { Datum } = await import("../datum");
const { EmptyState, ErrorState } = await import("../feedback");
const { parityStore } = await import("~/state/parity");
// WAAPI animations always expose a completion promise, including mocked animations.
const animationFinished = Promise.resolve(null as unknown as Animation);
let originalClientHeight: PropertyDescriptor | null | undefined;
let originalAnimate: PropertyDescriptor | null | undefined;
let originalClientWidth: PropertyDescriptor | null | undefined;
let originalRect: PropertyDescriptor | null | undefined;
let originalGetAnimations: PropertyDescriptor | null | undefined;
let originalMatchMedia: PropertyDescriptor | null | undefined;
let originalInnerHeight: PropertyDescriptor | null | undefined;
let originalVisualViewport: PropertyDescriptor | null | undefined;
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
  if (originalInnerHeight === null) delete (window as { innerHeight?: number }).innerHeight;
  else if (originalInnerHeight) Object.defineProperty(window, "innerHeight", originalInnerHeight);
  if (originalVisualViewport === null) delete (window as { visualViewport?: VisualViewport | null }).visualViewport;
  else if (originalVisualViewport) Object.defineProperty(window, "visualViewport", originalVisualViewport);
  if (originalMatchMedia === null) Reflect.deleteProperty(window, "matchMedia");
  else if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
  if (originalAnimate === null) delete (HTMLElement.prototype as { animate?: (...args: unknown[]) => Animation }).animate;
  else if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  if (originalGetAnimations === null) delete (HTMLElement.prototype as { getAnimations?: () => Animation[] }).getAnimations;
  else if (originalGetAnimations) Object.defineProperty(HTMLElement.prototype, "getAnimations", originalGetAnimations);
  originalGetAnimations = undefined;
  originalClientHeight = undefined;
  originalAnimate = undefined;
  originalClientWidth = undefined;
  originalRect = undefined;
  originalMatchMedia = undefined;
  originalInnerHeight = undefined;
  originalVisualViewport = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  motionMocks.allowed = false;
  motionMocks.duration = null;
  widthMocks.width = 0;
  motionMocks.flash.mockClear();
  scrollBottomMocks.skipObserver = false;
});

describe("DataTable", () => {
  it("uses accessor keys when a column does not declare an id", () => {
    const keyColumns: ColDef<Row>[] = [{ accessorKey: "name", meta: { label: "Name", defaultVisible: false } }, { accessorKey: "count" }];
    expect(defaultVisibilityOf(keyColumns)).toEqual({ name: false, count: true });
    expect(defaultVisibilityOf([{ header: "Actions", cell: () => null } as ColDef<Row>])).toEqual({ "": true });
  });

  it("uses the coarse pointer row height and unsubscribes from pointer changes", () => {
    originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia") ?? null;
    const media = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => media) });
    const view = renderTable();
    expect(screen.getByRole("row", { name: /alpha/ }).getAttribute("style")).toContain("height: 44px");
    view.unmount();
    expect(media.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(media.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("falls back to the pointer row height when matchMedia is unavailable", () => {
    originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia") ?? null;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
    const view = renderTable();
    expect(screen.getByRole("row", { name: /alpha/ }).getAttribute("style")).toContain("height: 34px");
    view.unmount();
  });

  it("uses metadata-free column labels and the derived visibility defaults", () => {
    const bareColumns: ColDef<Row>[] = [{ id: "name", accessorKey: "name" }];
    const view = renderTable({ columns: bareColumns, columnVisibility: undefined, defaultVisibility: undefined, selectable: false });
    expect(screen.getByRole("button", { name: "name" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    expect(screen.getByRole("menuitemcheckbox", { name: "name" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset to default columns" }));
    expect(view.onColumnVisibilityChange).toHaveBeenCalledWith({ name: true });
    fireEvent.click(screen.getByRole("button", { name: /Choose columns/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "name" }));
    expect(view.onColumnVisibilityChange).toHaveBeenLastCalledWith({ name: false });
    view.unmount();

    const sorted = renderTable({ columns: bareColumns, sorting: [{ id: "name", desc: false }], selectable: false });
    expect(screen.getByRole("button", { name: "Sort order: name ↑" })).toBeTruthy();
    sorted.unmount();
  });
  it("does not add a table-entry animation while its page content is moving", () => {
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    originalGetAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations") ?? null;
    const animate = vi.fn(() => ({ cancel: vi.fn(), finished: animationFinished }) as unknown as Animation);
    const animation = (name: string, playState: AnimationPlayState) => ({ animationName: name, playState }) as unknown as Animation;
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [animation("other-animation", "running"), animation("burrow-page-content-shift", "running")],
    });
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    motionMocks.allowed = true;
    const { container } = render(
      <div data-page-motion="content">
        <DataTable<Row>
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          entityKey={(row) => row.id}
          label="Nodes"
          storageKey="test-data-table"
          sorting={[]}
          onSortingChange={vi.fn()}
          columnVisibility={{}}
          onColumnVisibilityChange={vi.fn()}
          defaultVisibility={{ id: true, name: true, count: false }}
          selectable
          exportName="nodes"
        />
      </div>,
    );
    expect(container.querySelector("[data-burrow-table-root]")).not.toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });
  it("fades rows when their content identity changes and cancels the fade when rows disappear", () => {
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    const animations: Array<{ cancel: ReturnType<typeof vi.fn>; playState: AnimationPlayState }> = [];
    const animate = vi.fn(function (this: HTMLElement) {
      const animation = { cancel: vi.fn(), finished: animationFinished, playState: "running" as AnimationPlayState };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    const view = renderTable({ contentIdentity: "first", initialContentFade: false });
    const renderIdentity = (contentIdentity: string, data = rows) =>
      view.rerender(
        <DataTable<Row>
          data={data}
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
          contentIdentity={contentIdentity}
          exportName="nodes"
        />,
      );
    renderIdentity("first");
    expect(animate).not.toHaveBeenCalled();
    renderIdentity("second");
    expect(animate).toHaveBeenCalledTimes(1);
    renderIdentity("second", []);
    expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
    renderIdentity("third");
    expect(animate).toHaveBeenCalledTimes(1);
  });
  it("retargets an in-flight content fade and falls back to zero for a non-finite opacity", () => {
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    const animations: Array<{
      keyframes: Keyframe[] | PropertyIndexedKeyframes | null | undefined;
      animation: { cancel: ReturnType<typeof vi.fn>; playState: AnimationPlayState };
    }> = [];
    const animate = vi.fn(function (this: HTMLElement, keyframes?: Keyframe[] | PropertyIndexedKeyframes | null) {
      const animation = { cancel: vi.fn(), finished: animationFinished, playState: "running" as AnimationPlayState };
      animations.push({ keyframes, animation });
      return animation as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    const view = renderTable({ contentIdentity: "first", initialContentFade: false });
    const body = view.container.querySelector<HTMLElement>('[role="rowgroup"].relative')!;
    const getStyle = window.getComputedStyle.bind(window);
    let opacity = "0.4";
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudoElement) => {
      const style = getStyle(element, pseudoElement);
      return element === body ? ({ opacity, getPropertyValue: style.getPropertyValue.bind(style) } as CSSStyleDeclaration) : style;
    });
    const renderIdentity = (contentIdentity: string) =>
      view.rerender(
        <DataTable<Row>
          data={rows}
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
          contentIdentity={contentIdentity}
          initialContentFade={false}
          exportName="nodes"
        />,
      );

    renderIdentity("second");
    expect((animations[0]!.keyframes as Keyframe[])[0]?.opacity).toBe(0);
    renderIdentity("third");
    expect((animations[1]!.keyframes as Keyframe[])[0]?.opacity).toBe(0.4);
    expect(animations[0]!.animation.cancel).toHaveBeenCalledTimes(1);
    opacity = "not-a-number";
    renderIdentity("fourth");
    expect((animations[2]!.keyframes as Keyframe[])[0]?.opacity).toBe(0);
    expect(animations[1]!.animation.cancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(3);
  });

  it.each(["finished", "idle"] as const)("does not mistake a %s page animation for active motion", (playState) => {
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    originalGetAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations") ?? null;
    const animate = vi.fn(() => ({ cancel: vi.fn(), finished: animationFinished }) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [{ animationName: "burrow-page-content-shift", playState } as unknown as Animation],
    });
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    motionMocks.allowed = true;
    const { container } = render(
      <div data-page-motion="content">
        <DataTable<Row>
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          entityKey={(row) => row.id}
          label="Nodes"
          storageKey="test-data-table"
          sorting={[]}
          onSortingChange={vi.fn()}
          columnVisibility={{}}
          onColumnVisibilityChange={vi.fn()}
          defaultVisibility={{ id: true, name: true, count: false }}
          selectable
          exportName="nodes"
        />
      </div>,
    );
    expect(container.querySelector("[data-burrow-table-root]")).not.toBeNull();
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("renders wrapped headers that cannot be sorted", () => {
    const fixedColumns: ColDef<Row>[] = [
      { id: "name", accessorKey: "name", enableSorting: false, meta: { label: "Name", wrapHeader: true } },
    ];
    const view = renderTable({ columns: fixedColumns, selectable: false });
    const header = view.container.querySelector<HTMLElement>('[data-col="name"]')!;
    const button = header.querySelector("button")!;
    expect(header.getAttribute("aria-sort")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(header.querySelector("span")?.className).toContain("whitespace-normal");
    fireEvent.click(button);
    expect(view.onSortingChange).not.toHaveBeenCalled();
  });

  it("fits an unsized mobile column to the measured viewport", () => {
    widthMocks.width = 400;
    const { container } = renderTable({
      columns: [
        {
          id: "identity",
          header: "Identity",
          columns: [
            { id: "id", accessorKey: "id", size: 100, meta: { label: "ID" } },
            { id: "name", accessorKey: "name", meta: { label: "Name" } },
          ],
        },
      ],
      columnVisibility: undefined,
      defaultVisibility: undefined,
      selectable: false,
    });
    expect(container.querySelector('[data-col="name"]')?.getAttribute("style")).toContain("width: 267px");
  });

  it("lays a stacked toolbar above the table actions", () => {
    const view = renderTable({ toolbar: <button type="button">Filter rows</button> });
    const toolbar = view.container.querySelector("fieldset > div")!;
    expect(toolbar.className).toContain("basis-full");
  });

  it("caps short content to the measured chrome and body height", () => {
    const view = renderTable({ stableViewport: false });
    const root = view.container.querySelector<HTMLElement>("[data-burrow-table-root]")!;
    const scroller = screen.getByRole("table", { name: "Nodes" });
    const content = scroller.firstElementChild as HTMLElement;
    Object.defineProperty(root, "offsetHeight", { configurable: true, value: 500 });
    Object.defineProperty(scroller, "offsetHeight", { configurable: true, value: 300 });
    Object.defineProperty(content, "offsetHeight", { configurable: true, value: 100 });
    view.rerender(
      <DataTable<Row>
        data={[...rows]}
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
        exportName="nodes"
      />,
    );
    expect(root.style.maxHeight).toBe("300px");
  });
  it.each([
    [100, 380],
    [480, 480],
  ])("measures remaining page height at top %i and falls back to padded page height when too little remains", (rootTop, expectedHeight) => {
    originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight") ?? null;
    originalRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect") ?? null;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("burrow-page-scroll") ? 500 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: function (this: HTMLElement) {
        const top = this.hasAttribute("data-burrow-table-root") ? rootTop : 0;
        return { x: 0, y: top, top, left: 0, right: 800, bottom: top + 500, width: 800, height: 500, toJSON: () => ({}) } as DOMRect;
      },
    });
    const data = Array.from({ length: 20 }, (_, index) => ({ id: `n-${index}`, name: `node-${index}`, count: index }));
    const { container, rerender } = render(
      <div className="burrow-page-scroll" style={{ paddingBottom: 20 }}>
        <DataTable<Row>
          data={data}
          columns={columns}
          getRowId={(row) => row.id}
          label="Nodes"
          storageKey="test-data-table"
          sorting={[]}
          onSortingChange={vi.fn()}
          columnVisibility={{}}
          onColumnVisibilityChange={vi.fn()}
          defaultVisibility={{ id: true, name: true, count: false }}
          selectable={false}
          exportName="nodes"
        />
      </div>,
    );
    const root = container.querySelector<HTMLElement>("[data-burrow-table-root]")!;
    const scroller = screen.getByRole("table", { name: "Nodes" });
    const content = scroller.firstElementChild as HTMLElement;
    Object.defineProperty(root, "offsetHeight", { configurable: true, value: 500 });
    Object.defineProperty(scroller, "offsetHeight", { configurable: true, value: 400 });
    Object.defineProperty(content, "offsetHeight", { configurable: true, value: 1000 });
    rerender(
      <div className="burrow-page-scroll" style={{ paddingBottom: 20 }}>
        <DataTable<Row>
          data={[...data]}
          columns={columns}
          getRowId={(row) => row.id}
          label="Nodes"
          storageKey="test-data-table"
          sorting={[]}
          onSortingChange={vi.fn()}
          columnVisibility={{}}
          onColumnVisibilityChange={vi.fn()}
          defaultVisibility={{ id: true, name: true, count: false }}
          selectable={false}
          exportName="nodes"
        />
      </div>,
    );
    expect(root.style.maxHeight).toBe(`${expectedHeight}px`);
  });
  it("ignores a queued resize measurement after the table unmounts", () => {
    let measure: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          measure = callback;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    const view = renderTable();
    view.unmount();
    const measureRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    measure?.([], {} as ResizeObserver);
    expect(measureRect).not.toHaveBeenCalled();
  });
  it("re-measures visible table sizing on window resize when ResizeObserver is unavailable", () => {
    originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight") ?? null;
    originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport") ?? null;
    originalRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect") ?? null;
    vi.stubGlobal("ResizeObserver", undefined);
    scrollBottomMocks.skipObserver = true;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: null });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: function (this: HTMLElement) {
        const top = this.hasAttribute("data-burrow-table-root") ? 100 : 0;
        return { x: 0, y: top, top, left: 0, right: 800, bottom: top + 500, width: 800, height: 500, toJSON: () => ({}) } as DOMRect;
      },
    });
    const view = renderTable({ stableViewport: true });
    const root = view.container.querySelector<HTMLElement>("[data-burrow-table-root]")!;
    const scroller = screen.getByRole("table", { name: "Nodes" });
    const content = scroller.firstElementChild as HTMLElement;
    Object.defineProperty(root, "offsetHeight", { configurable: true, value: 500 });
    Object.defineProperty(scroller, "offsetHeight", { configurable: true, value: 400 });
    Object.defineProperty(content, "offsetHeight", { configurable: true, value: 1000 });

    fireEvent.resize(window);
    expect(root.style.maxHeight).toBe("500px");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    fireEvent.resize(window);
    expect(root.style.maxHeight).toBe("600px");
  });

  it("sizes five rows to their content and caps long results to the remaining viewport", () => {
    originalRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect") ?? null;
    const getRect = originalRect?.value as ((this: HTMLElement) => DOMRect) | undefined;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const rootTop = Math.floor(viewportHeight / 4);
    const availableHeight = Math.floor(viewportHeight - rootTop);
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: function (this: HTMLElement) {
        if (this.hasAttribute("data-burrow-table-root")) {
          return {
            x: 0,
            y: rootTop,
            top: rootTop,
            left: 0,
            right: 800,
            bottom: rootTop + 500,
            width: 800,
            height: 500,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return getRect?.call(this) ?? ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
      },
    });
    const fiveRows = [
      ...rows,
      { id: "n-3", name: "gamma", count: 6 },
      { id: "n-4", name: "delta", count: 8 },
      { id: "n-5", name: "epsilon", count: 10 },
    ];
    const view = renderTable({ data: fiveRows, stableViewport: true });
    const root = view.container.querySelector<HTMLElement>("[data-burrow-table-root]")!;
    const scroller = screen.getByRole("table", { name: "Nodes" });
    const content = scroller.firstElementChild as HTMLElement;
    Object.defineProperty(root, "offsetHeight", { configurable: true, value: 500 });
    Object.defineProperty(scroller, "offsetHeight", { configurable: true, value: 400 });
    Object.defineProperty(content, "offsetHeight", { configurable: true, value: 202 });
    const renderRows = (data: Row[]) => (
      <DataTable<Row>
        data={[...data]}
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
        exportName="nodes"
        stableViewport
      />
    );
    view.rerender(renderRows(fiveRows));
    expect(root.style.maxHeight).toBe("302px");
    expect(root.className).not.toContain("h-[min(34dvh,360px)]");

    const manyRows = Array.from({ length: 30 }, (_, index) => ({
      id: `n-${index + 1}`,
      name: `node-${index + 1}`,
      count: index,
    }));
    Object.defineProperty(content, "offsetHeight", { configurable: true, value: 32 + manyRows.length * 34 });
    view.rerender(renderRows(manyRows));
    expect(root.style.maxHeight).toBe(`${availableHeight}px`);
  });

  it("updates horizontal overflow cues as the user scrolls across columns", () => {
    widthMocks.width = 100;
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

  it("exports the current view and custom export values when no rows are selected", () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:table-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const exportColumns: ColDef<Row>[] = [
      {
        id: "name",
        accessorKey: "name",
        meta: { label: "Name", exportValue: (value) => (value as Row).name.toUpperCase() },
      },
      { id: "display", header: "Display only", cell: () => "display value" },
    ];
    renderTable({ columns: exportColumns, selectable: false });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "JSON (current view)" }));
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(clickAnchor).toHaveBeenCalledTimes(1);
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
    expect(container.querySelector('[data-burrow-table-root="test-data-table"]')?.className).not.toContain("h-[min(34dvh,360px)]");

    const resize = screen.getByRole("separator", { name: "Resize Name" });
    fireEvent.mouseDown(resize, { clientX: 100 });
    expect(resize.className).toContain("bg-live");
    fireEvent.mouseUp(window);
    fireEvent.doubleClick(resize);
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

  it("slides the table shell once when asynchronous rows become ready", () => {
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    const tableAnimations: Array<{
      keyframes: Keyframe[] | PropertyIndexedKeyframes | null | undefined;
      options: number | KeyframeAnimationOptions | undefined;
    }> = [];
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: function (
        this: HTMLElement,
        keyframes?: Keyframe[] | PropertyIndexedKeyframes | null,
        options?: number | KeyframeAnimationOptions,
      ) {
        if (this.hasAttribute("data-burrow-table-root")) tableAnimations.push({ keyframes, options });
        return { cancel: vi.fn(), finished: animationFinished, oncancel: null, onfinish: null } as unknown as Animation;
      },
    });
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    motionMocks.allowed = true;
    const view = renderTable({ data: [] });
    const renderRows = (data: Row[]) => (
      <DataTable<Row>
        data={data}
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
        exportName="nodes"
      />
    );
    view.rerender(renderRows(rows));
    expect(tableAnimations).toHaveLength(1);
    expect(tableAnimations[0]?.keyframes).toEqual([{ transform: "translateY(10px)" }, { transform: "translateY(0px)" }]);
    expect(tableAnimations[0]?.options).toMatchObject({ duration: 400, easing: "ease-in-out" });
    view.rerender(renderRows([...rows, { id: "n-3", name: "gamma", count: 6 }]));
    expect(tableAnimations).toHaveLength(1);
  });

  it("animates rows entering and leaving when a live result set changes", async () => {
    originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight") ?? null;
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth") ?? null;
    originalRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect") ?? null;
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    const animations: Array<{ cancel: ReturnType<typeof vi.fn>; oncancel: (() => void) | null; onfinish: (() => void) | null }> = [];
    let reordered = false;
    let computedTransform = "none";
    const animate = vi.fn((_keyframes?: Keyframe[] | PropertyIndexedKeyframes | null, _options?: number | KeyframeAnimationOptions) => {
      const animation = { cancel: vi.fn(), finished: animationFinished, oncancel: null, onfinish: null };
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
    vi.stubGlobal(
      "getComputedStyle",
      vi.fn(
        (element: Element) =>
          ({
            backgroundColor: element.matches(".burrow-row") ? "rgba(0, 0, 0, 0)" : "rgb(1, 2, 3)",
            transform: computedTransform,
          }) as CSSStyleDeclaration,
      ),
    );

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
    expect(animate.mock.calls.some(([frames]) => JSON.stringify(frames).includes("translateX(8px)"))).toBe(true);
    expect(animate.mock.calls.some(([frames]) => JSON.stringify(frames).includes("translateY(40px)"))).toBe(true);
    expect(motionMocks.flash).toHaveBeenCalled();
    expect(view.container.querySelector('[aria-hidden="true"][inert][role="presentation"]')).not.toBeNull();
    computedTransform = "matrix(1, 0, 0, 1, 0, 0)";
    reordered = false;
    view.rerender(
      <DataTable<Row>
        data={[
          { id: "n-3", name: "gamma", count: 6 },
          { ...rows[1]!, count: 7 },
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
    expect(animate.mock.calls.some(([frames]) => JSON.stringify(frames).includes("translateY(-40px) matrix(1, 0, 0, 1, 0, 0)"))).toBe(true);
    animations.forEach((animation) => {
      animation.onfinish?.();
    });
    expect(view.container.querySelector('[aria-hidden="true"][inert][role="presentation"]')).toBeNull();
    view.unmount();
    expect(animations.some((animation) => animation.cancel.mock.calls.length > 0)).toBe(true);
  });

  it("skips row animations when the motion token duration is zero", async () => {
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    const animate = vi.fn(() => ({ cancel: vi.fn(), finished: animationFinished }) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    motionMocks.allowed = true;
    motionMocks.duration = 0;
    const view = renderTable({ data: [...rows] });
    view.rerender(
      <DataTable<Row>
        data={[rows[1]!]}
        columns={columns}
        getRowId={(row) => row.id}
        label="Nodes"
        storageKey="test-data-table"
        sorting={[]}
        onSortingChange={view.onSortingChange}
        columnVisibility={{}}
        onColumnVisibilityChange={view.onColumnVisibilityChange}
        defaultVisibility={{ id: true, name: true, count: false }}
        selectable
        exportName="nodes"
      />,
    );
    expect(animate).not.toHaveBeenCalled();
  });

  it("handles rows whose entity key is empty during a live data update", () => {
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: vi.fn(() => ({ cancel: vi.fn(), finished: animationFinished }) as unknown as Animation),
    });
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    motionMocks.allowed = true;
    const view = renderTable({ data: [rows[0]!], entityKey: () => "" });
    view.rerender(
      <DataTable<Row>
        data={[rows[1]!]}
        columns={columns}
        getRowId={(row) => row.id}
        entityKey={() => ""}
        label="Nodes"
        storageKey="test-data-table"
        sorting={[]}
        onSortingChange={view.onSortingChange}
        columnVisibility={{}}
        onColumnVisibilityChange={view.onColumnVisibilityChange}
        defaultVisibility={{ id: true, name: true, count: false }}
        selectable
        exportName="nodes"
      />,
    );
    expect(view.container.querySelector('.burrow-row[data-ye=""]')).not.toBeNull();
  });

  it("does not add a transient flash under a pulsing status indicator", () => {
    const statusColumns: ColDef<Row>[] = [
      { id: "name", accessorKey: "name", meta: { label: "Name" }, cell: () => <span className="burrow-dot-pulse" /> },
    ];
    const view = renderTable({ columns: statusColumns, rowVersion: (row) => row.count });
    view.rerender(
      <DataTable<Row>
        data={[{ ...rows[0]!, count: 3 }, rows[1]!]}
        columns={statusColumns}
        getRowId={(row) => row.id}
        label="Nodes"
        storageKey="test-data-table"
        sorting={[]}
        onSortingChange={view.onSortingChange}
        columnVisibility={{}}
        onColumnVisibilityChange={view.onColumnVisibilityChange}
        defaultVisibility={{ name: true }}
        selectable
        rowVersion={(row) => row.count}
        exportName="nodes"
      />,
    );
    expect(motionMocks.flash).not.toHaveBeenCalled();
  });

  it("cleans parity stamps from exit clones and cancels active row animations on updates and unmount", async () => {
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate") ?? null;
    const animations: Array<{ cancel: ReturnType<typeof vi.fn>; oncancel: (() => void) | null; onfinish: (() => void) | null }> = [];
    const exitNodes: HTMLElement[] = [];
    const exitAnimations: Array<{ cancel: ReturnType<typeof vi.fn>; oncancel: (() => void) | null; onfinish: (() => void) | null }> = [];
    const animate = vi.fn(function (this: HTMLElement) {
      const isExit = this.getAttribute("role") === "presentation";
      if (isExit) exitNodes.push(this);
      const animation = { cancel: vi.fn(), finished: animationFinished, oncancel: null, onfinish: null };
      animations.push(animation);
      if (isExit) exitAnimations.push(animation);
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
    const fourth = [
      { id: "n-4", name: "delta", count: 8 },
      { id: "n-5", name: "epsilon", count: 10 },
    ];
    const view = renderTable({ data: first, columns: datumColumns, selectable: false, contentIdentity: "first" });
    expect(await screen.findByText("alpha")).toBeTruthy();

    const renderData = (data: readonly Row[], contentIdentity = "first") =>
      view.rerender(
        <DataTable<Row>
          data={data}
          columns={datumColumns}
          getRowId={(row) => row.id}
          entityKey={(row) => row.id}
          label="Nodes"
          exportName="nodes"
          storageKey="test-data-table"
          sorting={[]}
          onSortingChange={view.onSortingChange}
          columnVisibility={{}}
          onColumnVisibilityChange={view.onColumnVisibilityChange}
          defaultVisibility={{ name: true }}
          selectable={false}
          rowVersion={(row) => row.count}
          contentIdentity={contentIdentity}
        />,
      );

    renderData(second);
    expect(await screen.findByText("gamma")).toBeTruthy();
    expect(exitNodes).toHaveLength(1);
    expect(exitNodes[0]!.querySelector("[data-yf], [data-yv], [data-ye], [id]")).toBeNull();

    renderData(third, "second");
    expect(await screen.findByText("delta")).toBeTruthy();
    expect(animations.some((animation) => animation.cancel.mock.calls.length > 0)).toBe(true);
    expect(exitNodes).toHaveLength(1);
    expect(exitNodes[0]!.parentElement).toBeNull();
    renderData(fourth, "second");
    expect(await screen.findByText("epsilon")).toBeTruthy();
    expect(exitNodes).toHaveLength(2);
    expect(exitNodes[1]!.parentElement).not.toBeNull();
    expect(exitAnimations[1]!.cancel).not.toHaveBeenCalled();
    view.unmount();
    expect(exitNodes.every((element) => element.parentElement === null)).toBe(true);
    expect(exitAnimations[1]!.cancel).toHaveBeenCalledTimes(1);
    expect(animations.every((animation) => animation.cancel.mock.calls.length > 0)).toBe(true);
  });
});
