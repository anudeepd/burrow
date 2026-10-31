import { afterEach, describe, expect, it, vi } from "vitest";
import { download, toCsv, toJson, type ExportColumn } from "./export";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const columns: ExportColumn[] = [
  { id: "name", label: 'Name, "quoted"', value: (row) => (row as { name: string }).name },
  { id: "count", label: "Count", value: (row) => (row as { count?: number }).count },
  { id: "metadata", label: "Metadata", value: (row) => (row as { metadata?: unknown }).metadata },
];

describe("table export formats", () => {
  it("quotes CSV cells using RFC 4180 escaping and leaves ordinary cells bare", () => {
    expect(toCsv(columns, [{ name: 'a,"b"\r\nc', count: 3, metadata: { ok: true } }])).toBe(
      '"Name, ""quoted""",Count,Metadata\r\n"a,""b""\r\nc",3,"{""ok"":true}"',
    );
    expect(toCsv([{ id: "flag", label: "Flag", value: () => true }], [{}])).toBe("Flag\r\ntrue");
  });

  it("exports raw JSON values and turns absent values into null", () => {
    expect(
      JSON.parse(
        toJson(columns, [
          { name: "row", count: 0 },
          { name: "other", metadata: null },
        ]),
      ),
    ).toEqual([
      { name: "row", count: 0, metadata: null },
      { name: "other", count: null, metadata: null },
    ]);
    expect(toJson([], [{}])).toBe("[\n  {}\n]");
  });

  it("creates a browser download and revokes its object URL after a delay", () => {
    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:burrow");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    download("nodes.csv", "text/csv", "id\r\n1");
    expect(click).toHaveBeenCalledOnce();
    const anchor = document.querySelector<HTMLAnchorElement>('a[download="nodes.csv"]');
    expect(anchor).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(revoke).toHaveBeenCalledWith("blob:burrow");
  });
});
