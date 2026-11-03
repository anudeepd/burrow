import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfProperty, ConfResponse } from "~/api/schemas";

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

const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { nq } = await import("~/api/queries/nodes");
const { tq } = await import("~/api/queries/tools");
const { RmLogsSchema } = await import("~/api/queries/tools");
const { ApiError } = await import("~/api/client");
const { parityStore } = await import("~/state/parity");
const { prefsStore } = await import("~/state/prefs");
const { ConfView } = await import("./ConfView");
const { LogsView } = await import("./LogsView");
const { fetchLogChunk } = await import("./logs");

const FIXTURE = resolve(process.cwd(), "../fixtures/rm/tools");
const readJson = (name: string) => JSON.parse(readFileSync(`${FIXTURE}/${name}`, "utf8")) as unknown;
const logFiles = RmLogsSchema.parse(readJson("logs.json"));
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function renderToolsPage(
  page: "conf" | "logs",
  search = "",
  options: {
    listingError?: Error;
    confKeys?: string[];
    confProperties?: ConfProperty[];
    noConfData?: boolean;
    confError?: Error;
    nmProperties?: ConfProperty[];
    noNmData?: boolean;
    disableConfQuery?: boolean;
    logsData?: typeof logFiles;
  } = {},
) {
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
  if (options.disableConfQuery) client.setQueryDefaults(tq.conf().queryKey, { enabled: false });
  const conf = readJson("conf.json") as ConfResponse;
  if (!options.noConfData)
    client.setQueryData(tq.conf().queryKey, {
      ...conf,
      properties:
        options.confProperties ??
        (options.confKeys ? conf.properties.filter((property) => options.confKeys?.includes(property.key)) : conf.properties),
    });
  if (options.nmProperties) client.setQueryData(nq.nmConf("127.0.0.2:8042").queryKey, { properties: options.nmProperties });
  else if (!options.noNmData)
    client.setQueryData(
      nq.nmConf("127.0.0.2:8042").queryKey,
      JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/nodes/nm-127.0.0.2_8042-conf.json"), "utf8")) as never,
    );
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
  } else if (options.confError) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: options.confError!.message } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  } else {
    client.setQueryData(tq.logs().queryKey, options.logsData ?? logFiles);
  }
  client.setQueryData(q.meta().queryKey, {
    name: "Burrow",
    version: "0.1.0",
    now: 1_791_011_000_000,
    readOnly: true,
    rm: { urls: ["http://rm:8088"], active: "http://rm:8088", reachable: true },
    services: {
      sparkHistory: {
        configured: true,
        url: "http://history:18080",
        reachable: false,
        candidates: [
          { url: "http://history:18080", reachable: true },
          { url: "http://history-backup:18080", reachable: false, reason: "connection refused" },
        ],
      },
      jobHistory: { configured: false },
      timeline: { configured: false },
    },
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
  window.__BURROW_PARITY__ = true;
  parityStore.setState(() => ({ enabled: true }));
  prefsStore.setState((prefs) => ({ ...prefs, livePaused: false }));
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

describe("tools pages", () => {
  it("retries a failed Burrow capability refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline retry");
      }),
    );
    const { client } = renderToolsPage("conf", "", { confKeys: ["yarn.admin.acl"] });
    await screen.findByRole("table", { name: "Configuration properties" });
    const meta = client.getQueryCache().find({ queryKey: q.meta().queryKey })!;
    act(() => {
      meta.setState({
        ...meta.state,
        status: "error",
        error: new Error("capability refresh failed"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: meta.state.errorUpdateCount + 1,
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByText("capability refresh failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("renders configuration summaries, detail, filtering and clear controls", async () => {
    renderToolsPage("conf", "?q=dfs.namenode.avoid.read.slow.datanode");
    expect(await screen.findByRole("table", { name: "Configuration properties" })).toBeTruthy();
    expect(screen.getByText("Properties")).toBeTruthy();
    expect(screen.getByText("Overridden")).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search configuration" })).toBeTruthy();
    expect(screen.getAllByText("dfs.namenode.avoid.read.slow.datanode").length).toBeGreaterThan(0);
  });

  it("drives the configuration filters, row detail, sorting, and optional columns", { timeout: 30_000 }, async () => {
    const { router } = renderToolsPage("conf", "?q=not-a-real-property", {
      confKeys: ["yarn.admin.acl", "yarn.scheduler.maximum-allocation-mb"],
    });
    await screen.findByRole("table", { name: "Configuration properties" });
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBeUndefined());

    const search = screen.getByRole("searchbox", { name: "Search configuration" });
    fireEvent.change(search, { target: { value: "yarn.admin.acl" } });
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBe("yarn.admin.acl"));
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBeUndefined());
    fireEvent.click(screen.getByRole("button", { name: "Show only overridden properties" }));
    await waitFor(() => expect((router.state.location.search as { overridden?: boolean }).overridden).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Show only overridden properties" }));
    await waitFor(() => expect((router.state.location.search as { overridden?: boolean }).overridden).toBeUndefined());
    fireEvent.click(screen.getByRole("button", { name: "Show only final properties" }));
    await waitFor(() => expect((router.state.location.search as { final?: boolean }).final).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Show only final properties" }));
    await waitFor(() => expect((router.state.location.search as { final?: boolean }).final).toBeUndefined());

    let table = screen.getByRole("table", { name: "Configuration properties" });
    fireEvent.click(screen.getByRole("row", { name: /yarn.admin.acl/ }));
    await waitFor(() => expect((router.state.location.search as { open?: string }).open).toBe("yarn.admin.acl"));
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    table = screen.getByRole("table", { name: "Configuration properties" });
    expect(within(table).getByRole("columnheader", { name: /Used in the UI/ })).toBeTruthy();
    for (const column of ["value", "resource", "final", "used"]) {
      fireEvent.click(screen.getByRole("table", { name: "Configuration properties" }).querySelector(`[data-col="${column}"] button`)!);
      await waitFor(() => expect((router.state.location.search as { sort?: string }).sort).toContain(`${column}:`));
    }
    const schedulerLink = within(table).getAllByRole("link", { name: "Scheduler" })[0]!;
    const openBeforeLink = (router.state.location.search as { open?: string }).open;
    schedulerLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
    schedulerLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect((router.state.location.search as { open?: string }).open).toBe(openBeforeLink);
    fireEvent.click(within(table).getByRole("button", { name: /Property/ }));
    expect((router.state.location.search as { sort?: string }).sort).toBeTruthy();

    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:conf-export");
    const clickAnchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /CSV/ }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /JSON/ }));
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(clickAnchor).toHaveBeenCalledTimes(2);
  });

  it("clears filters from the empty configuration result prompt", async () => {
    const { router } = renderToolsPage("conf", "?q=not-a-real-property");
    await screen.findByRole("table", { name: "Configuration properties" });
    const clearButtons = screen.getAllByRole("button", { name: "Clear filters" });
    expect(clearButtons.length).toBeGreaterThan(1);
    fireEvent.click(clearButtons[clearButtons.length - 1]!);
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBeUndefined());
  });

  it("reads NodeManager configuration for the selected host", async () => {
    renderToolsPage("conf", "?host=127.0.0.2%3A8042&open=yarn.log-aggregation.file-formats");
    expect(await screen.findByRole("heading", { name: /NodeManager 127.0.0.2:8042 configuration/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "ResourceManager configuration" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("Read from the NodeManager.");
  });

  it("changes the configuration source filter from the source selector", { timeout: 30_000 }, async () => {
    const { router } = renderToolsPage("conf");
    await screen.findByRole("table", { name: "Configuration properties" });
    fireEvent.click(screen.getByRole("combobox", { name: "Source filter" }));
    const option = await screen.findByRole("option", { name: /yarn-site.xml/ });
    fireEvent.pointerDown(option, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => expect((router.state.location.search as { resource?: string }).resource).toBe("yarn-site.xml"));
    fireEvent.click(screen.getByRole("combobox", { name: "Source filter" }));
    const allSources = await screen.findByRole("option", { name: /All sources/ });
    fireEvent.pointerDown(allSources, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(allSources, { button: 0, pointerType: "mouse" });
    fireEvent.click(allSources);
    await waitFor(() => expect((router.state.location.search as { resource?: string }).resource).toBeUndefined());
  });

  it("handles an empty configuration response", async () => {
    renderToolsPage("conf", "", { confKeys: [] });
    expect(await screen.findByRole("table", { name: "Configuration properties" })).toBeTruthy();
    expect(screen.getByText("No property matches these filters")).toBeTruthy();
    expect(screen.getByText("0% come from a *-site.xml or code")).toBeTruthy();
    expect(screen.getByText("locked by <final>, cannot be overridden")).toBeTruthy();
  });

  it("renders a missing configuration value with its unknown source", async () => {
    renderToolsPage("conf", "?open=custom.unknown&sort=final:asc", {
      confProperties: [
        { key: "custom.unknown", value: null, isFinal: false },
        { key: "custom.final", value: "configured", isFinal: true, resource: "test-site.xml" },
      ],
    });
    expect(await screen.findByRole("table", { name: "Configuration properties" })).toBeTruthy();
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect(screen.getByText("Value size").parentElement?.textContent).toContain("—");
    expect(screen.getByText("hadoop default")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Configuration properties" });
    fireEvent.click(table.querySelector('[data-col="value"] button')!);
    await waitFor(() => expect(table.querySelector('[data-col="value"] button')).not.toBeNull());
  });

  it("shows an initial configuration failure without cached data", async () => {
    renderToolsPage("conf", "", { noConfData: true, confError: new Error("configuration offline") });
    expect(await screen.findByRole("heading", { name: "Cannot read the ResourceManager configuration" })).toBeTruthy();
    expect(screen.getByText("configuration offline")).toBeTruthy();
    expect(screen.queryByText("Properties")).toBeNull();
  });

  it("closes a property when its selected row is activated again", async () => {
    const { router } = renderToolsPage("conf", "?open=yarn.admin.acl", { confKeys: ["yarn.admin.acl"] });
    await screen.findByRole("table", { name: "Configuration properties" });
    await router.navigate({ search: (prev) => ({ ...prev, open: "yarn.admin.acl" }), replace: true });
    fireEvent.click(screen.getByRole("row", { name: /yarn.admin.acl/ }));
    await waitFor(() => expect((router.state.location.search as { open?: string }).open).toBeUndefined());
  });

  it("returns to the list when a deep link names a missing property", async () => {
    renderToolsPage("conf", "?open=not-a-property", { confKeys: ["yarn.admin.acl"] });
    expect(await screen.findByRole("table", { name: "Configuration properties" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close the property detail" })).toBeNull();
  });

  it("shows the UI destination for a property used by the scheduler", async () => {
    renderToolsPage("conf", "?open=yarn.scheduler.maximum-allocation-mb", {
      confKeys: ["yarn.scheduler.maximum-allocation-mb"],
    });
    expect(await screen.findByRole("table", { name: "Configuration properties" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Scheduler" }).length).toBeGreaterThan(0);
  });

  it("shows both the configuration warning and NodeManager note for a host-only property", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ properties: [{ key: "yarn.resourcemanager.admin.address", value: "rm.example:8141", isFinal: false }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderToolsPage("conf", "?host=127.0.0.2%3A8042&open=yarn.resourcemanager.admin.address", {
      nmProperties: [{ key: "yarn.resourcemanager.admin.address", value: "rm.example:8141", isFinal: false }],
    });
    expect(await screen.findByRole("table", { name: "Configuration properties" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("no Burrow view renders it");
    expect(screen.getByRole("note").textContent).toContain("Read from the NodeManager.");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("uses the NodeManager-specific failure title and hint", async () => {
    renderToolsPage("conf", "?host=127.0.0.2%3A8042", { noNmData: true, confError: new Error("node configuration offline") });
    expect(await screen.findByRole("heading", { name: "Cannot read the NodeManager configuration at 127.0.0.2:8042" })).toBeTruthy();
    expect(screen.getByText("Check that this NodeManager is running and still registered with the ResourceManager.")).toBeTruthy();
  });

  it("stringifies a non-Error configuration failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const { client } = renderToolsPage("conf", "", { noConfData: true, disableConfQuery: true });
    await screen.findByRole("table", { name: "Configuration properties" });
    const query = client.getQueryCache().find({ queryKey: tq.conf().queryKey });
    expect(query).toBeDefined();
    act(() => {
      query?.setState({
        ...query.state,
        error: "raw configuration failure" as unknown as Error,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        status: "error",
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByRole("heading", { name: "Cannot read the ResourceManager configuration" })).toBeTruthy();
    expect(screen.getByText("raw configuration failure")).toBeTruthy();
  });

  it("keeps the configuration table after a failed refresh", async () => {
    const { client } = renderToolsPage("conf", "", { confKeys: ["yarn.admin.acl"] });
    await screen.findByRole("table", { name: "Configuration properties" });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "configuration refresh failed" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(await screen.findByText("Could not refresh configuration")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Configuration properties" })).toBeTruthy();
    expect(screen.getByText("configuration refresh failed")).toBeTruthy();
    expect(client.getQueryData(tq.conf().queryKey)).toBeDefined();
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
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.mocked(fetchLogChunk).mockResolvedValueOnce({
      text: "INFO startup\nERROR task failed\nERROR second failure\nINFO shutdown\n",
      size: 64,
      start: 0,
      end: 64,
      source: "rm",
      derived: true,
    });
    const { router } = renderToolsPage("logs", "?file=rm.out&q=ERROR");
    expect(await screen.findByRole("button", { name: "Jump to the end of the file" })).toBeTruthy();
    await waitFor(() => expect(vi.mocked(fetchLogChunk)).toHaveBeenCalled());
    expect(document.body.textContent).toContain("ERROR task failed");
    expect(document.body.textContent).toContain("1 / 2");
    expect(document.body.textContent).toContain("derived range");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole("searchbox", { name: "Search inside this window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Jump to the end of the file" })).toBeTruthy();

    const logSearch = screen.getByRole("searchbox", { name: "Search inside this window" });
    fireEvent.keyDown(logSearch, { key: "Escape" });
    fireEvent.keyDown(logSearch, { key: "Enter", isComposing: true });
    fireEvent.keyDown(logSearch, { key: "Enter", altKey: true });
    fireEvent.keyDown(logSearch, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(logSearch, { key: "Enter", metaKey: true });
    fireEvent.change(logSearch, { target: { value: "ERROR task" } });
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBe("ERROR task"));
    fireEvent.change(logSearch, { target: { value: "ERROR" } });
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBe("ERROR"));
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(logSearch);
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(document.body.textContent).toContain("2 / 2");
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(document.body.textContent).toContain("1 / 2");
    fireEvent.keyDown(logSearch, { key: "Enter" });
    expect(document.body.textContent).toContain("2 / 2");
    fireEvent.keyDown(logSearch, { key: "Enter", shiftKey: true });
    expect(document.body.textContent).toContain("1 / 2");
    const logBody = screen.getByRole("log").querySelector("div")!;
    const queryMark = vi.spyOn(logBody, "querySelector").mockReturnValueOnce(null);
    fireEvent.change(logSearch, { target: { value: "ERROR second" } });
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBe("ERROR second"));
    expect(queryMark).toHaveBeenCalled();
    fireEvent.change(logSearch, { target: { value: "" } });
    await waitFor(() => expect((router.state.location.search as { q?: string }).q).toBeUndefined());

    const table = screen.getByRole("table", { name: "Log files in the daemon's log directory" });
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(table.querySelector('[aria-sort="descending"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(table.querySelector('[aria-sort="ascending"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Jump to the start of the file" }));
    await waitFor(() => expect((router.state.location.search as { offset?: number }).offset).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "resourcemanager.log" }));
    await waitFor(() => expect((router.state.location.search as { file?: string }).file).toBe("resourcemanager.log"));
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
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("pages a large daemon log, selects a file, and reports an empty search", async () => {
    const { router } = renderToolsPage("logs", "?file=resourcemanager.log&len=32768&q=not-present");
    expect(await screen.findByRole("log", { name: /resourcemanager.log/ })).toBeTruthy();
    expect(screen.getByText(/searches only the/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search inside this window" }), { key: "Enter" });
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

  it("splits daemon date strings and defaults to a directory when no file exists", async () => {
    const customFiles = [
      { name: "comma.log", size: 10, lastModified: null, modifiedText: "Oct 2, 2026 12:34", modifiedSortKey: null, isDir: false },
      { name: "space.log", size: 10, lastModified: null, modifiedText: "Oct 2 12:34", modifiedSortKey: null, isDir: false },
      { name: "plain.log", size: 10, lastModified: null, modifiedText: "unknown", modifiedSortKey: null, isDir: false },
    ];
    renderToolsPage("logs", "?file=plain.log", { logsData: customFiles });
    await screen.findByRole("log", { name: /plain\.log/ });
    expect(screen.getByText("Oct 2,")).toBeTruthy();
    expect(screen.getByText("2026 12:34")).toBeTruthy();
    expect(screen.getByText("Oct 2")).toBeTruthy();
    expect(screen.getByText("12:34")).toBeTruthy();
    expect(document.body.textContent).toContain("unknown");
    cleanup();

    const { router } = renderToolsPage("logs", "", {
      logsData: [{ name: "archive", size: 0, lastModified: null, modifiedText: null, modifiedSortKey: null, isDir: true }],
    });
    await waitFor(() => expect((router.state.location.search as { file?: string }).file).toBe("archive"));
    expect(screen.getByText("Pick a log file on the left to page through it by byte range.")).toBeTruthy();
  });

  it("handles an absent listing in tail mode and a paused tail on a file", async () => {
    window.__BURROW_PARITY__ = false;
    parityStore.setState(() => ({ enabled: false }));
    renderToolsPage("logs", "?tail=1", { logsData: [] });
    expect(await screen.findByText("No log files")).toBeTruthy();
    cleanup();

    prefsStore.setState((prefs) => ({ ...prefs, livePaused: true }));
    renderToolsPage("logs", "?file=rm.out&tail=1");
    await screen.findByRole("log", { name: /rm\.out/ });
    expect(document.body.textContent).toContain("live paused — not following");
  });

  it("selects the newest file by default, follows the tail, and changes the page size", async () => {
    window.__BURROW_PARITY__ = false;
    parityStore.setState(() => ({ enabled: false }));
    const { router, client } = renderToolsPage("logs");
    client.setQueryData(tq.logs().queryKey, [
      ...logFiles,
      { name: "archive", size: 0, lastModified: null, modifiedText: null, modifiedSortKey: null, isDir: true },
    ]);
    const log = await screen.findByRole("log", { name: /resourcemanager\.log/ });
    await waitFor(() => expect((router.state.location.search as { file?: string }).file).toBe("resourcemanager.log"));
    fireEvent.click(screen.getByRole("row", { name: /archive/ }));
    expect((router.state.location.search as { file?: string }).file).toBe("resourcemanager.log");

    fireEvent.click(screen.getByRole("button", { name: "Follow new bytes to the end of the file" }));
    await waitFor(() => expect((router.state.location.search as { tail?: boolean }).tail).toBe(true));
    expect(document.body.textContent).toContain("following every 3s");
    expect(log.scrollTop).toBe(log.scrollHeight);

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(readJson("logs.json")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("combobox", { name: "Bytes per page" }));
    fireEvent.click(await screen.findByRole("option", { name: "128 KiB per page" }));
    await waitFor(() => expect((router.state.location.search as { len?: number }).len).toBe(128 * 1024));
  });

  it("shows a stale listing error after reload and retries a failed log window", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "directory unavailable" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderToolsPage("logs", "?file=rm.out");
    await screen.findByRole("log", { name: /rm\.out/ });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(await screen.findByText("Could not refresh the daemon log directory")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    cleanup();

    vi.mocked(fetchLogChunk).mockRejectedValueOnce("window unavailable" as unknown as Error);
    renderToolsPage("logs", "?file=rm.out");
    expect(await screen.findByRole("heading", { name: "Cannot read rm.out" })).toBeTruthy();
    expect(screen.getByText("window unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(document.body.textContent).toContain("INFO startup"));

    cleanup();
    vi.mocked(fetchLogChunk).mockRejectedValueOnce(new Error("typed window failure"));
    renderToolsPage("logs", "?file=rm.out");
    expect(await screen.findByRole("heading", { name: "Cannot read rm.out" })).toBeTruthy();
    expect(screen.getByText("typed window failure")).toBeTruthy();

    cleanup();
    const stale = renderToolsPage("logs", "?file=rm.out");
    await screen.findByRole("log", { name: /rm\.out/ });
    const chunk = stale.client.getQueryCache().findAll({ queryKey: ["tools", "logs", "chunk", "rm.out"] })[0]!;
    chunk.setState({
      ...chunk.state,
      status: "error",
      error: new Error("chunk refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: chunk.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("Could not refresh rm.out")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("stringifies an unexpected non-Error listing failure", async () => {
    const { client } = renderToolsPage("logs", "?file=rm.out");
    await screen.findByRole("log", { name: /rm\.out/ });
    const query = client.getQueryCache().find({ queryKey: tq.logs().queryKey })!;
    act(() => {
      query.setState({
        ...query.state,
        data: undefined,
        error: "raw listing failure" as unknown as Error,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        status: "error",
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByRole("heading", { name: "Cannot read the daemon's log directory" })).toBeTruthy();
    expect(screen.getByText("raw listing failure")).toBeTruthy();
  });
});
