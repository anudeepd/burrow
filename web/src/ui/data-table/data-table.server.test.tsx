// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ColDef } from "./features";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({ getVirtualItems: () => [], measure: vi.fn() }),
}));

interface Row {
  id: string;
}

const columns: ColDef<Row>[] = [{ id: "id", accessorKey: "id", meta: { label: "ID" } }];

describe("DataTable server rendering", () => {
  it("renders without browser storage or pointer APIs", async () => {
    const { DataTable } = await import("./data-table");
    const html = renderToString(
      <DataTable<Row>
        data={[{ id: "one" }]}
        columns={columns}
        getRowId={(row) => row.id}
        label="Rows"
        storageKey="server-table"
        sorting={[]}
        onSortingChange={() => undefined}
        onColumnVisibilityChange={() => undefined}
        exportName="rows"
      />,
    );
    expect(html).toContain('aria-label="Rows"');
    expect(html).toContain("one");
  });
});
