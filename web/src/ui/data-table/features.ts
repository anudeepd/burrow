import {
  type ColumnDef,
  type RowData,
  columnOrderingFeature,
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
  /** allow long headers to wrap on compact tables instead of ellipsizing the label */
  wrapHeader?: boolean;
  /** cannot be hidden (e.g. the identifier column) */
  pinned?: boolean;
}

/** One feature set for every Burrow table: ordering, sorting, visibility, sizing + resizing, and selection. */
export const tableFeatureSet = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, datetime: sortFn_datetime, basic: sortFn_basic },
  columnOrderingFeature,
  columnVisibilityFeature,
  columnSizingFeature,
  columnResizingFeature,
  rowSelectionFeature,
  columnMeta: metaHelper<ColMeta>(),
});

export type TableFeatureSet = typeof tableFeatureSet;
export type ColDef<T extends RowData> = ColumnDef<TableFeatureSet, T>;
