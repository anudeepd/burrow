import { rawString } from "~/lib/format";

export interface ExportColumn {
  id: string;
  label: string;
  value: (row: unknown) => unknown;
}

function csvCell(v: unknown): string {
  const s = rawString(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** RFC 4180 CSV of raw values (not formatted text) so exports round-trip into other tools. */
export function toCsv(cols: ExportColumn[], rows: unknown[]): string {
  const head = cols.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(c.value(r))).join(","));
  return [head, ...body].join("\r\n");
}

export function toJson(cols: ExportColumn[], rows: unknown[]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(cols.map((c) => [c.id, c.value(r) ?? null]))),
    null,
    2,
  );
}

export function download(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
