import { afterEach, describe, expect, it, vi } from "vitest";

window.__BURROW_PARITY__ = true;

const mockState = vi.hoisted(() => ({
  query: null as unknown,
  connection: { lastOkAt: null as number | null, consecutiveFailures: 0 },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => mockState.query,
}));
vi.mock("~/api/connection", () => ({
  useConnection: (select: (state: { lastOkAt: number | null; consecutiveFailures: number }) => unknown) => select(mockState.connection),
}));

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ServicesHealthSection } = await import("./services-health");

const meta = {
  name: "Burrow",
  version: "1.2.3",
  now: 1_791_011_000_000,
  readOnly: true,
  rm: {
    urls: ["http://rm-a:8088", "http://rm-b:8088"],
    active: "http://rm-a:8088",
    haState: "ACTIVE",
    hadoopVersion: "3.4.3",
    reachable: true,
  },
  services: {
    sparkHistory: {
      configured: true,
      urls: ["http://history:18080"],
      reachable: false,
      candidates: [
        { url: "http://history:18080", reachable: false, reason: "connection refused" },
        { url: "http://history-2:18080", reachable: true },
      ],
    },
    jobHistory: { configured: false, url: null, reachable: null, reason: "disabled" },
    timeline: { configured: true, url: "http://timeline:8188", reachable: null, reason: "not probed" },
  },
  features: { sparkLive: true, sparkHistory: false, aggregatedLogs: true, nodeLogs: false, events: true, kerberos: false },
  yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
};

function setQuery(patch: Record<string, unknown>) {
  mockState.query = { data: meta, isPending: false, isError: false, error: null, refetch: vi.fn(), ...patch };
}

afterEach(() => {
  cleanup();
  mockState.query = null;
  mockState.connection = { lastOkAt: null, consecutiveFailures: 0 };
});

describe("ServicesHealthSection", () => {
  it("renders service skeletons while metadata is pending", () => {
    setQuery({ data: undefined, isPending: true });
    const { container } = render(<ServicesHealthSection />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelectorAll("[aria-hidden='true']").length).toBeGreaterThan(0);
  });

  it("shows the unavailable state and retries when no metadata has loaded", () => {
    const refetch = vi.fn();
    setQuery({ data: undefined, isError: true, error: new Error("metadata request failed"), refetch });
    render(<ServicesHealthSection />);
    expect(screen.getByText("metadata request failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("uses the generic message for an empty non-Error metadata failure", () => {
    setQuery({ data: undefined, isError: true, error: null });
    render(<ServicesHealthSection />);
    expect(screen.getByText("The ResourceManager did not return service details.")).toBeTruthy();
  });

  it("shows compact service states and the stale-data banner", () => {
    const refetch = vi.fn();
    setQuery({ isError: true, error: new Error("refresh failed"), refetch });
    render(<ServicesHealthSection />);
    expect(screen.getByTestId("services")).toBeTruthy();
    expect(screen.getByTestId("service-spark-history").textContent).toContain("Unreachable");
    expect(screen.getByTestId("service-job-history").textContent).toContain("Not configured");
    expect(screen.getByTestId("service-timeline-service").textContent).toContain("Reachable");
    expect(screen.getByText(/showing the last loaded values/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("renders the detailed pre-release service and capability diagnostics", () => {
    mockState.connection = { lastOkAt: 1_791_011_000_000, consecutiveFailures: 2 };
    const refetch = vi.fn();
    setQuery({ isError: true, error: new Error("refresh failed"), refetch });
    render(<ServicesHealthSection renderVersion="pre" />);
    expect(screen.getByText("ResourceManager")).toBeTruthy();
    expect(screen.getByText("http://rm-a:8088")).toBeTruthy();
    expect(screen.getByText("http://history:18080")).toBeTruthy();
    expect(screen.getByText("sparkLive")).toBeTruthy();
    expect(screen.getAllByText("○").length).toBe(3);
    expect(screen.getByText(/API 2 failed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Configuration" }).getAttribute("href")).toBe("/tools/conf");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("covers unreported addresses, scheduler settings, write access, and successful API health", () => {
    mockState.connection = { lastOkAt: 1_791_011_000_000, consecutiveFailures: 0 };
    const sparseMeta = {
      ...meta,
      version: "0.0.0",
      rm: { ...meta.rm, active: null, urls: [], hadoopVersion: null, haState: null },
      services: {
        sparkHistory: {
          configured: true,
          url: null,
          urls: [],
          reachable: false,
          candidates: [{ url: "http://history-down:18080", reachable: false, reason: null }],
        },
        jobHistory: { configured: true, url: null, urls: [], reachable: true, candidates: [] },
        timeline: { configured: false, url: null, urls: [], reachable: null, candidates: [] },
      },
      features: { sparkLive: false, sparkHistory: false, aggregatedLogs: false, nodeLogs: false, events: false, kerberos: false },
      yarn: { ...meta.yarn, scheduler: null, httpPolicy: "HTTPS_ONLY" },
      readOnly: false,
    } as unknown as typeof meta;
    setQuery({ data: sparseMeta, isError: true, error: "stale metadata" });
    render(<ServicesHealthSection renderVersion="pre" />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getAllByText("configured")).toHaveLength(2);
    expect(screen.getByText("http HTTPS_ONLY")).toBeTruthy();
    expect(screen.getByText("read/write")).toBeTruthy();
    expect(screen.getByText(/API ok/)).toBeTruthy();
  });
});
