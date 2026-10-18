/**
 * Component-level checks for the log chrome: the status bar's transport/eof surface and the toolbar's provenance.
 * (The heavy line-rendering logic is covered by `model.test.ts` and `segments.test.ts`; virtualization itself needs a
 * real layout, so that part is Playwright's job.)
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseLogsLink } from "./ContainerPicker";
import { LogStatusBar } from "./LogStatusBar";

const base = {
  shown: 100,
  total: 100,
  dropped: 0,
  hits: 0,
  activeMatch: 0,
  filter: null,
  followMode: "off" as const,
  followDetail: null,
  behind: null,
  size: 1024,
  heldBytes: 1024,
  ended: false,
  gaps: 0,
  notice: null,
  onRetry: () => {},
};

describe("LogStatusBar", () => {
  it("reports the loaded lines and the transport", () => {
    render(<LogStatusBar {...base} followMode="streaming" />);
    expect(screen.getByText(/100 lines/)).toBeTruthy();
    expect(screen.getByText("Streaming")).toBeTruthy();
  });

  it("marks a finished stream", () => {
    const { container } = render(<LogStatusBar {...base} followMode="ended" ended />);
    expect(container.querySelector("[data-burrow-log-ended]")).toBeTruthy();
    expect(screen.getByText("Stream ended")).toBeTruthy();
  });

  it("says when it fell back to polling and offers a retry", () => {
    const onRetry = vi.fn();
    render(<LogStatusBar {...base} followMode="polling" followDetail="stream connection lost" onRetry={onRetry} />);
    expect(screen.getByText("Polling")).toBeTruthy();
    expect(screen.getByText(/stream connection lost/)).toBeTruthy();
    screen.getByRole("button", { name: "Retry the log stream" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("surfaces dropped lines, byte gaps and match position", () => {
    render(<LogStatusBar {...base} shown={40} total={100} dropped={60} hits={12} activeMatch={2} gaps={1} behind={2048} />);
    expect(screen.getByText(/60 older lines dropped/)).toBeTruthy();
    expect(screen.getByText(/match 3 of 12/)).toBeTruthy();
    expect(screen.getByText(/1 byte gap/)).toBeTruthy();
    expect(screen.getByText(/KiB behind/)).toBeTruthy();
  });

  it("shows an action notice", () => {
    render(<LogStatusBar {...base} notice="No ERROR/FATAL line in the loaded window" />);
    expect(screen.getByText("No ERROR/FATAL line in the loaded window")).toBeTruthy();
  });
});

describe("parseLogsLink", () => {
  it("recovers node, container and user from the RM's aggregated-log URL", () => {
    const link =
      "http://127.0.0.1:19888/jobhistory/logs/127.0.0.4:8041/container_1791015583684_0002_01_000001/container_1791015583684_0002_01_000001/carol";
    expect(parseLogsLink(link)).toEqual({
      node: "127.0.0.4:8041",
      containerId: "container_1791015583684_0002_01_000001",
      user: "carol",
    });
  });

  it("returns nulls for absent or unparseable links", () => {
    const empty = { node: null, containerId: null, user: null };
    expect(parseLogsLink(null)).toEqual(empty);
    expect(parseLogsLink("")).toEqual(empty);
    expect(parseLogsLink("http://127.0.0.1:8042/node/containerlogs/container_1_2_3_4/alice")).toEqual(empty);
  });
});
