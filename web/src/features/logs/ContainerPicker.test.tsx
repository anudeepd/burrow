import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppAttempt, Container } from "~/api/schemas";

window.__BURROW_PARITY__ = true;

const mockState = vi.hoisted(() => ({
  attempts: null as unknown,
  containers: [] as unknown[],
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => mockState.attempts,
  useQueries: () => mockState.containers,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to, params: _params, ...props }: { children?: React.ReactNode; to: string; params?: unknown } & Record<string, unknown>) =>
    createElement("a", { ...props, href: to }, children),
}));

const { cleanup, fireEvent, render, screen, within } = await import("@testing-library/react");
const { ContainerPicker, parseLogsLink } = await import("./ContainerPicker");
const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/app/finished/appattempts.json"), "utf8")) as {
  appAttempts: { appAttempt: AppAttempt[] };
};
const baseAttempt = fixture.appAttempts.appAttempt[0]!;

function setAttempts(patch: Record<string, unknown>) {
  mockState.attempts = {
    data: { appAttempts: { appAttempt: [baseAttempt] } },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...patch,
  };
}

afterEach(() => {
  cleanup();
  mockState.attempts = null;
  mockState.containers = [];
});

describe("ContainerPicker", () => {
  it("parses the aggregated log URL and rejects missing or malformed URLs", () => {
    expect(parseLogsLink(null)).toEqual({ node: null, containerId: null, user: null });
    expect(parseLogsLink("not-a-log-url")).toEqual({ node: null, containerId: null, user: null });
    expect(parseLogsLink(baseAttempt.logsLink)).toEqual({
      node: "127.0.0.4:8041",
      containerId: baseAttempt.containerId,
      user: "bob",
    });
  });

  it("shows loading and lets the user recover from an attempts failure by entering an id", () => {
    setAttempts({ data: undefined, isPending: true });
    const pending = render(<ContainerPicker appId="application_1791010984040_0002" onPick={vi.fn()} />);
    expect(pending.container.querySelector('[aria-busy="true"]')).toBeTruthy();
    pending.unmount();

    const retry = vi.fn();
    const onPick = vi.fn();
    setAttempts({ data: undefined, isError: true, error: new Error("RM unavailable"), refetch: retry });
    render(<ContainerPicker appId="application_1791010984040_0002" onPick={onPick} />);
    expect(screen.getByText("RM unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retry).toHaveBeenCalledOnce();
    const input = screen.getByRole("textbox", { name: "Container id" });
    expect(screen.getByRole("button", { name: "Open pasted container" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "bad-id" } });
    expect(screen.getByText(/Not a container id/)).toBeTruthy();
    fireEvent.change(input, { target: { value: baseAttempt.containerId } });
    fireEvent.submit(input.closest("form")!);
    expect(onPick).toHaveBeenCalledWith(baseAttempt.containerId, null, null);
  });

  it("uses attempt metadata for finished ApplicationMaster logs, falling back to the JobHistory URL", () => {
    const onPick = vi.fn();
    const attempt = { ...baseAttempt, containerId: "", nodeHttpAddress: "", nodeId: "" };
    setAttempts({ data: { appAttempts: { appAttempt: [attempt] } } });
    mockState.containers = [{ data: {}, isError: false }];
    render(<ContainerPicker appId="application_1791010984040_0002" onPick={onPick} />);
    expect(screen.getByRole("table", { name: "ApplicationMaster containers of application_1791010984040_0002" })).toBeTruthy();
    expect(screen.getByText("Aggregated (JobHistory)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Aggregated log \(JobHistory\)/ }));
    expect(onPick).toHaveBeenCalledWith(attempt.containerId || baseAttempt.containerId, "127.0.0.4:8041", "bob");
  });

  it("lists live non-AM containers and opens them from their NodeManager", () => {
    const onPick = vi.fn();
    const amId = baseAttempt.containerId;
    const live: Container = {
      containerId: "container_1791010984040_0002_01_000002",
      allocatedMB: 1024,
      allocatedVCores: 1,
      priority: 0,
      startedTime: 1_791_011_000_000,
      finishedTime: 0,
      elapsedTime: 10,
      containerExitStatus: -1000,
      containerState: "RUNNING",
      nodeHttpAddress: "http://worker:8042",
      nodeId: "worker:8041",
    };
    setAttempts({ data: { appAttempts: { appAttempt: [{ ...baseAttempt, logsLink: "" }] } } });
    mockState.containers = [
      {
        data: {
          containers: {
            container: [
              { ...live, containerId: amId },
              live,
            ],
          },
        },
        isError: false,
      },
    ];
    render(<ContainerPicker appId="application_1791010984040_0002" onPick={onPick} />);
    expect(screen.getByRole("table", { name: "Live containers of application_1791010984040_0002" })).toBeTruthy();
    const table = screen.getByRole("table", { name: "Live containers of application_1791010984040_0002" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    fireEvent.click(within(table).getByRole("button", { name: /Open logs/ }));
    expect(onPick).toHaveBeenCalledWith(live.containerId, "http://worker:8042", null);
  });

  it("shows empty and partial lookup failures without hiding known ApplicationMaster rows", () => {
    const attempts = Array.from({ length: 4 }, (_, i) => ({
      ...baseAttempt,
      appAttemptId: `appattempt_1791010984040_0002_00000${i + 1}`,
      containerId: i === 0 ? baseAttempt.containerId : "",
      logsLink: i === 0 ? baseAttempt.logsLink : "",
    }));
    const refetch = vi.fn();
    setAttempts({ data: { appAttempts: { appAttempt: attempts } }, isError: true, error: new Error("refresh failed") });
    mockState.containers = [
      { isError: true, error: new Error("worker A"), refetch },
      { isError: true, error: "worker B", refetch },
      { isError: true, error: new Error("worker C"), refetch },
      { isError: true, error: new Error("worker D"), refetch },
    ];
    render(<ContainerPicker appId="application_1791010984040_0002" onPick={vi.fn()} />);
    expect(screen.getByText(/4 attempt container lookup\(s\) failed/)).toBeTruthy();
    expect(screen.getByText(/1 more failed/)).toBeTruthy();
    expect(screen.getByText("refresh failed")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /retry/i })[1]!);
    expect(refetch).toHaveBeenCalledTimes(4);
  });

  it("explains when neither attempts nor live container queries identify a container", () => {
    setAttempts({ data: { appAttempts: { appAttempt: [] } } });
    mockState.containers = [];
    render(<ContainerPicker appId="application_1791010984040_0002" onPick={vi.fn()} />);
    expect(screen.getByText("No container named by this application")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Container id" })).toBeTruthy();
  });
});
