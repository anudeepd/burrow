import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfResponse } from "~/api/schemas";

window.__BURROW_PARITY__ = true;

vi.mock("./logs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./logs")>()),
  fetchLogChunk: vi.fn(async () => ({
    text: "INFO startup\nERROR task failed\nERROR second failure\nINFO shutdown\n",
    size: 64,
    start: 0,
    end: 64,
    source: "rm",
    derived: false,
  })),
}));

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { tq } = await import("~/api/queries/tools");
const { RmLogsSchema } = await import("~/api/queries/tools");
const { ApiError } = await import("~/api/client");
const { ConfView } = await import("./ConfView");
const { LogsView } = await import("./LogsView");
const { fetchLogChunk } = await import("./logs");

const FIXTURE = resolve(process.cwd(), "../fixtures/rm/tools");
const readJson = (name: string) => JSON.parse(readFileSync(`${FIXTURE}/${name}`, "utf8")) as unknown;
const logFiles = RmLogsSchema.parse(readJson("logs.json"));

function renderToolsPage(page: "conf" | "logs", search = "", options: { listingError?: Error } = {}) {
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: `/tools/${page}`,
    component: page === "conf" ? ConfView : LogsView,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/tools/${page}${search}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(tq.conf().queryKey, readJson("conf.json") as ConfResponse);
  if (options.listingError) {
    const status = options.listingError instanceof ApiError ? 404 : 500;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: options.listingError!.message } }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  } else {
    client.setQueryData(tq.logs().queryKey, logFiles);
  }
  client.setQueryData(q.meta().queryKey, {
    name: "Burrow",
    version: "0.1.0",
    now: 1_791_011_000_000,
    readOnly: true,
    rm: { urls: ["http://rm:8088"], active: "http://rm:8088", reachable: true },
    services: { sparkHistory: { configured: false }, jobHistory: { configured: false }, timeline: { configured: false } },
    features: { sparkLive: true, sparkHistory: true, aggregatedLogs: true, nodeLogs: true, events: true, kerberos: false },
    yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
  });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
    client,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("tools pages", () => {
  it("renders configuration summaries, detail, filtering and clear controls", async () => {
    renderToolsPage("conf", "?q=dfs.namenode.avoid.read.slow.datanode");
    expect(await screen.findByRole("table", { name: "Configuration properties" })).toBeTruthy();
    expect(screen.getByText("Properties")).toBeTruthy();
    expect(screen.getByText("Overridden")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search configuration" })).toBeTruthy();
    expect(screen.getAllByText("dfs.namenode.avoid.read.slow.datanode").length).toBeGreaterThan(0);
  });

  it("shows sensitive and final configuration details with their different badges", { timeout: 30_000 }, async () => {
    const { router } = renderToolsPage("conf", "?open=fs.adl.oauth2.access.token.provider.type");
    expect((await screen.findAllByText("Property")).length).toBeGreaterThan(0);
    expect(screen.getByText("redacted by Hadoop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close the property detail" }));
    await waitFor(() => expect((router.state.location.search as { open?: string }).open).toBeUndefined());
    cleanup();

    renderToolsPage("conf", "?open=mapreduce.job.end-notification.max.attempts");
    expect(await screen.findByText("hadoop default")).toBeTruthy();
    expect(screen.getAllByText("final").length).toBeGreaterThan(0);
  });

  it("explains an RM admin property with no view and shows multiline values in detail", { timeout: 30_000 }, async () => {
    const { router } = renderToolsPage("conf", "?open=yarn.resourcemanager.admin.address");
    expect(await screen.findByText(/no Burrow view renders it/)).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("yarn.resourcemanager.admin.address");
    fireEvent.click(screen.getByRole("button", { name: "Close the property detail" }));
    await waitFor(() => expect((router.state.location.search as { open?: string }).open).toBeUndefined());
    cleanup();

    renderToolsPage("conf", "?open=fs.s3a.aws.credentials.provider");
    expect(await screen.findByText("Value as the daemon dumped it")).toBeTruthy();
    expect(screen.getAllByText(/TemporaryAWSCredentialsProvider/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/lines/).length).toBeGreaterThan(0);
  });

  it("reads a selected RM log window and navigates the pager and in-window search", async () => {
    const { router } = renderToolsPage("logs", "?file=rm.out&q=ERROR");
    expect(await screen.findByRole("button", { name: "Jump to the end of the file" })).toBeTruthy();
    await waitFor(() => expect(vi.mocked(fetchLogChunk)).toHaveBeenCalled());
    expect(document.body.textContent).toContain("ERROR task failed");
    expect(document.body.textContent).toContain("1 / 2");
    expect(screen.getByRole("searchbox", { name: "Search inside this window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Jump to the end of the file" })).toBeTruthy();

    const logSearch = screen.getByRole("searchbox", { name: "Search inside this window" });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(logSearch);
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(document.body.textContent).toContain("2 / 2");
    fireEvent.keyDown(logSearch, { key: "Enter" });
    expect(document.body.textContent).toContain("1 / 2");
    fireEvent.keyDown(logSearch, { key: "Enter", shiftKey: true });
    expect(document.body.textContent).toContain("2 / 2");

    const table = screen.getByRole("table", { name: "Log files in the daemon's log directory" });
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(table.querySelector('[aria-sort="descending"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(table.querySelector('[aria-sort="ascending"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Jump to the start of the file" }));
    await waitFor(() => expect((router.state.location.search as { offset?: number }).offset).toBe(0));
  });

  it("follows then stops a log tail, and explains an empty log directory", async () => {
    const { client, router } = renderToolsPage("logs", "?file=rm.out&tail=1");
    const log = await screen.findByRole("log", { name: /rm.out/ });
    expect(log.textContent).toContain("ERROR second failure");
    expect(document.body.textContent).toContain("parity: not following");

    fireEvent.click(screen.getByRole("button", { name: "Follow new bytes to the end of the file" }));
    await waitFor(() => expect((router.state.location.search as { tail?: boolean }).tail).toBeUndefined());

    client.setQueryData(tq.logs().queryKey, []);
    expect(await screen.findByText("No log files")).toBeTruthy();
    expect(screen.getAllByText("No file selected").length).toBeGreaterThan(0);
  });

  it("distinguishes a missing logs endpoint from an ordinary directory failure", async () => {
    renderToolsPage("logs", "", {
      listingError: new ApiError("not found", "http", 404, null, null, null, {
        api: null,
        cache: null,
        upstream: null,
        ageMs: null,
        etag: null,
      }),
    });
    expect(await screen.findByText("This Burrow backend does not expose local logs")).toBeTruthy();
    cleanup();

    renderToolsPage("logs", "", { listingError: new Error("ResourceManager logs failed") });
    expect(await screen.findByRole("heading", { name: "Cannot read the daemon's log directory" })).toBeTruthy();
  });

  it("pages a large daemon log, selects a file, and reports an empty search", async () => {
    const { router } = renderToolsPage("logs", "?file=resourcemanager.log&len=32768&q=not-present");
    expect(await screen.findByRole("log", { name: /resourcemanager.log/ })).toBeTruthy();
    expect(screen.getByText(/searches only the/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect((router.state.location.search as { offset?: number }).offset).toBe(32_768));
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await waitFor(() => expect((router.state.location.search as { offset?: number }).offset).toBe(0));

    fireEvent.click(screen.getByRole("button", { name: "Jump to the end of the file" }));
    await waitFor(() => expect((router.state.location.search as { offset?: number }).offset).toBe(327_680));
    expect((router.state.location.search as { tail?: boolean }).tail).toBeUndefined();
  });

  it("shows the no-file prompt for a URL that names no listed file", async () => {
    renderToolsPage("logs", "?file=missing.log");
    expect(await screen.findByText("Pick a log file on the left to page through it by byte range.")).toBeTruthy();
  });
});
