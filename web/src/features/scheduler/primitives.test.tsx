import { afterEach, describe, expect, it } from "vitest";
import type { SortingState } from "@tanstack/react-table";

window.__BURROW_PARITY__ = true;

const { cleanup, render, screen } = await import("@testing-library/react");
const { CapacityBar, FairBar, FreeReadout, UsedReadout } = await import("./bars");
const { UserTable } = await import("./UserTable");
const { QueueAppsTable } = await import("./QueueAppsTable");
const { PartitionsTable } = await import("./PartitionsTable");
const { FifoQueueStatus } = await import("./FifoQueueStatus");
const { ConfTable } = await import("./ConfTable");
const { KV, StateNote, Unavailable } = await import("./Chrome");
const { Entity } = await import("~/ui/datum");

afterEach(cleanup);

describe("scheduler display primitives", () => {
  it("renders empty and populated readouts and both resource bars", () => {
    const datum = { "data-yf": "queue.usedCapacity", "data-yv": "50" } as never;
    render(
      <Entity id="root.default">
        <FreeReadout freePct={null} freeMb={null} field="queue.derived.free" />
        <FreeReadout freePct={null} freeMb={512} field="queue.derived.freeMb" />
        <UsedReadout usedPct={50} field="queue.derived.used" raw={50} />
        <CapacityBar usedPct={55} capPct={40} maxPct={80} tone="live" label="capacity" datum={datum} />
        <FairBar usedMb={1024} minMb={512} fairMb={2048} maxMb={3072} tone="wait" label="fair" datum={datum} />
      </Entity>,
    );

    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("512 MiB")).toBeTruthy();
    expect(screen.getByText("50.0%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /capacity/ })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /fair/ })).toBeTruthy();
  });

  it("renders boundary values and coincident markers on the freeness bars", () => {
    const datum = { "data-yf": "queue.used", "data-yv": "" } as never;
    render(
      <Entity id="root.default">
        <FreeReadout freePct={50} freeMb={null} field="queue.derived.freePct" />
        <CapacityBar usedPct={null} capPct={null} maxPct={null} tone="idle" label="unknown capacity" datum={datum} />
        <CapacityBar usedPct={Number.NaN} capPct={100} maxPct={80} tone="wait" label="unbounded cap marker" datum={datum} />
        <CapacityBar usedPct={100} capPct={100} maxPct={100} tone="live" label="overlapping limits" datum={datum} />
        <CapacityBar usedPct={50} capPct={100} maxPct={80} tone="live" label="unmarked track end" datum={datum} />
        <CapacityBar usedPct={120} capPct={100} maxPct={80} tone="live" label="track end" datum={datum} />
        <FairBar usedMb={null} minMb={512} fairMb={512} maxMb={512} tone="idle" label="shared limits" datum={datum} />
        <FairBar usedMb={null} minMb={null} fairMb={null} maxMb={null} tone="idle" label="unknown fair share" datum={datum} scale={2048} />
      </Entity>,
    );

    expect(screen.getByText("50.0%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /unknown capacity/ })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /overlapping limits/ })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /unmarked track end/ })).toBeTruthy();
    expect(screen.getAllByRole("progressbar").find((bar) => bar.getAttribute("aria-label")?.startsWith("track end:"))).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /shared limits/ })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: /unknown fair share/ })).toBeTruthy();
  });

  it("renders unavailable resources in the user table", async () => {
    const rows = [
      {
        user: { username: "missing-user", numPendingApplications: 0, numActiveApplications: 0 },
        queuePath: "root.default",
        partition: "",
        used: null,
        userLimit: null,
        amUsed: { memory: 0, vCores: 0 },
        maxAm: null,
      },
      {
        user: { username: "active-gpu-user", numPendingApplications: 1, numActiveApplications: 1, isActive: true },
        queuePath: "root.default",
        partition: "gpu",
        used: { memory: 512, vCores: 1 },
        userLimit: null,
        amUsed: { memory: 0, vCores: 0 },
        maxAm: null,
      },
    ];
    const { useState } = await import("react");
    function Harness() {
      const [sorting, setSorting] = useState<SortingState>([]);
      const [columnVisibility, setColumnVisibility] = useState({});
      return (
        <UserTable
          rows={rows as never}
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
    expect(table.textContent).toContain("active-gpu-user");
    expect(table.textContent).toContain("active");
    expect(table.textContent).toContain("—");
  });

  it("renders the empty queue applications state using its default viewport", async () => {
    render(
      <QueueAppsTable
        apps={[]}
        sorting={[]}
        onSortingChange={() => undefined}
        columnVisibility={{}}
        onColumnVisibilityChange={() => undefined}
      />,
    );
    expect(await screen.findByRole("table", { name: "Applications in this queue" })).toBeTruthy();
    expect(screen.getByText(/No application is running or waiting/)).toBeTruthy();
  });

  it("renders absent partition capacity and usage as unavailable", async () => {
    render(
      <PartitionsTable
        queuePath="root.default"
        rows={[
          {
            cap: {
              capacity: 0,
              usedCapacity: 0,
              maxCapacity: 0,
              absoluteCapacity: 0,
              absoluteUsedCapacity: 0,
              absoluteMaxCapacity: 0,
            } as never,
            res: undefined,
          },
        ]}
        sorting={[{ id: "partition", desc: false }]}
        onSortingChange={() => undefined}
        columnVisibility={{}}
        onColumnVisibilityChange={() => undefined}
      />,
    );
    const table = await screen.findByRole("table", { name: "Node-label partitions of root.default" });
    expect(table.textContent).toContain("Default partition");
    expect(table.textContent).toContain("—");
  });

  it("renders each FIFO capacity availability path", () => {
    const info = {
      type: "fifoScheduler",
      capacity: 0.5,
      usedCapacity: 0.25,
      qstate: "RUNNING",
      minQueueMemoryCapacity: 512,
      maxQueueMemoryCapacity: 2048,
      numNodes: 2,
      usedNodeCapacity: 512,
      availNodeCapacity: 1536,
      totalNodeCapacity: 2048,
      numContainers: 3,
    } as object;

    render(<FifoQueueStatus info={info as never} />);
    expect(screen.getByText("RUNNING")).toBeTruthy();
    cleanup();

    render(
      <FifoQueueStatus
        info={{ ...info, capacity: Number.POSITIVE_INFINITY, usedCapacity: Number.POSITIVE_INFINITY, qstate: undefined } as never}
      />,
    );
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    cleanup();

    render(<FifoQueueStatus info={{ ...info, capacity: 0 } as never} />);
    expect(screen.getByText("RUNNING")).toBeTruthy();
  });

  it("renders scheduler layout and state-note variants", () => {
    render(
      <>
        <KV>default columns</KV>
        <KV columns={1} className="single-column">
          one column
        </KV>
        <KV columns={3}>three columns</KV>
        <Unavailable reason="not reported" />
        <Unavailable reason="not reported" hint="This value is optional." />
        <StateNote title="Idle note" />
        <StateNote title="Warning note" tone="warn">
          warning detail
        </StateNote>
        <StateNote title="Failure note" tone="fail">
          failure detail
        </StateNote>
      </>,
    );

    expect(screen.getByText("default columns").closest("dl")?.className).toContain("xl:grid-cols-2");
    expect(screen.getByText("one column").closest("dl")?.className).toContain("grid-cols-1");
    expect(screen.getByText("three columns").closest("dl")?.className).toContain("xl:grid-cols-3");
    expect(screen.getByText("Warning note").closest('[role="status"]')?.textContent).toContain("warning detail");
    expect(screen.getByText("Failure note").closest('[role="status"]')?.textContent).toContain("failure detail");
  });

  it("shows a dash for a configuration property without a value", async () => {
    render(
      <ConfTable
        properties={[{ name: "yarn.scheduler.capacity.root.default.capacity", value: undefined }]}
        queuePath="root.default"
        showAll
        onShowAllChange={() => undefined}
        sorting={[]}
        onSortingChange={() => undefined}
        columnVisibility={{}}
        onColumnVisibilityChange={() => undefined}
      />,
    );

    const table = await screen.findByRole("table", { name: "Scheduler configuration" });
    expect(table.querySelector('[data-yf="conf.property.value"]')?.textContent).toBe("—");
  });
});
