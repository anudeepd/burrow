/** Page-level coverage for the JMX browser and thread-dump viewer, using captured daemon payloads. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const stackVirtualizer = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    getScrollElement,
  }: {
    count: number;
    estimateSize: (index: number) => number;
    getScrollElement: () => Element | null;
  }) => {
    getScrollElement();
    const items: Array<{ index: number; start: number }> = [];
    let start = 0;
    for (let index = 0; index < count; index += 1) {
      items.push({ index, start });
      start += estimateSize(index);
    }
    return { getVirtualItems: () => items, getTotalSize: () => start, measure: vi.fn(), scrollToIndex: stackVirtualizer.scrollToIndex };
  },
}));

window.__BURROW_PARITY__ = true;

const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { JmxView } = await import("./JmxView");
const { StacksView } = await import("./StacksView");
const { nq } = await import("~/api/queries/nodes");
const { tq } = await import("~/api/queries/tools");
const { parityStore } = await import("~/state/parity");
const { jmxSearchSchema, stacksSearchSchema } = await import("./search");
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

const jmxPayload = {
  beans: [
    {
      name: "java.lang:type=Memory",
      modelerType: "Memory",
      HeapMemoryUsage: { init: 1_048_576, used: 524_288, committed: 1_048_576, max: 2_097_152 },
      Flags: [true, false],
      StartedAtMillis: 1_791_015_558_000,
    },
    { name: "java.lang:type=Memory,name=Secondary", Value: 42 },
    {
      name: "java.lang:type=Runtime,name=",
      modelerType: "Runtime",
      StartTime: 1_791_015_558_000,
      SampleTime: 2_500,
      LongDescription: "A long JMX description that should be available in the value tooltip.",
      EmptyValue: null,
      Nested: { child: { value: 3 } },
      EmptyArray: [],
    },
    { name: "org.example:type=Single", Only: true },
  ],
};
const stacksPayload = readFileSync(resolve(process.cwd(), "../fixtures/rm/tools/stacks.txt"), "utf8");

function renderToolPage(
  path: "jmx" | "stacks",
  search = "",
  options: {
    stacksData?: string;
    noStacksData?: boolean;
    stacksFetching?: boolean;
    stacksError?: unknown;
    noJmxData?: boolean;
    jmxData?: unknown;
    jmxFetching?: boolean;
  } = {},
) {
  const root = createRootRoute();
  const tools = createRoute({ getParentRoute: () => root, path: "/tools" });
  const jmx = createRoute({
    getParentRoute: () => tools,
    path: "jmx",
    validateSearch: jmxSearchSchema,
    component: () => <JmxView />,
  });
  const stacks = createRoute({
    getParentRoute: () => tools,
    path: "stacks",
    validateSearch: stacksSearchSchema,
    component: () => <StacksView />,
  });
  const router = createRouter({
    routeTree: root.addChildren([tools.addChildren([jmx, stacks])]),
    history: createMemoryHistory({ initialEntries: [`/tools/${path}${search}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, refetchOnMount: false } } });
  const host = new URLSearchParams(search.replace(/^\?/, "")).get("host");
  if (!options.noJmxData) client.setQueryData(tq.jmx("").queryKey, (options.jmxData ?? jmxPayload) as never);
  else if (options.jmxFetching) {
    const query = client.getQueryCache().build(client, tq.jmx("") as never);
    query.setState({ ...query.state, data: undefined, status: "pending", fetchStatus: "fetching", dataUpdatedAt: 0 });
  }
  if (host) client.setQueryData(nq.nmJmx(host).queryKey, jmxPayload);
  if (!options.noStacksData) client.setQueryData(tq.stacks().queryKey, options.stacksData ?? stacksPayload);
  else {
    const query = client.getQueryCache().build(client, tq.stacks() as never);
    if (options.stacksFetching) {
      query.setState({ ...query.state, data: undefined, status: "pending", fetchStatus: "fetching", dataUpdatedAt: 0 });
    }
    if (options.stacksError !== undefined) {
      query.setState({
        ...query.state,
        data: undefined,
        error: options.stacksError as Error,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        status: "error",
        fetchStatus: "idle",
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
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  parityStore.setState(() => ({ enabled: true }));
  window.__BURROW_PARITY__ = true;
  stackVirtualizer.scrollToIndex.mockClear();
});

describe("JmxView", () => {
  it("shows a daemon MBean-pattern rejection as one line with technical details", async () => {
    renderToolPage("jmx", "", {
      jmxData: {
        beans: [
          {
            name: "Nope:*",
            result: "ERROR",
            message: "No MBean matching Nope:*\n\tat org.apache.hadoop.jmx.JMXJsonServlet.doGet(JMXJsonServlet.java:1)",
          },
        ],
      },
    });

    expect(await screen.findByRole("heading", { name: "The daemon rejected this MBean pattern" })).toBeTruthy();
    expect(screen.getByText("No MBean matching Nope:*")).toBeTruthy();
    expect(screen.queryByText(/at org\.apache\.hadoop/)).toBeNull();

    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText(/at org\.apache\.hadoop/)).toBeTruthy();
  });

  it("renders nested values, follows a deep link, and updates the URL after searching", { timeout: 30_000 }, async () => {
    const { router, client } = renderToolPage("jmx", "?bean=java.lang%3Atype%3DMemory&attr=HeapMemoryUsage.used");

    const tree = await screen.findByRole("tree", { name: "JMX beans of the ResourceManager" });
    await screen.findByText("Attributes");
    expect(screen.getByText("HeapMemoryUsage")).toBeTruthy();
    expect(screen.getByText("used")).toBeTruthy();
    expect(tree.getAttribute("data-burrow-jmx-rows")).not.toBe("0");

    fireEvent.click(screen.getByRole("button", { name: /Expand all/ }));
    await waitFor(() => expect(screen.getAllByText("512 KiB").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /Contract/ }));
    expect(screen.getByText(/of .* nodes/)).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search attributes and values" }), { target: { value: "Memory" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("Memory"));
    const searchbox = screen.getByRole("searchbox", { name: "Search attributes and values" });
    fireEvent.change(searchbox, { target: { value: "" } });
    await waitFor(() => expect(router.state.location.search.q).toBeUndefined());
    fireEvent.change(searchbox, { target: { value: "Memory" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("Memory"));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear search" }).find((button) => button.textContent?.trim() === "Clear search")!,
    );
    await waitFor(() => expect(router.state.location.search.q).toBeUndefined());

    client.setQueryData(tq.jmx("java.lang:*").queryKey, jmxPayload);
    const pattern = screen.getByRole("combobox", { name: "MBean pattern" });
    fireEvent.click(pattern);
    const javaPattern = await screen.findByRole("option", { name: "java.lang (*)" });
    fireEvent.pointerDown(javaPattern, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(javaPattern, { button: 0, pointerType: "mouse" });
    fireEvent.click(javaPattern);
    await waitFor(() => expect(router.state.location.search.qry).toBe("java.lang:*"));
    fireEvent.click(pattern);
    const allPattern = await screen.findByRole("option", { name: "All beans" });
    fireEvent.pointerDown(allPattern, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(allPattern, { button: 0, pointerType: "mouse" });
    fireEvent.click(allPattern);
    await waitFor(() => expect(router.state.location.search.qry).toBeUndefined());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(jmxPayload), { headers: { "Content-Type": "application/json" } })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  });

  it("shows the daemon's empty result state", async () => {
    const { client } = renderToolPage("jmx");
    client.setQueryData(tq.jmx("").queryKey, { beans: [] });
    await screen.findByText("This JVM exposes no MBeans");
  });

  it("renders an initial pending read and a raw non-Error failure", async () => {
    renderToolPage("jmx", "", { noJmxData: true });
    expect(screen.queryByText("reading…")).toBeNull();
    expect(await screen.findByRole("heading", { name: "JMX" })).toBeTruthy();
    cleanup();

    renderToolPage("jmx", "", { noJmxData: true, jmxFetching: true });
    expect(await screen.findByText("reading…")).toBeTruthy();
    cleanup();

    const failed = renderToolPage("jmx");
    await screen.findByRole("tree", { name: "JMX beans of the ResourceManager" });
    const query = failed.client.getQueryCache().find({ queryKey: tq.jmx("").queryKey })!;
    act(() => {
      query.setState({
        ...query.state,
        data: undefined,
        error: "raw JMX failure" as unknown as Error,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
        status: "error",
        fetchStatus: "idle",
      });
    });
    expect(await screen.findByText("raw JMX failure")).toBeTruthy();
    cleanup();

    const nm = renderToolPage("jmx", "?host=worker%3A8041");
    const nodeQuery = nm.client.getQueryCache().find({ queryKey: nq.nmJmx("worker:8041").queryKey })!;
    nodeQuery.setState({
      ...nodeQuery.state,
      data: undefined,
      error: new Error("NodeManager unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: nodeQuery.state.errorUpdateCount + 1,
      status: "error",
      fetchStatus: "idle",
    });
    expect(await screen.findByText("NodeManager unavailable")).toBeTruthy();
    expect(screen.getByText("Burrow proxies /api/nm/worker:8041/jmx (the node must be in the RM's node list).")).toBeTruthy();
  });

  it("handles missing bean and attribute deep links", async () => {
    const missingAttribute = renderToolPage("jmx", "?bean=java.lang%3Atype%3DMemory&attr=MissingValue");
    const tree = await screen.findByRole("tree", { name: "JMX beans of the ResourceManager" });
    const bean = tree.querySelector<HTMLElement>('[data-burrow-jmx-node="b:java.lang:type=Memory"]');
    expect(bean?.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByText("Select a bean or an attribute to inspect its raw value, its parsed object name and a copy button."),
    ).toBeTruthy();
    missingAttribute.unmount();

    renderToolPage("jmx", "?bean=missing.bean");
    expect(await screen.findByRole("tree", { name: "JMX beans of the ResourceManager" })).toBeTruthy();
    expect(
      screen.getByText("Select a bean or an attribute to inspect its raw value, its parsed object name and a copy button."),
    ).toBeTruthy();
  });

  it("selects a bean and drills from a nested object into a scalar value", async () => {
    const { router } = renderToolPage("jmx");
    const tree = await screen.findByRole("tree", { name: "JMX beans of the ResourceManager" });
    const bean = tree.querySelector('[data-burrow-jmx-node="b:java.lang:type=Memory"]');
    expect(bean).not.toBeNull();
    fireEvent.click(bean!);

    expect(await screen.findByRole("heading", { name: "java.lang:type=Memory" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^HeapMemoryUsage/ }));
    expect(await screen.findByRole("heading", { name: "HeapMemoryUsage" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^committed/ }));
    await waitFor(() => expect(router.state.location.search.attr).toBe("HeapMemoryUsage.committed"));
    expect(screen.getAllByText("1,048,576").length).toBeGreaterThan(0);
    expect(await screen.findByText("Raw JSON")).toBeTruthy();
  });

  it("shows object-name gaps, time hints and nested child values", async () => {
    const runtime = "java.lang:type=Runtime,name=";
    renderToolPage("jmx", `?bean=${encodeURIComponent(runtime)}&attr=SampleTime`);
    expect(await screen.findByRole("heading", { name: "SampleTime" })).toBeTruthy();
    expect(screen.getByText("Duration")).toBeTruthy();
    cleanup();

    renderToolPage("jmx", `?bean=${encodeURIComponent(runtime)}&attr=StartTime`);
    expect(await screen.findByRole("heading", { name: "StartTime" })).toBeTruthy();
    expect(screen.getByText("Time")).toBeTruthy();
    cleanup();

    renderToolPage("jmx", `?bean=${encodeURIComponent(runtime)}`);
    expect(await screen.findByRole("heading", { name: runtime })).toBeTruthy();
    const objectName = screen.getByRole("heading", { name: "Object name" }).closest("section")!;
    expect(objectName.textContent).toContain("name—");
    fireEvent.click(screen.getByRole("button", { name: /Nested/ }));
    expect(await screen.findByRole("heading", { name: "Nested" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /child/ }));
    expect(await screen.findByRole("heading", { name: "Nested.child" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Nested.child" }).closest("aside")?.textContent).toContain("value");
  });

  it("renders non-parity virtual rows and toggles a nested bean without activating the row", async () => {
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    renderToolPage("jmx");
    const tree = await screen.findByRole("tree", { name: "JMX beans of the ResourceManager" });
    const group = tree.querySelector<HTMLElement>('[role="treeitem"][data-kind="group"]')!;
    fireEvent.click(group.querySelector("button")!);
    expect(group.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(group.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("jmx-row-0");
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: " " });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    const bean = tree.querySelector<HTMLElement>('[data-burrow-jmx-node="b:java.lang:type=Memory"]');
    expect(bean).not.toBeNull();
    expect(bean?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(bean!.querySelector("button")!);
    await waitFor(() => expect(bean?.getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getByText("HeapMemoryUsage")).toBeTruthy();
  });

  it("explains a daemon-side pattern error", async () => {
    const { client } = renderToolPage("jmx");
    client.setQueryData(tq.jmx("").queryKey, {
      beans: [{ name: "Hadoop:service=ResourceManager", result: "ERROR", message: "No MBean matched this pattern" }],
    });
    expect(await screen.findByText(/No MBean matched this pattern/)).toBeTruthy();
  });

  it("renders an empty filtered tree when the query has no matches", async () => {
    parityStore.setState(() => ({ enabled: false }));
    renderToolPage("jmx", "?q=nothing-matches-this-value");
    const tree = await screen.findByRole("tree", { name: "JMX beans of the ResourceManager" });
    await waitFor(() => expect(tree.getAttribute("data-burrow-jmx-rows")).toBe("0"));
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    fireEvent.keyDown(tree, { key: " " });
    fireEvent.keyDown(tree, { key: "Enter" });
  });

  it("keeps a matching path open while navigating", async () => {
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    renderToolPage("jmx", "?q=Memory");
    const tree = await screen.findByRole("tree", { name: "JMX beans of the ResourceManager" });
    await waitFor(() => expect(Number(tree.getAttribute("data-burrow-jmx-rows"))).toBeGreaterThan(0));
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
  });

  it("reads a NodeManager MBean list and returns to the ResourceManager", async () => {
    const { router } = renderToolPage("jmx", "?host=worker%3A8041");
    expect(await screen.findByRole("heading", { name: "JMX · NodeManager worker:8041" })).toBeTruthy();
    expect(await screen.findByRole("tree", { name: "JMX beans of the NodeManager worker:8041" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ResourceManager" }));
    await waitFor(() => expect(router.state.location.search.host).toBeUndefined());
    expect(await screen.findByRole("tree", { name: "JMX beans of the ResourceManager" })).toBeTruthy();
  });

  it("selects the active bean and handles tree navigation and toggling keys", async () => {
    const { router } = renderToolPage("jmx");
    HTMLElement.prototype.scrollIntoView = () => {};
    const tree = await screen.findByRole("tree", { name: "JMX beans of the ResourceManager" });
    const rows = () => [...tree.querySelectorAll<HTMLElement>("[role=treeitem]")];
    expect(rows()[0]?.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(tree, { key: "Enter" });
    expect(router.state.location.search.bean).toBeUndefined();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    const beanRow = rows().find((row) => row.getAttribute("data-kind") === "bean")!;
    expect(beanRow).toBeTruthy();
    fireEvent.keyDown(tree, { key: "Enter" });
    await waitFor(() => expect(router.state.location.search.bean).toBe("java.lang:type=Memory"));
    expect(await screen.findByRole("heading", { name: "java.lang:type=Memory" })).toBeTruthy();

    fireEvent.keyDown(tree, { key: " " });
    expect(beanRow.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("jmx-row-0");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("jmx-row-1");
    fireEvent.keyDown(tree, { key: "x" });
    fireEvent.keyDown(beanRow, { key: "Enter" });
    expect(router.state.location.search.bean).toBe("java.lang:type=Memory");
    fireEvent.keyDown(tree, { key: "End" });
    const active = tree.querySelector<HTMLElement>(`#${tree.getAttribute("aria-activedescendant")}`);
    expect(active?.getAttribute("data-kind")).toBe("value");
    fireEvent.keyDown(tree, { key: " " });
  });

  it("keeps loaded beans visible when refresh fails and renders the fatal error when no data exists", async () => {
    const { client } = renderToolPage("jmx");
    const query = client.getQueryCache().find({ queryKey: tq.jmx("").queryKey })!;
    query.setState({
      ...query.state,
      status: "error",
      error: new Error("refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText(/Could not refresh JMX beans/)).toBeTruthy();
    expect(screen.getByRole("tree", { name: "JMX beans of the ResourceManager" })).toBeTruthy();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(jmxPayload), { headers: { "Content-Type": "application/json" } })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(query.state.fetchStatus).toBe("idle"));

    query.setState({
      ...query.state,
      data: undefined,
      status: "error",
      error: new Error("JMX unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("JMX unavailable")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cannot read the JMX beans" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });
});

describe("StacksView", () => {
  it("filters the captured dump, selects a thread, and expands its frames", { timeout: 30_000 }, async () => {
    const { router } = renderToolPage("stacks", "?thread=2");

    const tree = await screen.findByRole("tree", { name: "Thread dump" });
    await screen.findByRole("heading", { name: "Reference Handler" });
    expect(tree.getAttribute("data-burrow-stacks-rows")).not.toBe("0");
    expect(screen.getByText(/230 threads/)).toBeTruthy();

    await act(async () => {
      await router.navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, thread: "3" })) as never, replace: true });
      await router.navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, thread: "2" })) as never, replace: true });
    });

    const stateFilters = within(screen.getByRole("group", { name: "Thread state filter" }));
    fireEvent.click(stateFilters.getAllByRole("button").find((button) => button.textContent?.trim().startsWith("WAITING"))!);
    await waitFor(() => expect(router.state.location.search.state).toBe("WAITING"));
    expect(screen.getByText(/filtered to WAITING/)).toBeTruthy();
    const hiddenThreadFrame = screen.getByRole("heading", { name: "Reference Handler" }).closest("aside")?.querySelector("ol button");
    expect(hiddenThreadFrame).not.toBeNull();
    fireEvent.click(hiddenThreadFrame!);
    fireEvent.click(stateFilters.getAllByRole("button").find((button) => button.textContent?.trim().startsWith("WAITING"))!);
    await waitFor(() => expect(router.state.location.search.state).toBeUndefined());
    fireEvent.click(stateFilters.getAllByRole("button").find((button) => button.textContent?.trim().startsWith("All states"))!);
    await waitFor(() => expect(router.state.location.search.state).toBeUndefined());

    const search = screen.getByRole("searchbox", { name: "Search threads and frames" });
    fireEvent.change(search, { target: { value: "Finalizer" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("Finalizer"));
    expect(screen.getByText(/1 of 230 threads match/)).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(router.state.location.search.q).toBeUndefined());
  });

  it("shows an empty filtered tree when no thread or frame matches", { timeout: 30_000 }, async () => {
    const { router } = renderToolPage("stacks");
    await screen.findByRole("tree", { name: "Thread dump" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search threads and frames" }), {
      target: { value: "no-such-thread-or-frame" },
    });
    await waitFor(() => expect(router.state.location.search.q).toBe("no-such-thread-or-frame"));
    await waitFor(() => expect(screen.getByRole("tree", { name: "Thread dump" }).getAttribute("data-burrow-stacks-rows")).toBe("0"));
    expect(screen.getByText(/0 of 230 threads match/)).toBeTruthy();
    const tree = screen.getByRole("tree", { name: "Thread dump" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "Enter" });
    fireEvent.keyDown(tree, { key: " " });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
  });

  it("shows the pending state and handles an empty daemon dump with a missing selection", async () => {
    renderToolPage("stacks", "", { noStacksData: true, stacksFetching: true });
    expect(await screen.findByText("reading…")).toBeTruthy();
    cleanup();

    renderToolPage("stacks", "?thread=999", { stacksData: "0 active threads\n" });
    expect(await screen.findByText("The daemon returned an empty dump")).toBeTruthy();
  });

  it("renders unknown and absent thread states and a thread with no frames", async () => {
    const payload = [
      "Thread 9 (mystery):",
      "  State: MYSTERY",
      "  Stack:",
      "    example.Mystery.run()",
      "    example.Mystery.helper(Mystery.java)",
      "Thread 10 (empty):",
      "  Blocked count: 0",
      "  Waited count: 0",
    ].join("\n");
    renderToolPage("stacks", "?thread=9", { stacksData: payload });
    expect(await screen.findByRole("heading", { name: "mystery" })).toBeTruthy();
    expect(screen.getAllByText("MYSTERY").length).toBeGreaterThan(0);
    expect(screen.getByText("example.Mystery.run")).toBeTruthy();
    cleanup();

    renderToolPage("stacks", "?thread=10&state=UNKNOWN", { stacksData: payload });
    expect(await screen.findByRole("heading", { name: "empty" })).toBeTruthy();
    expect(screen.getAllByText("UNKNOWN").length).toBeGreaterThan(0);
    expect(screen.getByText("This thread has no stack frames.")).toBeTruthy();
  });

  it("stringifies an unexpected non-Error failure", async () => {
    renderToolPage("stacks", "", { noStacksData: true, stacksError: "raw stack failure" });
    expect(await screen.findByText("raw stack failure")).toBeTruthy();
  });

  it("shows cached threads under a stale warning, then reports a total read failure", { timeout: 30_000 }, async () => {
    const stale = renderToolPage("stacks");
    const query = stale.client.getQueryCache().find({ queryKey: tq.stacks().queryKey })!;
    query.setState({
      ...query.state,
      status: "error",
      error: new Error("refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText(/Could not refresh the thread dump/)).toBeTruthy();
    expect(screen.getByRole("tree", { name: "Thread dump" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    stale.unmount();

    const failed = renderToolPage("stacks");
    const failedQuery = failed.client.getQueryCache().find({ queryKey: tq.stacks().queryKey })!;
    failedQuery.setState({
      ...failedQuery.state,
      data: undefined,
      status: "error",
      error: new Error("stacks unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: failedQuery.state.errorUpdateCount + 1,
      fetchStatus: "idle",
    });
    expect(await screen.findByText("stacks unavailable")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cannot read the thread dump" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });

  it("moves keyboard focus through thread frames and selects a frame from the details pane", { timeout: 30_000 }, async () => {
    renderToolPage("stacks", "?thread=2");
    const tree = await screen.findByRole("tree", { name: "Thread dump" });
    await screen.findByRole("heading", { name: "Reference Handler" });
    const initial = tree.getAttribute("aria-activedescendant");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getAllByRole("treeitem")[0]?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(tree.getAttribute("aria-activedescendant")).not.toBe(initial);
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    fireEvent.keyDown(tree, { key: "Enter" });

    const detail = screen.getByRole("heading", { name: "Reference Handler" }).closest("aside")!;
    const firstFrame = detail.querySelector("ol button");
    expect(firstFrame).not.toBeNull();
    fireEvent.click(firstFrame!);
    expect(tree.getAttribute("aria-activedescendant")).toMatch(/^stacks-row-/);
  });

  it("uses virtual scrolling and tree keys while parity rendering is disabled", { timeout: 30_000 }, async () => {
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    renderToolPage("stacks", "?thread=2");
    const tree = await screen.findByRole("tree", { name: "Thread dump" });
    await screen.findByRole("heading", { name: "Reference Handler" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree.querySelector(`[id="${tree.getAttribute("aria-activedescendant")}"]`)?.getAttribute("data-kind")).toBe("frame");
    fireEvent.keyDown(tree, { key: " " });
    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: " " });
    fireEvent.click(screen.getByRole("button", { name: "Contract" }));
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(tree.querySelector('[role="treeitem"][data-kind="thread"]')?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(tree.querySelector('[role="treeitem"][data-kind="thread"]')?.getAttribute("aria-expanded")).toBe("false");
    const child = tree.querySelector<HTMLElement>("[role=treeitem]")!;
    fireEvent.keyDown(child, { key: "Escape" });
    expect(stackVirtualizer.scrollToIndex).toHaveBeenCalled();
  });

  it("toggles a thread from its disclosure control without selecting the row", { timeout: 30_000 }, async () => {
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    renderToolPage("stacks", "?thread=2");
    const tree = await screen.findByRole("tree", { name: "Thread dump" });
    const thread = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"][data-kind="thread"]')].find((row) =>
      row.textContent?.includes("Reference Handler"),
    );
    expect(thread?.getAttribute("aria-expanded")).toBe("true");
    const disclosure = thread?.querySelector("button");
    expect(disclosure).toBeTruthy();
    fireEvent.click(disclosure!);
    expect(thread?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure!);
    expect(thread?.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(tree, { key: "x" });
    expect(screen.getByRole("heading", { name: "Reference Handler" })).toBeTruthy();
  });

  it("reloads, expands or contracts every thread, and shows its waiting lock", { timeout: 30_000 }, async () => {
    const { router, client } = renderToolPage("stacks", "?thread=2");
    const tree = await screen.findByRole("tree", { name: "Thread dump" });
    const lockedDump = [
      "2 active threads",
      "Thread 2 (Finalizer):",
      "  State: WAITING",
      "  Waiting on java.lang.ref.ReferenceQueue$Lock@73af089d",
      "  Stack:",
      "    java.lang.Object.wait(Native Method)",
      "  Locked ownable synchronizers:",
      "    - <0x0000000000000042> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)",
      "Thread 3 (Worker):",
      "  State: RUNNABLE",
      "  Stack:",
      "    example.Worker.run(Worker.java:1)",
      "",
    ].join("\n");
    client.setQueryData(tq.stacks().queryKey, lockedDump);
    expect(await screen.findByRole("heading", { name: "Finalizer" })).toBeTruthy();
    expect(screen.getByText(/locked <0x0000000000000042>/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    fireEvent.click(screen.getByRole("button", { name: "Contract" }));

    const selected = tree.querySelector<HTMLElement>('[role="treeitem"][data-kind="thread"]');
    expect(selected).not.toBeNull();
    fireEvent.click(selected!);
    await waitFor(() => expect(router.state.location.search.thread).toBe("2"));
  });
});
