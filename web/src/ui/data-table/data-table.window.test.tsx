import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SortingState } from "@tanstack/react-table";
import type { ColDef } from "./features";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: Array.from({ length: index }, (_, i) => estimateSize(i)).reduce((sum, height) => sum + height, 0),
      })),
    measure: vi.fn(),
  }),
}));

vi.mock("~/lib/size", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/size")>()),
  useElementWidth: () => [{ current: null }, 900],
}));

vi.mock("~/lib/motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/motion")>()),
  motionAllowed: () => false,
}));

window.__BURROW_PARITY__ = false;

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { DataTable } = await import("./data-table");
const { parityStore } = await import("~/state/parity");

interface Row {
  id: string;
  name: string;
  count: number;
}

const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
  id: `r-${i}`,
  name: i % 2 === 0 ? `alpha-${i}` : `beta-${i}`,
  count: i,
}));

const columns: ColDef<Row>[] = [
  { id: "id", accessorKey: "id", meta: { label: "ID" } },
  { id: "name", accessorKey: "name", meta: { label: "Name" } },
  { id: "count", accessorKey: "count", meta: { label: "Count" } },
];

function renderWindow(overrides: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  const onSortingChange = vi.fn<(sorting: SortingState) => void>();
  return render(
    <DataTable<Row>
      data={rows.slice(4, 7)}
      columns={columns}
      getRowId={(row) => row.id}
      label="Rows"
      storageKey="window-table"
      sorting={[]}
      onSortingChange={onSortingChange}
      columnVisibility={{}}
      onColumnVisibilityChange={vi.fn()}
      manualSorting
      rowCount={12}
      rowOffset={4}
      preserveScrollAnchor
      exportName="rows"
      {...overrides}
    />,
  );
}

beforeEach(() => {
  parityStore.setState(() => ({ enabled: false }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const table = () => screen.getByRole("table", { name: "Rows" });

describe("windowed DataTable", () => {
  it("maps a loaded slice to its global indices and renders placeholders for the rest", () => {
    const { container } = renderWindow();
    expect(table().getAttribute("aria-rowcount")).toBe("13");
    expect(table().getAttribute("data-burrow-rows")).toBe("12");
    expect(screen.getByText("12 rows")).toBeTruthy();
    expect(container.querySelectorAll("[data-placeholder]").length).toBe(9);
    const loaded = container.querySelector<HTMLElement>('[data-ye="r-4"]')!;
    expect(loaded.getAttribute("aria-rowindex")).toBe("6");
    expect(container.querySelector('[data-ye="r-4"]')?.textContent).toContain("alpha-4");
  });

  it("reports the materialized virtual range", async () => {
    const onVisibleRangeChange = vi.fn();
    renderWindow({ onVisibleRangeChange });
    await waitFor(() => expect(onVisibleRangeChange).toHaveBeenCalledWith(0, 11));
  });

  it("leaves server-ordered rows alone when manualSorting is on", () => {
    const reversed = [rows[2]!, rows[0]!];
    const { container, rerender } = renderWindow({
      data: reversed,
      rowCount: 2,
      rowOffset: 0,
      manualSorting: true,
      sorting: [{ id: "name", desc: false }],
    });
    expect([...container.querySelectorAll<HTMLElement>(".burrow-row[data-ye]")].map((row) => row.getAttribute("data-ye"))).toEqual([
      "r-2",
      "r-0",
    ]);

    rerender(
      <DataTable<Row>
        data={reversed}
        columns={columns}
        getRowId={(row) => row.id}
        label="Rows"
        storageKey="window-table"
        sorting={[{ id: "name", desc: false }]}
        onSortingChange={vi.fn()}
        columnVisibility={{}}
        onColumnVisibilityChange={vi.fn()}
        rowCount={2}
        rowOffset={0}
        exportName="rows"
      />,
    );
    expect([...container.querySelectorAll<HTMLElement>(".burrow-row[data-ye]")].map((row) => row.getAttribute("data-ye"))).toEqual([
      "r-0",
      "r-2",
    ]);
  });

  it("resets the scroll position when the view identity changes", async () => {
    const { rerender } = renderWindow({ scrollResetKey: "one" });
    table().scrollTop = 200;
    fireEvent.scroll(table());
    rerender(
      <DataTable<Row>
        data={rows.slice(4, 7)}
        columns={columns}
        getRowId={(row) => row.id}
        label="Rows"
        storageKey="window-table"
        sorting={[]}
        onSortingChange={vi.fn()}
        columnVisibility={{}}
        onColumnVisibilityChange={vi.fn()}
        manualSorting
        rowCount={12}
        rowOffset={4}
        preserveScrollAnchor
        scrollResetKey="two"
        exportName="rows"
      />,
    );
    await waitFor(() => expect(table().scrollTop).toBe(0));
  });

  it("keeps the anchored row at the same pixel offset when rows appear above it", async () => {
    const { rerender } = renderWindow();
    table().scrollTop = 136; // the first loaded row, r-4
    fireEvent.scroll(table());
    const inserted = { id: "r-new", name: "new", count: -1 };
    rerender(
      <DataTable<Row>
        data={[inserted, ...rows.slice(4, 7)]}
        columns={columns}
        getRowId={(row) => row.id}
        label="Rows"
        storageKey="window-table"
        sorting={[]}
        onSortingChange={vi.fn()}
        columnVisibility={{}}
        onColumnVisibilityChange={vi.fn()}
        manualSorting
        rowCount={13}
        rowOffset={4}
        preserveScrollAnchor
        exportName="rows"
      />,
    );
    await waitFor(() => expect(table().scrollTop).toBe(170));
  });

  it("exports the full filtered result through exportAll when nothing is selected", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:rows");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const exportAll = vi.fn(async () => rows);
    renderWindow({ exportAll });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    await waitFor(() => expect(exportAll).toHaveBeenCalledTimes(1));
    expect(createUrl).toHaveBeenCalledTimes(1);
  });

  it("swallows an exportAll rejection without downloading a partial file", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:rows");
    const exportAll = vi.fn(async () => {
      throw new Error("export failed");
    });
    renderWindow({ exportAll });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
    await waitFor(() => expect(exportAll).toHaveBeenCalledTimes(1));
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("counts the selection column in a placeholder's colspan", () => {
    const { container } = renderWindow({ selectable: true });
    expect(container.querySelector('[data-placeholder] [role="cell"]')?.getAttribute("aria-colspan")).toBe("4");
  });

  it("keeps the scroll position when the anchored row disappears", async () => {
    const { rerender } = renderWindow();
    table().scrollTop = 136;
    fireEvent.scroll(table());
    rerender(
      <DataTable<Row>
        data={rows.slice(5, 8)}
        columns={columns}
        getRowId={(row) => row.id}
        label="Rows"
        storageKey="window-table"
        sorting={[]}
        onSortingChange={vi.fn()}
        columnVisibility={{}}
        onColumnVisibilityChange={vi.fn()}
        manualSorting
        rowCount={12}
        rowOffset={5}
        preserveScrollAnchor
        exportName="rows"
      />,
    );
    await waitFor(() => expect(table().scrollTop).toBe(136));
  });

  it("drops placeholders when the full slice arrives", () => {
    const { container, rerender } = renderWindow();
    expect(container.querySelectorAll("[data-placeholder]").length).toBeGreaterThan(0);
    rerender(
      <DataTable<Row>
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        label="Rows"
        storageKey="window-table"
        sorting={[]}
        onSortingChange={vi.fn()}
        columnVisibility={{}}
        onColumnVisibilityChange={vi.fn()}
        manualSorting
        rowCount={12}
        rowOffset={0}
        preserveScrollAnchor
        exportName="rows"
      />,
    );
    expect(container.querySelectorAll("[data-placeholder]").length).toBe(0);
  });
});
