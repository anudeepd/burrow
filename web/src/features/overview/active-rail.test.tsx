import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "~/api/schemas";

window.__BURROW_PARITY__ = true;

const mockState = vi.hoisted(() => ({
  query: null as unknown,
  connection: { lastCache: null as string | null },
  push: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => mockState.query,
}));
vi.mock("~/api/connection", () => ({
  useConnection: (select: (state: { lastCache: string | null }) => unknown) => select(mockState.connection),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ history: { push: mockState.push } }),
}));

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ActiveRail } = await import("./active-rail");
const { readFileSync } = await import("node:fs");
const { resolve } = await import("node:path");
const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/overview/apps-active.json"), "utf8")) as {
  apps: { app: App[] };
};
const app = fixture.apps.app[0]!;

function setQuery(patch: Record<string, unknown>) {
  mockState.query = {
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...patch,
  };
}

afterEach(() => {
  cleanup();
  mockState.query = null;
  mockState.connection.lastCache = null;
  mockState.push.mockClear();
});

describe("ActiveRail", () => {
  it("shows its loading skeleton and retries an unavailable active-app request", () => {
    setQuery({ isPending: true });
    const pending = render(<ActiveRail parity={false} />);
    expect(pending.container.querySelector('[aria-busy="true"]')).toBeTruthy();
    pending.unmount();

    const retry = vi.fn();
    setQuery({ isError: true, error: new Error("RM is offline"), refetch: retry });
    render(<ActiveRail parity={false} />);
    expect(screen.getByText("RM is offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("shows the empty and stale states when the last response contains no active apps", () => {
    mockState.connection.lastCache = "stale";
    setQuery({ data: [], isError: true, error: new Error("refresh failed") });
    render(<ActiveRail parity={false} />);
    expect(screen.getByText("Nothing is running right now")).toBeTruthy();
    expect(screen.getByText(/showing the last loaded result/i)).toBeTruthy();
  });

  it("ranks running work first, limits the default rail, and keeps every row in parity mode", () => {
    const apps: App[] = [
      { ...app, id: "queued-old", name: "queued-old", state: "ACCEPTED", startedTime: 1 },
      { ...app, id: "running-late", name: "running-late", state: "RUNNING", startedTime: 3, progress: undefined } as unknown as App,
      { ...app, id: "running-early", name: "running-early", state: "RUNNING", startedTime: 2, applicationType: undefined },
      ...Array.from({ length: 4 }, (_, i) => ({ ...app, id: `queued-${i}`, name: `queued-${i}`, state: "SUBMITTED", startedTime: 4 + i })),
    ];
    setQuery({ data: apps });

    const defaultRail = render(<ActiveRail parity={false} bordered />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[0]?.getAttribute("data-testid")).toBe("app-row-running-early");
    expect(rows[1]?.getAttribute("data-testid")).toBe("app-row-running-late");
    expect(screen.getByText("5 shown of 7 active applications")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View all 7 active applications →" })).toBeTruthy();
    defaultRail.unmount();

    mockState.connection.lastCache = "stale";
    render(<ActiveRail parity />);
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.getByText("7 shown active applications")).toBeTruthy();
    expect(screen.getAllByText("Values may be out of date.").length).toBe(7);
    fireEvent.click(screen.getByRole("link", { name: "Open application running-early" }));
    expect(mockState.push).toHaveBeenCalledWith("/apps/running-early", undefined, { ignoreBlocker: true });
  });
});
