import { afterEach, describe, expect, it } from "vitest";

window.__BURROW_PARITY__ = true;

const { cleanup, fireEvent, render, screen, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { appSparkSource } = await import("../queries");
const { SparkAffordance } = await import("./SparkAffordance");

function renderAffordance({
  appId = "application_1",
  source,
  error,
  rawError = false,
}: {
  appId?: string;
  source?: unknown;
  error?: unknown;
  rawError?: boolean;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, refetchOnMount: false } } });
  if (source) client.setQueryData(appSparkSource(appId).queryKey, source as never);
  if (error) {
    const options = appSparkSource(appId);
    const query = client.getQueryCache().find({ queryKey: options.queryKey }) ?? client.getQueryCache().build(client, options as never);
    query.setState({
      ...query.state,
      status: "error",
      error: rawError ? (error as Error) : error instanceof Error ? error : new Error(String(error)),
      errorUpdatedAt: Date.now(),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
  }
  const view = render(
    <QueryClientProvider client={client}>
      <SparkAffordance appId={appId} />
    </QueryClientProvider>,
  );
  return { ...view, client, appId };
}

afterEach(() => cleanup());

describe("SparkAffordance", () => {
  it("shows a placeholder while Spark source resolution is pending", () => {
    const view = renderAffordance();
    const root = view.container.querySelector('[data-burrow="spark-affordance"]')!;
    expect(root.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it("explains when finished applications have no configured history source", () => {
    renderAffordance({
      source: {
        mode: "none",
        available: false,
        reason: "no Spark History Server is configured",
        hint: null,
      },
    });
    expect(screen.getByText("This application has finished, so its Spark driver UI is no longer available.")).toBeTruthy();
    expect(within(screen.getByRole("status")).getByText(/Configure Burrow with the Spark History Server URL/)).toBeTruthy();
  });

  it("shows the resolver error and retry action when no source data was loaded", () => {
    renderAffordance({ error: "source resolver is offline" });
    const status = screen.getByRole("status");
    expect(within(status).getByText("source resolver is offline")).toBeTruthy();
    fireEvent.click(within(status).getByRole("button", { name: "Retry" }));
  });

  it("keeps resolver hints and cached errors visible when the error is a string", () => {
    renderAffordance({
      source: { mode: "none", available: false, reason: null, hint: "Configure the Spark History Server." },
      error: "refresh failed",
      rawError: true,
    });
    const status = screen.getByRole("status");
    expect(within(status).getByText("no Spark source resolved")).toBeTruthy();
    expect(within(status).getByText("Next: Configure the Spark History Server.")).toBeTruthy();
    expect(within(status).getByText("Refresh failed: refresh failed")).toBeTruthy();
  });

  it("prints an Error object's message when an unavailable cached source has a refresh error", () => {
    renderAffordance({
      source: { mode: "none", available: false, reason: "source not configured", hint: null },
      error: new Error("refresh failed"),
    });
    expect(screen.getByRole("status").textContent).toContain("Refresh failed: refresh failed");
  });

  it("links directly to the live Spark proxy", () => {
    renderAffordance({
      source: { mode: "live-proxy", baseUrl: "http://rm:8088/proxy/app", available: true },
    });
    expect(screen.getByRole("link", { name: "Spark UI" }).getAttribute("href")).toBe("http://rm:8088/proxy/app");
  });

  it("keeps the encoded history link and retry feedback when a source refresh fails", () => {
    renderAffordance({
      appId: "application_1",
      source: {
        mode: "history",
        baseUrl: "http://history:18080/",
        sparkAppId: "app id/1",
        attempt: "attempt 2",
        available: true,
      },
      error: "history refresh failed",
    });
    const history = screen.getByRole("link", { name: "Spark History" });
    expect(history.getAttribute("href")).toBe("http://history:18080/history/app%20id%2F1/attempt%202/jobs/");
    expect(screen.getByText("Spark source refresh failed; showing the last loaded link")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });
});
