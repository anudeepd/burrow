import {
  type ColumnDef,
  type RowData,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createSortedRowModel,
  metaHelper,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
} from "@tanstack/react-table";
import type { ReactNode } from "react";

/** Per-column metadata consumed by DataTable (chooser, export, alignment). */
export interface ColMeta {
  /** Human label shown in the header and the column chooser (legacy YARN label where one exists). */
  label: string;
  /** shown unless the user/URL says otherwise; ignored in parity mode (everything shows) */
  defaultVisible?: boolean;
  align?: "start" | "end";
  /** raw value for CSV/JSON export (never the formatted text). Defaults to the accessor value. */
  exportValue?: (row: never) => unknown;
  /** header tooltip / chooser description */
  hint?: ReactNode;
  /** cannot be hidden (e.g. the identifier column) */
  pinned?: boolean;
}

/** One feature set for every Burrow table: sorting, visibility, sizing + resizing, selection. */
export const tableFeatureSet = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, datetime: sortFn_datetime, basic: sortFn_basic },
  columnVisibilityFeature,
  columnSizingFeature,
  columnResizingFeature,
  rowSelectionFeature,
  columnMeta: metaHelper<ColMeta>(),
});

export type TableFeatureSet = typeof tableFeatureSet;
export type ColDef<T extends RowData> = ColumnDef<TableFeatureSet, T>;
