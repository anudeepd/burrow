import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node } from "~/api/schemas";
import type { NmContainer } from "~/api/queries/nodes";

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { nq } = await import("~/api/queries/nodes");
const { NodeLocalLogs } = await import("./NodeLocalLogs");

const ADDRESS = "worker.example:8042";
const CONTAINER: NmContainer = {
  id: "container_1791010000001_0009_01_000001",
  nodeId: "worker.example:8041",
  state: "RUNNING",
  exitCode: 0,
  user: "alice",
  totalMemoryNeededMB: 1024,
  totalVCoresNeeded: 1,
};
const NODE = { id: "worker.example:8041", nodeHTTPAddress: ADDRESS } as Node;
const sourceKey = (containerId = CONTAINER.id) => ["logs", "containers", containerId, ADDRESS] as const;
const SOURCE = { source: "node-local", node: null, files: [] };

function renderLogs({ address = ADDRESS, containers }: { address?: string; containers?: NmContainer[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  if (containers !== undefined) client.setQueryData(nq.nmContainers(address).queryKey, containers);
  const view = render(
    <QueryClientProvider client={client}>
      <NodeLocalLogs node={{ ...NODE, nodeHTTPAddress: address }} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function failQuery(client: InstanceType<typeof QueryClient>, key: readonly unknown[], error: string, clearData = false) {
  const query = client.getQueryCache().find({ queryKey: key })!;
  query.setState({
    ...query.state,
    ...(clearData ? { data: undefined } : {}),
    status: "error",
    error: new Error(error),
    errorUpdatedAt: Date.now(),
    errorUpdateCount: query.state.errorUpdateCount + 1,
    fetchStatus: "idle",
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NodeLocalLogs", () => {
  it("explains missing addresses and loading container metadata", () => {
    const missingAddress = renderLogs({ address: "" });
    expect(screen.getByText("No NodeManager address")).toBeTruthy();
    missingAddress.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const pending = renderLogs();
    expect(pending.container.querySelector(".h-16")).toBeTruthy();
  });

  it("shows stale and fatal container-list errors, empty results, and retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const stale = renderLogs({ containers: [] });
    failQuery(stale.client, nq.nmContainers(ADDRESS).queryKey, "container refresh failed");
    expect(await screen.findByText("Could not refresh this node's containers")).toBeTruthy();
    expect(screen.getByText("No container on this node")).toBeTruthy();
    for (const retry of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(retry);
    stale.unmount();

    const fatal = renderLogs({ containers: [] });
    failQuery(fatal.client, nq.nmContainers(ADDRESS).queryKey, "containers unavailable", true);
    expect(await screen.findByRole("heading", { name: "Cannot read this node's containers" })).toBeTruthy();
    for (const retry of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(retry);
  });

  it("reports failed log probes and preserves cached log files during refresh errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const fatal = renderLogs({ containers: [CONTAINER] });
    fatal.client.setQueryData(sourceKey(), SOURCE);
    failQuery(fatal.client, sourceKey(), "log source unavailable", true);
    expect(await screen.findByRole("heading", { name: "Could not check NodeManager logs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    fatal.unmount();

    const stale = renderLogs({ containers: [CONTAINER] });
    stale.client.setQueryData(sourceKey(), {
      source: "node-local",
      node: "proxy.example:8042",
      files: [{ name: "stdout", size: 12, lastModified: 1_800_000_000_000 }],
    });
    failQuery(stale.client, nq.nmContainers(ADDRESS).queryKey, "container refresh failed");
    failQuery(stale.client, sourceKey(), "log refresh failed");
    expect(await screen.findByText("Could not refresh this node's containers")).toBeTruthy();
    expect(screen.getByText("Could not refresh NodeManager logs")).toBeTruthy();
    expect(screen.getByText("stdout")).toBeTruthy();
    expect(screen.getByRole("link", { name: "open" }).getAttribute("href")).toContain("stdout?node=worker.example%3A8042");
    for (const retry of screen.getAllByRole("button", { name: "Retry now" })) fireEvent.click(retry);
  });

  it("shows an empty log listing returned by the NodeManager", async () => {
    const view = renderLogs({ containers: [CONTAINER] });
    view.client.setQueryData(sourceKey(), SOURCE);
    expect(await screen.findByText("The source reported no files yet.")).toBeTruthy();
    expect(screen.getByText(/Total 0 file\(s\)/)).toBeTruthy();
  });
});
