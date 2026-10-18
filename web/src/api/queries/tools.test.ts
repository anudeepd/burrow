// @vitest-environment node
/**
 * `/api/rm/logs` normalisation. The backend synthesizes this payload from the RM's Jetty directory listing, whose date
 * column is **zone-free**; the container-log endpoints (contract §5) do report epoch ms. The SPA accepts both, displays the
 * verbatim string when there is no epoch, and never invents a timestamp.
 */
import { describe, expect, it } from "vitest";
import { daemonDateSortKey, LOG_PAGE_BYTES, logWindow, RmLogsSchema } from "./tools";

// verbatim from the live RM `/logs/` page (Jetty 12), through crates/burrow-core/src/html.rs
const daemonShape = {
  files: [
    { name: "resourcemanager.log", size: 222179, modified: "Oct 3, 2026, 12:31:04 PM", isDir: false },
    { name: "rm.out", size: 1712, modified: "Oct 3, 2026, 12:02:00 PM", isDir: false },
    { name: "ancient.log", size: 10, modified: "Jan 9, 2026, 1:05:00 AM", isDir: false },
    { name: "subdir", size: 0, modified: null, isDir: true },
  ],
};

const containerShape = {
  files: [{ name: "stdout", size: 222179, lastModified: 1791010864794 }],
};

describe("RmLogsSchema", () => {
  it("keeps the daemon's verbatim date and refuses to invent an epoch from it", () => {
    const files = RmLogsSchema.parse(daemonShape);
    const log = files.find((f) => f.name === "resourcemanager.log");
    expect(log?.size).toBe(222179);
    expect(log?.modifiedText).toBe("Oct 3, 2026, 12:31:04 PM");
    expect(log?.lastModified).toBeNull();
    expect(log?.modifiedSortKey).toBe(daemonDateSortKey("Oct 3, 2026, 12:31:04 PM"));
    expect(log?.modifiedSortKey).toBeGreaterThan(daemonDateSortKey("Jan 9, 2026, 1:05:00 AM") as number);
  });

  it("orders newest-first and puts directories last", () => {
    const names = RmLogsSchema.parse(daemonShape).map((f) => f.name);
    expect(names).toEqual(["resourcemanager.log", "rm.out", "ancient.log", "subdir"]);
  });

  it("passes the container-log epoch through untouched", () => {
    const files = RmLogsSchema.parse(containerShape);
    expect(files[0]?.lastModified).toBe(1791010864794);
    expect(files[0]?.modifiedText).toBeNull();
    expect(files[0]?.modifiedSortKey).toBeNull();
  });

  it("tolerates a grouped/absent size and an unparseable date without throwing", () => {
    const files = RmLogsSchema.parse({
      files: [
        { name: "a.log", size: "1,712" },
        { name: "b.log", modified: "¿qué?" },
      ],
    });
    expect(files.find((f) => f.name === "a.log")?.size).toBe(1712);
    expect(files.find((f) => f.name === "b.log")?.size).toBe(0);
    expect(files.find((f) => f.name === "b.log")?.modifiedSortKey).toBeNull();
  });
});

describe("daemonDateSortKey", () => {
  it("parses both Jetty layouts and the 12-hour clock edge cases", () => {
    expect(daemonDateSortKey("Oct 3, 2026, 12:31:04 PM")).toBe(Date.UTC(2026, 9, 3, 12, 31, 4));
    expect(daemonDateSortKey("Oct 3, 2026 12:02:00 PM")).toBe(Date.UTC(2026, 9, 3, 12, 2, 0));
    expect(daemonDateSortKey("Jan 9, 2026, 12:05:00 AM")).toBe(Date.UTC(2026, 0, 9, 0, 5, 0));
    expect(daemonDateSortKey("Jan 9, 2026, 12:05:00 PM")).toBe(Date.UTC(2026, 0, 9, 12, 5, 0));
    expect(daemonDateSortKey("not a date")).toBeNull();
    expect(daemonDateSortKey(null)).toBeNull();
  });
});

describe("logWindow", () => {
  it("clamps a byte range to the file and always returns a usable window", () => {
    expect(logWindow(1000, 0, 128)).toEqual({ offset: 0, length: 128 });
    expect(logWindow(1000, 950, 128)).toEqual({ offset: 950, length: 50 });
    expect(logWindow(1000, 5000, 128)).toEqual({ offset: 999, length: 1 });
    expect(logWindow(1000, -5, 128)).toEqual({ offset: 0, length: 128 });
    expect(logWindow(0, 0)).toEqual({ offset: 0, length: LOG_PAGE_BYTES });
  });
});
