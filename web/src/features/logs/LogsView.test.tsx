import { afterEach, describe, expect, it, vi } from "vitest";

window.__BURROW_PARITY__ = true;

const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { LogsView, logDownloadSize, logErrorMessage } = await import("./LogsView");
const { lq } = await import("~/api/queries/logs");
const { q } = await import("~/api/queries");
const { ApiError } = await import("~/api/client");
const { logsSearchSchema, parseSearch } = await import("./search");
const { parityStore } = await import("~/state/parity");
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

const APP_ID = "application_1_2";
const CONTAINER_ID = "container_1_2_3_4";
const LOG_TEXT = `2026-10-31 10:00:00,000 INFO [main] startup complete
2026-10-31 10:00:01,500 WARN [worker] queue is slow
2026-10-31 10:00:02,000 ERROR [worker] task failed
`;

function renderLogs(
  search = "",
  options: {
    containerId?: string | null;
    filesError?: unknown;
    windowError?: unknown;
    logText?: string;
    omitFile?: boolean;
    omitFileSize?: boolean;
  } = {},
) {
  const containerId = options.containerId === undefined ? CONTAINER_ID : options.containerId;
  const logText = options.logText ?? LOG_TEXT;
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, path: "/apps/$appId" });
  const logs = createRoute({
    getParentRoute: () => app,
    path: "logs",
    validateSearch: (value: Record<string, unknown>) => parseSearch(logsSearchSchema, value),
    component: () => <LogsView />,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([logs])]),
    history: createMemoryHistory({
      initialEntries: [
        `/apps/${APP_ID}/logs${
          containerId
            ? `?container=${encodeURIComponent(containerId)}${options.omitFile ? "" : "&file=stdout"}${search}`
            : search
              ? `?${search.replace(/^&/, "")}`
              : ""
        }`,
      ],
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, refetchOnMount: false } } });
  const hints = { node: null, user: null, app: APP_ID };
  if (containerId) {
    const filesKey = lq.files(containerId, hints).queryKey;
    client.setQueryData(filesKey, {
      source: "nm",
      node: "worker:8041",
      files: [
        { name: "stderr", size: 9, lastModified: null },
        { name: "stdout", ...(options.omitFileSize ? {} : { size: logText.length }), lastModified: null },
      ],
    } as never);
    const windowKey = ["logs", "window", containerId, "stdout", 0, "", "", ""];
    client.setQueryData(windowKey, {
      text: logText,
      start: 0,
      end: logText.length,
      size: logText.length,
      source: "nm",
      responseMeta: null,
    });
    for (const [key, error] of [
      [filesKey, options.filesError],
      [windowKey, options.windowError],
    ] as const) {
      if (!error) continue;
      const query = client.getQueryCache().find({ queryKey: key })!;
      query.setState({
        ...query.state,
        data: undefined,
        status: "error",
        error: error as unknown as Error,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
      });
    }
  }
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  parityStore.setState(() => ({ enabled: true }));
  window.__BURROW_PARITY__ = true;
  if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
});

function stubLogFetch(listStatus = 200, fileStatus = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const isFile = url.includes("/files/");
      const status = isFile ? fileStatus : listStatus;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { message: `HTTP ${status} in fixture response` } }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      if (isFile) {
        return new Response(LOG_TEXT, {
          headers: {
            "content-type": "text/plain",
            "x-burrow-log-size": String(LOG_TEXT.length),
            "x-burrow-log-start": "0",
            "x-burrow-log-end": String(LOG_TEXT.length),
            "x-burrow-log-source": "nm",
          },
        });
      }
      return new Response(JSON.stringify({ source: "nm", node: "worker:8041", files: [{ name: "stdout", size: LOG_TEXT.length }] }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

describe("LogsView", () => {
  it("uses zero until file metadata arrives", () => {
    expect(logDownloadSize(null)).toBe(0);
    expect(logDownloadSize(undefined)).toBe(0);
    expect(logDownloadSize({ size: 42 })).toBe(42);
  });

  it("formats API errors and raw log failures", () => {
    expect(logErrorMessage(new Error("request failed"))).toBe("request failed");
    expect(logErrorMessage("raw log failure")).toBe("raw log failure");
  });

  it("renders a byte window, searches it, navigates hits, and jumps to the first error", async () => {
    const { router } = renderLogs();
    const log = await screen.findByRole("log", { name: "Container log" });
    await waitFor(() => expect(log.textContent).toContain("startup complete"));
    expect(screen.getByText("3 lines", { selector: "[data-burrow-log-lines]" })).toBeTruthy();
    expect(screen.getByText("worker:8041")).toBeTruthy();

    const search = screen.getByRole("searchbox", { name: "Search the log" });
    fireEvent.change(search, { target: { value: "ERROR" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("ERROR"));
    await screen.findByText("1 match");
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(search, { key: "Enter", metaKey: true });
    expect(screen.getAllByText("ERROR").some((node) => node.tagName === "MARK")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    fireEvent.click(screen.getByRole("button", { name: "Jump to first error" }));

    fireEvent.click(screen.getByRole("button", { name: "Show elapsed time since previous timestamp" }));
    await waitFor(() => expect(router.state.location.search.ts).toBe("relative"));
    expect(screen.getByRole("button", { name: "Show elapsed time since previous timestamp" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("chooses stdout when the URL does not name a file", async () => {
    const { router } = renderLogs("", { omitFile: true });
    await screen.findByRole("log", { name: "Container log" });
    await waitFor(() => expect(router.state.location.search.file).toBe("stdout"));
  });

  it("wires the log toolbar controls to URL state and the current file", async () => {
    stubLogFetch();
    const { router } = renderLogs("&q=ERROR");
    await screen.findByRole("log", { name: "Container log" });
    await screen.findByText("1 match");

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    fireEvent.click(screen.getByRole("button", { name: "Regular expression search" }));
    await waitFor(() => expect(router.state.location.search.re).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Regular expression search" }));
    await waitFor(() => expect(router.state.location.search.re).toBeUndefined());
    fireEvent.click(screen.getByRole("button", { name: "Case-sensitive search" }));
    await waitFor(() => expect(router.state.location.search.cs).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Case-sensitive search" }));
    await waitFor(() => expect(router.state.location.search.cs).toBeUndefined());
    fireEvent.click(screen.getByRole("button", { name: "Wrap long lines" }));
    await waitFor(() => expect(router.state.location.search.wrap).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Show elapsed time since previous timestamp" }));
    await waitFor(() => expect(router.state.location.search.ts).toBe("relative"));
    fireEvent.click(screen.getByRole("button", { name: "Show clock time" }));
    await waitFor(() => expect(router.state.location.search.ts).toBeUndefined());

    fireEvent.change(screen.getByRole("searchbox", { name: "Search the log" }), { target: { value: "" } });
    await waitFor(() => expect(router.state.location.search.q).toBeUndefined());

    const filter = screen.getByRole("combobox", { name: "Minimum log level" });
    fireEvent.click(filter);
    const level = await screen.findByRole("option", { name: "ERROR and above" });
    fireEvent.pointerDown(level, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(level, { button: 0, pointerType: "mouse" });
    fireEvent.click(level);
    await waitFor(() => expect(router.state.location.search.filter).toBe("ERROR"));
    fireEvent.click(filter);
    const allLevels = await screen.findByRole("option", { name: "All levels" });
    fireEvent.pointerDown(allLevels, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(allLevels, { button: 0, pointerType: "mouse" });
    fireEvent.click(allLevels);
    await waitFor(() => expect(router.state.location.search.filter).toBeUndefined());

    fireEvent.click(screen.getByRole("button", { name: "Refresh window" }));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    const file = screen.getByRole("combobox", { name: "Log file" });
    fireEvent.click(file);
    const stderr = await screen.findByRole("option", { name: /^stderr/ });
    fireEvent.pointerDown(stderr, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(stderr, { button: 0, pointerType: "mouse" });
    fireEvent.click(stderr);
    await waitFor(() => expect(router.state.location.search.file).toBe("stderr"));
  });

  it("shows a malformed-regex error and keeps an explicit filter in the URL", async () => {
    const { router } = renderLogs("&q=%5B&re=1&filter=WARN&wrap=1");
    const log = await screen.findByRole("log", { name: "Container log" });
    expect(screen.getByRole("searchbox", { name: "Search the log" }).parentElement?.className).toContain("ring-fail");
    expect(router.state.location.search).toMatchObject({ q: "[", re: true, filter: "WARN", wrap: true });
    expect(log.textContent).not.toContain("startup complete");
    expect(log.textContent).toContain("queue is slow");
    expect(log.textContent).toContain("task failed");
  });

  it("shows the container picker when the URL has no container", async () => {
    const { client, router } = renderLogs("", { containerId: null });
    client.setQueryData(q.appAttempts(APP_ID).queryKey, { appAttempts: { appAttempt: [] } });
    const input = await screen.findByRole("textbox", { name: "Container id" });
    fireEvent.change(input, { target: { value: CONTAINER_ID } });
    fireEvent.click(screen.getByRole("button", { name: "Open pasted container" }));
    await waitFor(() => expect(router.state.location.search.container).toBe(CONTAINER_ID));
  });

  it("distinguishes missing log routes from other file-list failures", async () => {
    stubLogFetch(404);
    renderLogs("", { filesError: new ApiError("not found", "http", 404) });
    expect(await screen.findByText(/GET \/api\/logs\/containers/)).toBeTruthy();

    cleanup();
    stubLogFetch(500);
    renderLogs("", { filesError: new Error("file listing failed") });
    expect(await screen.findByRole("heading", { name: "Cannot list this container's log files" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("distinguishes missing byte reads from other read failures", async () => {
    stubLogFetch(200, 404);
    renderLogs("", { windowError: new ApiError("not found", "http", 404) });
    expect(await screen.findByText(/file bytes are not served by this backend/)).toBeTruthy();

    cleanup();
    stubLogFetch(200, 500);
    renderLogs("", { windowError: new Error("window read failed") });
    expect(await screen.findByRole("heading", { name: "Cannot read this log file" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("uses the timer fallback when animation frames are unavailable", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    stubLogFetch();
    renderLogs();
    const log = await screen.findByRole("log", { name: "Container log" });
    await waitFor(() => expect(log.textContent).toContain("startup complete"));
  });

  it("reports when the loaded window has no ERROR or FATAL line", async () => {
    renderLogs("", { logText: "2026-10-31 10:00:00,000 INFO [main] still starting\n" });
    await screen.findByRole("log", { name: "Container log" });
    fireEvent.click(screen.getByRole("button", { name: "Jump to first error" }));
    expect(await screen.findByText("No ERROR/FATAL line in the loaded window")).toBeTruthy();
  });

  it("falls back to a ranged read when the gateway rejects tail requests", async () => {
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        requests.push(url);
        if (url.searchParams.has("tail")) {
          return new Response("tail unsupported", { status: 400, headers: { "content-type": "text/plain" } });
        }
        if (url.pathname.includes("/files/")) {
          return new Response(LOG_TEXT, {
            headers: {
              "content-type": "text/plain",
              "x-burrow-log-size": String(LOG_TEXT.length),
              "x-burrow-log-start": "0",
              "x-burrow-log-end": String(LOG_TEXT.length),
              "x-burrow-log-source": "nm",
            },
          });
        }
        return new Response(JSON.stringify({ source: "nm", node: "worker:8041", files: [{ name: "stdout", size: LOG_TEXT.length }] }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderLogs("&tail=1");
    const log = await screen.findByRole("log", { name: "Container log" });
    await waitFor(() => expect(log.textContent).toContain("startup complete"));
    expect(requests.some((url) => url.searchParams.has("tail"))).toBe(true);
    expect(requests.some((url) => url.searchParams.has("offset") && url.searchParams.has("length"))).toBe(true);
  });

  it("does not invent a range when a tail request fails without a known file size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("tail unsupported", { status: 400, headers: { "content-type": "text/plain" } })),
    );
    renderLogs("&tail=1", { omitFileSize: true });
    expect(await screen.findByRole("heading", { name: "Cannot read this log file" })).toBeTruthy();
  });

  it("shows a download error without losing the loaded log window", async () => {
    stubLogFetch(200, 500);
    renderLogs();
    const viewer = await screen.findByRole("log", { name: "Container log" });
    await waitFor(() => expect(viewer.textContent).toContain("startup complete"));
    fireEvent.click(screen.getByRole("button", { name: "Download stdout" }));
    expect(await screen.findByText(/Download failed: HTTP 500/)).toBeTruthy();
    expect(viewer.textContent).toContain("startup complete");
  });

  it("shows a download transport failure without losing the loaded log window", async () => {
    stubLogFetch();
    const viewer = renderLogs();
    await screen.findByRole("log", { name: "Container log" });
    await waitFor(() => expect(screen.getByRole("log", { name: "Container log" }).textContent).toContain("startup complete"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("download endpoint unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Download stdout" }));
    expect(await screen.findByText(/Download failed: Cannot reach Burrow at \/api\/logs\/containers/)).toBeTruthy();
    expect(viewer.container.textContent).toContain("startup complete");
  });

  it("downloads the loaded log through a temporary object URL", async () => {
    stubLogFetch();
    const createObjectURL = vi.fn(() => "blob:burrow-log");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderLogs();
    const log = await screen.findByRole("log", { name: "Container log" });
    await waitFor(() => expect(log.textContent).toContain("startup complete"));

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download stdout" }));
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:burrow-log");
  });

  it("keeps the current files visible after a refresh error", async () => {
    stubLogFetch();
    const { client } = renderLogs();
    const query = client.getQueryCache().find({ queryKey: lq.files(CONTAINER_ID, { node: null, user: null, app: APP_ID }).queryKey })!;
    query.setState({
      ...query.state,
      status: "error",
      error: new Error("file refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText(/Could not refresh this container's log files/)).toBeTruthy();
    expect(screen.getByRole("log", { name: "Container log" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("keeps a stale byte window visible and shows its raw refresh failure", async () => {
    const { client } = renderLogs();
    const log = await screen.findByRole("log", { name: "Container log" });
    await waitFor(() => expect(log.textContent).toContain("startup complete"));
    const query = client.getQueryCache().find({ queryKey: ["logs", "window", CONTAINER_ID, "stdout", 0, "", "", ""] })!;
    query.setState({
      ...query.state,
      status: "error",
      error: "raw window refresh failure" as unknown as Error,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText(/latest log window could not be loaded.*raw window refresh failure/)).toBeTruthy();
    expect(screen.getByRole("log", { name: "Container log" })).toBeTruthy();
  });

  it("starts live search follow and tears down its refresh timer on unmount", async () => {
    class TestEventSource {
      static instances: TestEventSource[] = [];
      private listeners = new Map<string, Array<(event: Event) => void>>();
      constructor(readonly url: string) {
        TestEventSource.instances.push(this);
      }
      addEventListener(type: string, callback: (event: Event) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
      }
      close() {}
      emit(type: string) {
        for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
      }
    }
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    vi.stubGlobal("EventSource", TestEventSource);
    stubLogFetch();
    const { router, unmount } = renderLogs();
    await screen.findByRole("log", { name: "Container log" });
    const setInterval = vi.fn((callback: TimerHandler, delay?: number) => {
      void callback;
      void delay;
      return 77;
    });
    const clearInterval = vi.fn();
    vi.stubGlobal("setInterval", setInterval);
    vi.stubGlobal("clearInterval", clearInterval);
    fireEvent.click(screen.getByRole("switch", { name: "Follow new log output" }));
    await waitFor(() => expect(router.state.location.search.follow).toBe(true));
    await waitFor(() => expect(TestEventSource.instances.length).toBeGreaterThan(0));
    act(() => TestEventSource.instances[0]!.emit("open"));
    await waitFor(() => expect(document.querySelector('[data-burrow-log-follow="streaming"]')).toBeTruthy());
    const refreshTimer = setInterval.mock.calls.find(([, delay]) => delay === 1_500);
    const refreshCallback = refreshTimer?.[0] as (() => void) | undefined;
    expect(refreshCallback).toBeTypeOf("function");
    if (!refreshCallback) throw new Error("Expected a scheduled log refresh callback");
    act(() => refreshCallback());
    fireEvent.click(screen.getByRole("switch", { name: "Follow new log output" }));
    await waitFor(() => expect(router.state.location.search.follow).toBe(false));
    expect(clearInterval).toHaveBeenCalledWith(77);
    unmount();
  });
});
