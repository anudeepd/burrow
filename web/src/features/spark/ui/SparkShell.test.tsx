import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return { ...actual, apiGet: vi.fn().mockRejectedValue(new Error("offline")) };
});

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { SparkShell } = await import("./SparkShell");
const { sp } = await import("../data/queries");
const { sparkSearch } = await import("../data/search");

const APP_ID = "application_1791010984040_0033";
const application = {
  id: APP_ID,
  name: "word count stream",
  attempts: [
    {
      attemptId: "1",
      startTime: "2026-10-03T07:13:47.313GMT",
      endTime: "1969-12-31T23:59:59.999GMT",
      lastUpdated: "2026-10-03T07:13:47.313GMT",
      sparkUser: "alice",
      appSparkVersion: "3.5.9",
    },
    {
      attemptId: "2",
      startTime: "2026-10-04T08:00:00.000GMT",
      endTime: "1969-12-31T23:59:59.999GMT",
      lastUpdated: "2026-10-04T08:00:00.000GMT",
      sparkUser: "bob",
      appSparkVersion: "4.0.0",
    },
  ],
};

function renderShell(search = "", mode: "live-proxy" | "history" | "none" = "live-proxy") {
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, path: "/apps/$appId" });
  const spark = createRoute({ getParentRoute: () => app, path: "spark" });
  const page = (path: string) =>
    createRoute({
      getParentRoute: () => spark,
      path,
      validateSearch: sparkSearch,
      component: () => <SparkShell appId={APP_ID}><p>Page content</p></SparkShell>,
    });
  const pages = ["jobs", "stages", "executors", "storage", "environment", "sql", "streaming", "timeline"].map(page);
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([spark.addChildren(pages)])]),
    history: createMemoryHistory({ initialEntries: [`/apps/${APP_ID}/spark/jobs${search}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(sp.source(APP_ID, new URLSearchParams(search).get("attempt")).queryKey, {
    mode,
    ...(mode === "none" ? {} : { baseUrl: mode === "history" ? "http://history:18080" : "http://driver:4040" }),
    sparkAppId: mode === "history" ? APP_ID : "local-1791011628127",
    available: mode !== "none",
    attempt: "2",
  });
  client.setQueryData(sp.application(APP_ID, mode === "history" ? "static" : "live").queryKey, application);
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

afterEach(() => cleanup());

describe("SparkShell", () => {
  it("shows resolved application/source details, selects the resolved attempt, and builds page navigation", async () => {
    const view = renderShell();

    expect(await screen.findByRole("heading", { name: "word count stream" })).toBeTruthy();
    expect(screen.getByText("Live driver web proxy")).toBeTruthy();
    expect(screen.getByText("http://driver:4040")).toBeTruthy();
    expect(view.container.textContent).toContain("4.0.0");
    expect(view.container.textContent).toContain("bob");
    expect(screen.getByText("Page content")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Spark pages" }).querySelectorAll("a")).toHaveLength(8);
    expect(screen.getByRole("link", { name: "Jobs" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("uses history data and falls back to the source attempt for an invalid link", async () => {
    renderShell("?attempt=invalid", "history");
    expect(await screen.findByRole("heading", { name: "word count stream" })).toBeTruthy();
    expect(screen.getByText("Spark History Server")).toBeTruthy();
    expect(screen.getByText("History")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Application attempt" }).textContent).toContain("Attempt 2");
  });

  it("builds each page prefetch key and follows tabs whose data is already cached", async () => {
    const { client } = renderShell();
    await screen.findByRole("heading", { name: "word count stream" });
    const cached = [
      sp.jobs(APP_ID, { kind: "live", attempt: null }),
      sp.stages(APP_ID, { kind: "live", attempt: null }),
      sp.executors(APP_ID, "live", null),
      sp.rdds(APP_ID, "live", null),
      sp.environment(APP_ID, null),
      sp.sql(APP_ID, { kind: "live", attempt: null }),
      sp.streamingStatistics(APP_ID, "live", null),
      sp.allExecutors(APP_ID, "static", null),
    ];
    for (const query of cached) client.setQueryData(query.queryKey, []);

    for (const label of ["Stages", "Executors", "Storage", "Environment", "SQL", "Streaming", "Timeline", "Jobs"]) {
      fireEvent.click(screen.getByRole("link", { name: label }));
      await waitFor(() => expect(screen.getByRole("link", { name: label }).getAttribute("aria-current")).toBe("page"));
    }
  });

  it("shows an unavailable source without a URL and selects an explicit valid attempt", async () => {
    const { container } = renderShell("?attempt=1", "none");
    expect(await screen.findByRole("heading", { name: "word count stream" })).toBeTruthy();
    expect(screen.getByText("No source")).toBeTruthy();
    expect(screen.queryByText("http://driver:4040")).toBeNull();
    expect(container.textContent).toContain("3.5.9");
    expect(container.textContent).toContain("alice");
  });

  it("prefetches missing page data, shows the pending tab, and navigates after a failed prefetch settles", async () => {
    renderShell();
    await screen.findByRole("heading", { name: "word count stream" });
    fireEvent.click(screen.getByRole("link", { name: "Stages" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Stages" }).getAttribute("aria-current")).toBe("page"));
  });

});
