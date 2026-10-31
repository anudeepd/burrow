/** Page-level coverage for the JMX browser and thread-dump viewer, using captured daemon payloads. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
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
  ],
};
const stacksPayload = readFileSync(resolve(process.cwd(), "../fixtures/rm/tools/stacks.txt"), "utf8");

function renderToolPage(path: "jmx" | "stacks", search = "") {
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
  client.setQueryData(tq.jmx("").queryKey, jmxPayload);
  if (host) client.setQueryData(nq.nmJmx(host).queryKey, jmxPayload);
  client.setQueryData(tq.stacks().queryKey, stacksPayload);
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

afterEach(() => {
  cleanup();
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  parityStore.setState(() => ({ enabled: true }));
  window.__BURROW_PARITY__ = true;
});

describe("JmxView", () => {
  it("renders nested values, follows a deep link, and updates the URL after searching", { timeout: 30_000 }, async () => {
    const { router } = renderToolPage("jmx", "?bean=java.lang%3Atype%3DMemory&attr=HeapMemoryUsage.used");

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
    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear search" }).find((button) => button.textContent?.trim() === "Clear search")!,
    );
    await waitFor(() => expect(router.state.location.search.q).toBeUndefined());
  });

  it("shows the daemon's empty result state", async () => {
    const { client } = renderToolPage("jmx");
    client.setQueryData(tq.jmx("").queryKey, { beans: [] });
    await screen.findByText("This JVM exposes no MBeans");
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
  });
});

describe("StacksView", () => {
  it("filters the captured dump, selects a thread, and expands its frames", { timeout: 30_000 }, async () => {
    const { router } = renderToolPage("stacks", "?thread=2");

    const tree = await screen.findByRole("tree", { name: "Thread dump" });
    await screen.findByRole("heading", { name: "Reference Handler" });
    expect(tree.getAttribute("data-burrow-stacks-rows")).not.toBe("0");
    expect(screen.getByText(/230 threads/)).toBeTruthy();

    const stateFilters = within(screen.getByRole("group", { name: "Thread state filter" }));
    fireEvent.click(stateFilters.getAllByRole("button").find((button) => button.textContent?.trim().startsWith("WAITING"))!);
    await waitFor(() => expect(router.state.location.search.state).toBe("WAITING"));
    expect(screen.getByText(/filtered to WAITING/)).toBeTruthy();
    fireEvent.click(stateFilters.getAllByRole("button").find((button) => button.textContent?.trim().startsWith("All states"))!);
    await waitFor(() => expect(router.state.location.search.state).toBeUndefined());

    fireEvent.change(screen.getByRole("searchbox", { name: "Search threads and frames" }), { target: { value: "Finalizer" } });
    await waitFor(() => expect(router.state.location.search.q).toBe("Finalizer"));
    expect(screen.getByText(/1 of 230 threads match/)).toBeTruthy();
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
  });

  it("shows cached threads under a stale warning, then reports a total read failure", { timeout: 30_000 }, async () => {
    const { client } = renderToolPage("stacks");
    const query = client.getQueryCache().find({ queryKey: tq.stacks().queryKey })!;
    query.setState({
      ...query.state,
      status: "error",
      error: new Error("refresh failed"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText(/Could not refresh the thread dump/)).toBeTruthy();
    expect(screen.getByRole("tree", { name: "Thread dump" })).toBeTruthy();

    query.setState({
      ...query.state,
      data: undefined,
      status: "error",
      error: new Error("stacks unavailable"),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
    expect(await screen.findByText("stacks unavailable")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cannot read the thread dump" })).toBeTruthy();
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
});
