/**
 * Local (non-URL) sorting/visibility state for the secondary tables on the app-detail pages.
 *
 * The *primary* list (the attempts tab) syncs to the URL; the nested tables (containers inside an attempt, outstanding
 * resource requests) keep their state in the component so a link to an attempt never carries six extra params.
 */
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { useState } from "react";

export function useLocalTableState(defaults: ColumnVisibilityState) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [visibility, setVisibility] = useState<ColumnVisibilityState>(defaults);
  return { sorting, setSorting, visibility, setVisibility, defaults };
}
