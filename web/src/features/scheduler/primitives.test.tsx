import { afterEach, describe, expect, it } from "vitest";
import type { SortingState } from "@tanstack/react-table";

window.__BURROW_PARITY__ = true;

const { cleanup, render, screen } = await import("@testing-library/react");
const { CapacityBar, FairBar, FreeReadout, UsedReadout } = await import("./bars");
const { UserTable } = await import("./UserTable");

afterEach(cleanup);

describe("scheduler display primitives", () => {
  it("renders empty and populated readouts and both resource bars", () => {
    const datum = { "data-yf": "queue.usedCapacity", "data-yv": "50" } as never;
    render(
      <>
        <FreeReadout freePct={null} freeMb={null} field="queue.derived.free" />
        <FreeReadout freePct={null} freeMb={512} field="queue.derived.freeMb" />
        <UsedReadout usedPct={50} field="queue.derived.used" raw={50} />
        <CapacityBar usedPct={55} capPct={40} maxPct={80} tone="live" label="capacity" datum={datum} />
        <FairBar usedMb={1024} minMb={512} fairMb={2048} maxMb={3072} tone="wait" label="fair" datum={datum} />
      </>,
    );

    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("512 MiB")).toBeTruthy();
    expect(screen.getByText("50.0%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /capacity/ })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /fair/ })).toBeTruthy();
  });

  it("renders unavailable resources in the user table", async () => {
    const row = {
      user: { username: "missing-user", numPendingApplications: 0, numActiveApplications: 0 },
      queuePath: "root.default",
      partition: "",
      used: null,
      userLimit: null,
      amUsed: { memory: 0, vCores: 0 },
      maxAm: null,
    };
    const { useState } = await import("react");
    function Harness() {
      const [sorting, setSorting] = useState<SortingState>([]);
      const [columnVisibility, setColumnVisibility] = useState({});
      return (
        <UserTable
          rows={[row] as never}
          sorting={sorting}
          onSortingChange={setSorting}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={setColumnVisibility}
        />
      );
    }
    render(<Harness />);
    const table = await screen.findByRole("table", { name: "Queue users" });
    expect(table.textContent).toContain("missing-user");
    expect(table.textContent).toContain("—");
  });
});
