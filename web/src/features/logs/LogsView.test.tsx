import { afterEach, describe, expect, it, vi } from "vitest";

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { LogsView } = await import("./LogsView");
const { lq } = await import("~/api/queries/logs");
const { ApiError } = await import("~/api/client");
const { logsSearchSchema, parseSearch } = await import("./search");

const APP_ID = "application_1_2";
const CONTAINER_ID = "container_1_2_3_4";
const LOG_TEXT = [
  "2026-10-31 10:00:00,000 INFO [main] startup complete",
  "2026-10-31 10:00:01,500 WARN [worker] queue is slow",
  "2026-10-31 10:00:02,000 ERROR [worker] task failed",
].join("\n") + "\n";

function renderLogs(
  search = "",
  options: { containerId?: string | null; filesError?: Error; windowError?: Error; logText?: string } = {},
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
          containerId ? `?container=${encodeURIComponent(containerId)}&file=stdout${search}` : search ? `?${search.replace(/^&/, "")}` : ""
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
        { name: "stdout", size: logText.length, lastModified: null },
      ],
    });
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
        error,
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
  vi.unstubAllGlobals();
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
      return new Response(
        JSON.stringify({ source: "nm", node: "worker:8041", files: [{ name: "stdout", size: LOG_TEXT.length }] }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
}

describe("LogsView", () => {
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
    expect(screen.getAllByText("ERROR").some((node) => node.tagName === "MARK")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    fireEvent.click(screen.getByRole("button", { name: "Jump to first error" }));

    fireEvent.click(screen.getByRole("button", { name: "Show elapsed time since previous timestamp" }));
    await waitFor(() => expect(router.state.location.search.ts).toBe("relative"));
    expect(screen.getByRole("button", { name: "Show elapsed time since previous timestamp" }).getAttribute("aria-pressed")).toBe("true");
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
    renderLogs("", { containerId: null });
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
  });

  it("distinguishes missing log routes from other file-list failures", async () => {
    stubLogFetch(404);
    renderLogs("", { filesError: new ApiError("not found", "http", 404) });
    expect(await screen.findByText(/GET \/api\/logs\/containers/)).toBeTruthy();

    cleanup();
    stubLogFetch(500);
    renderLogs("", { filesError: new Error("file listing failed") });
    expect(await screen.findByRole("heading", { name: "Cannot list this container's log files" })).toBeTruthy();
  });

  it("distinguishes missing byte reads from other read failures", async () => {
    stubLogFetch(200, 404);
    renderLogs("", { windowError: new ApiError("not found", "http", 404) });
    expect(await screen.findByText(/file bytes are not served by this backend/)).toBeTruthy();

    cleanup();
    stubLogFetch(200, 500);
    renderLogs("", { windowError: new Error("window read failed") });
    expect(await screen.findByRole("heading", { name: "Cannot read this log file" })).toBeTruthy();
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

  it("shows a download error without losing the loaded log window", async () => {
    stubLogFetch(200, 500);
    renderLogs();
    const viewer = await screen.findByRole("log", { name: "Container log" });
    await waitFor(() => expect(viewer.textContent).toContain("startup complete"));
    fireEvent.click(screen.getByRole("button", { name: "Download stdout" }));
    expect(await screen.findByText(/Download failed: HTTP 500/)).toBeTruthy();
    expect(viewer.textContent).toContain("startup complete");
  });
});
