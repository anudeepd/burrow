/** Normalize the value-or-function update shape used by controlled table state. */
export function resolveUpdater<T>(update: T | ((previous: T) => T), previous: T): T {
  return typeof update === "function" ? (update as (previous: T) => T)(previous) : update;
}

export function addSort(
  id: string | null,
  isDefault: boolean,
  sorting: { id: string; desc: boolean }[],
  onChange: (next: { id: string; desc: boolean }[]) => void,
): void {
  if (!id) return;
  onChange(isDefault ? [{ id, desc: false }] : [...sorting, { id, desc: false }]);
}
