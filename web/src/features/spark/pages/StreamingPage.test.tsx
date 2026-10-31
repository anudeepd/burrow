import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import type {
  SparkStreamingBatch,
  SparkStreamingReceiver,
  SparkStreamingStatistics,
} from "../data/schemas";

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { StreamingPage } = await import("./StreamingPage");
const { SparkProvider } = await import("../ui/context");
const { sp } = await import("../data/queries");
const { sparkSearch } = await import("../data/search");
const { ApiError } = await import("~/api/client");

const APP_ID = "application_1791010984040_0033";
const FIXTURE = resolve(process.cwd(), "../fixtures/spark/3.5.9/dstream/rest");
const stats = JSON.parse(readFileSync(`${FIXTURE}/final.streaming.statistics.json`, "utf8")) as SparkStreamingStatistics;
const batches = JSON.parse(readFileSync(`${FIXTURE}/final.streaming.batches.json`, "utf8")) as SparkStreamingBatch[];
const receivers = JSON.parse(readFileSync(`${FIXTURE}/final.streaming.receivers.json`, "utf8")) as SparkStreamingReceiver[];

function renderStreamingPage(search = "", configure?: (client: QueryClientType) => void) {
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, path: "/apps/$appId" });
  const spark = createRoute({ getParentRoute: () => app, path: "spark" });
  const streaming = createRoute({
    getParentRoute: () => spark,
    path: "streaming",
    validateSearch: sparkSearch,
    component: () => <StreamingPage />,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([spark.addChildren([streaming])])]),
    history: createMemoryHistory({ initialEntries: [`/apps/${APP_ID}/spark/streaming${search}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, refetchOnMount: false } } });
  client.setQueryData(sp.streamingStatistics(APP_ID, "static", null).queryKey, stats);
  client.setQueryData(sp.streamingBatches(APP_ID, "static", null).queryKey, batches);
  client.setQueryData(sp.streamingReceivers(APP_ID, "static", null).queryKey, receivers);
  configure?.(client);
  const view = render(
    <QueryClientProvider client={client}>
      <SparkProvider
        value={{ appId: APP_ID, kind: "static", sparkAppId: APP_ID, attempt: null, source: null, application: null, resolving: false }}
      >
        <RouterProvider router={router} />
      </SparkProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

afterEach(() => cleanup());

describe("StreamingPage", () => {
  it("renders captured batch metrics and receivers, then applies status and batch-window URL filters", async () => {
    const { router } = renderStreamingPage("?status=COMPLETED&size=5");

    await screen.findByText("Statistics over time");
    expect(screen.getByText("Batches")).toBeTruthy();
    expect(screen.getByText("Receivers")).toBeTruthy();
    expect(document.querySelector('[data-yf="spark.streaming.numTotalCompletedBatches"]')?.textContent).toBe("16");
    expect(screen.getByText("Queue stream [0]")).toBeTruthy();
    expect(screen.getByText("1 of 5 shown")).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ status: "COMPLETED", size: "5" });

    const newest = screen.getByRole("spinbutton", { name: "How many of the newest batches to load" });
    fireEvent.change(newest, { target: { value: "2" } });
    await waitFor(() => expect(router.state.location.search.size).toBe("2"));
    fireEvent.blur(newest);
    expect((newest as HTMLInputElement).value).toBe("2");
  });

  it("distinguishes a non-streaming application from a missing Spark backend", async () => {
    const markStatsError = (client: QueryClientType, error: Error) => {
      const query = client.getQueryCache().find({ queryKey: sp.streamingStatistics(APP_ID, "static", null).queryKey })!;
      query.setState({
        ...query.state,
        data: undefined,
        status: "error",
        error,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
      });
    };

    const notStreaming = renderStreamingPage("", (client) =>
      markStatsError(client, new ApiError("No streaming listener for this application", "http", 404, "not_found")),
    );
    expect(await screen.findByText("Not a streaming application")).toBeTruthy();
    notStreaming.unmount();

    renderStreamingPage("", (client) => markStatsError(client, new ApiError("unknown API group '/api/spark'", "http", 404, "not_found")));
    expect(await screen.findByText(/This Burrow binary has no/)).toBeTruthy();
  });

  it("keeps captured statistics under stale errors and renders batch and receiver failures", async () => {
    const refreshError = new Error("refresh failed");
    const { client } = renderStreamingPage();
    const stats = client.getQueryCache().find({ queryKey: sp.streamingStatistics(APP_ID, "static", null).queryKey })!;
    const batchesQuery = client.getQueryCache().find({ queryKey: sp.streamingBatches(APP_ID, "static", null).queryKey })!;
    const receiversQuery = client.getQueryCache().find({ queryKey: sp.streamingReceivers(APP_ID, "static", null).queryKey })!;
    for (const query of [stats, batchesQuery, receiversQuery]) {
      query.setState({
        ...query.state,
        status: "error",
        error: refreshError,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
      });
    }
    expect(await screen.findByText(/Could not refresh the streaming statistics/)).toBeTruthy();
    expect(screen.getByText(/Could not refresh the streaming batches/)).toBeTruthy();
    expect(screen.getByText(/Could not refresh the streaming receivers/)).toBeTruthy();
  });

  it("renders optional receiver details and the legacy last-error fallback", async () => {
    const detailReceivers: SparkStreamingReceiver[] = [
      {
        ...receivers[0]!,
        streamId: 1,
        streamName: "active receiver",
        avgEventRate: 12,
        isActive: true,
        executorId: "executor-1",
        executorHost: "worker-1:8041",
        schedulerDelay: 25,
        lastErrorTime: "2026-10-03T12:00:00.000GMT",
        lastErrorMessage: "connection reset",
      },
      {
        ...receivers[0]!,
        streamId: 2,
        streamName: "inactive receiver",
        isActive: false,
        executorId: "",
        executorHost: "worker-2:8041",
        lastErrorTime: null,
        lastErrorMessage: null,
        lastError: "legacy receiver failure",
      },
    ];
    renderStreamingPage("", (client) => {
      client.setQueryData(sp.streamingReceivers(APP_ID, "static", null).queryKey, detailReceivers);
    });

    const table = await screen.findByRole("table", { name: "Streaming receivers" });
    const headers = [...table.querySelectorAll('[role="columnheader"]')].map((element) => element.textContent);
    for (const header of ["Active", "Executor", "Scheduler delay", "Last error"]) expect(headers.join(" ")).toContain(header);
    expect(table.textContent).toContain("active receiver");
    expect(table.textContent).toContain("Active");
    expect(table.textContent).toContain("Inactive");
    expect(table.textContent).toContain("executor-1");
    expect(table.textContent).toContain("worker-2:8041");
    expect(table.textContent).toContain("connection reset");
    expect(table.textContent).toContain("legacy receiver failure");
  });

  it("keeps the complete receiver schema visible when Spark reports no receivers", async () => {
    renderStreamingPage("", (client) => {
      client.setQueryData(sp.streamingReceivers(APP_ID, "static", null).queryKey, []);
    });

    const table = await screen.findByRole("table", { name: "Streaming receivers" });
    expect(table.querySelector('[data-col="executor"]')).not.toBeNull();
    expect(table.querySelector('[data-col="receiverSchedulerDelay"]')).not.toBeNull();
    expect(table.querySelector('[data-col="lastError"]')).not.toBeNull();
    expect(await screen.findByText("No receivers")).toBeTruthy();
  });

  it("uses an idle tone for unknown batch statuses and keeps the newest unfinished marker", async () => {
    const unusualBatches: SparkStreamingBatch[] = [
      { ...batches[0]!, batchId: 501, batchTime: null, status: "PAUSED" },
      { ...batches[1]!, batchId: 500, batchTime: "not a timestamp", status: null },
    ];
    renderStreamingPage("?status=PAUSED&size=1", (client) => {
      client.setQueryData(sp.streamingBatches(APP_ID, "static", null).queryKey, unusualBatches);
    });

    const table = await screen.findByRole("table", { name: "Streaming batches" });
    expect(table.textContent).toContain("PAUSED");
    expect(table.querySelector(".burrow-tone-idle")).not.toBeNull();
    expect(table.querySelector(".burrow-dot-pulse")).not.toBeNull();
    expect(screen.getByText("1 shown")).toBeTruthy();
  });

  it("shows first-load errors in both the charts and the affected table", async () => {
    const failWithoutData = (client: QueryClientType, queryKey: readonly unknown[], error: Error) => {
      const query = client.getQueryCache().find({ queryKey })!;
      query.setState({
        ...query.state,
        data: undefined,
        status: "error",
        error,
        errorUpdatedAt: Date.now(),
        errorUpdateCount: query.state.errorUpdateCount + 1,
      });
    };
    renderStreamingPage("", (client) => {
      failWithoutData(client, sp.streamingBatches(APP_ID, "static", null).queryKey, new Error("batch read failed"));
      failWithoutData(client, sp.streamingReceivers(APP_ID, "static", null).queryKey, new Error("receiver read failed"));
    });

    expect((await screen.findAllByText("batch read failed")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("receiver read failed")).length).toBeGreaterThan(0);
  });
});
