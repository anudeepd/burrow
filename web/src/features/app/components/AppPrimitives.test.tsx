import { afterEach, describe, expect, it, vi } from "vitest";

const copyTextMock = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
vi.mock("~/lib/copy", () => ({ copyText: copyTextMock }));

const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { q } = await import("~/api/queries");
const { CopyButton, Field, FieldShell, ResourcePair, UnavailableField } = await import("./Field");
const { LogLink } = await import("./LogLink");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  copyTextMock.mockReset();
});

describe("app detail primitives", () => {
  it("renders fields, hints, missing values, and split resources", () => {
    const { container } = render(
      <dl>
        <Field label="User:" field="app.user" raw="alice" hint="Submitted by the app owner" />
        <FieldShell label={<span>custom label</span>} hint="Custom detail">
          custom value
        </FieldShell>
        <UnavailableField label="Unavailable:" field="app.missing" reason="This endpoint omits it." />
        <ResourcePair label="Preempted:" memoryMB={512} vcores={2} memoryField="app.preempted.memory" vcoresField="app.preempted.vcores" />
      </dl>,
    );
    expect(container.querySelector('[data-yf="app.user"][data-yv="alice"]')).toBeTruthy();
    expect(screen.getByText("custom value")).toBeTruthy();
    expect(screen.getByText("not exposed")).toBeTruthy();
    expect(container.querySelector('[data-yf="app.preempted.memory"][data-yv="512"]')).toBeTruthy();
    expect(container.querySelector('[data-yf="app.preempted.vcores"][data-yv="2"]')).toBeTruthy();
  });

  it("copies text, acknowledges success, clears the prior timer, and handles failure", async () => {
    vi.useFakeTimers();
    copyTextMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("clipboard blocked"))
      .mockResolvedValue(true);
    const view = render(<CopyButton text="diagnostics" label="Copy diagnostics" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics to clipboard" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Copied")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics to clipboard" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Copied")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics to clipboard" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Copied")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics to clipboard" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Copied")).toBeNull();

    view.unmount();
    render(<CopyButton text="id" label="Copy application id" iconOnly />);
    fireEvent.click(screen.getByRole("button", { name: "Copy application id to clipboard" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "application id copied" })).toBeTruthy();
  });
});

function renderLogLink(seed?: unknown, error?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, refetchOnMount: false } } });
  if (seed !== undefined) client.setQueryData(q.meta().queryKey, seed as never);
  if (error !== undefined) {
    client.setQueryData(q.meta().queryKey, {} as never);
    const query = client.getQueryCache().find({ queryKey: q.meta().queryKey })!;
    query.setState({
      ...query.state,
      data: undefined,
      status: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });
  }
  const view = render(
    <QueryClientProvider client={client}>
      <LogLink appId="application_1_2" containerId="container_1_2_01_000003" node="worker:8042" user="alice" />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe("LogLink", () => {
  it("links to the log route only when a log source is available", () => {
    renderLogLink({ features: { nodeLogs: false, aggregatedLogs: true } });
    expect(screen.getByRole("link", { name: "Logs" }).getAttribute("href")).toBe(
      "/apps/application_1_2/logs?container=container_1_2_01_000003&node=worker%3A8042&user=alice",
    );
  });

  it("offers retry when feature discovery failed and keeps unsupported links disabled", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const failed = renderLogLink(undefined, new Error("metadata unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Retry checking log support" }));
    failed.unmount();

    const unavailable = renderLogLink({ features: { nodeLogs: false, aggregatedLogs: false } });
    const button = screen.getByRole("button", { name: "Logs (unavailable)" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    unavailable.unmount();
  });
});
