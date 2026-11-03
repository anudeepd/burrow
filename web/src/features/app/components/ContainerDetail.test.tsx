import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Container } from "~/api/schemas";

const { cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
const { q } = await import("~/api/queries");
const { ContainerSchema } = await import("~/api/schemas");
const { ContainerDetail } = await import("./ContainerDetail");

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "src/api/schemas/samples/container.json"), "utf8")) as {
  container: unknown;
};
const sample = ContainerSchema.parse(fixture.container);

function renderContainer(container: Container, logsAvailable: boolean) {
  const root = createRootRoute();
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <ContainerDetail
        appId="application_1_0003"
        container={container}
        attemptId="appattempt_1_0003_000001"
        now={container.startedTime + 5_000}
      />
    ),
  });
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/apps/$appId/attempts/$attemptId",
    component: () => null,
  });
  const router = createRouter({ routeTree: root.addChildren([home, detail]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, refetchOnMount: false } } });
  client.setQueryData(q.meta().queryKey, {
    name: "Burrow",
    version: "0.1.0",
    now: 0,
    readOnly: true,
    rm: { urls: [], active: null, reachable: null },
    services: { sparkHistory: { configured: false }, jobHistory: { configured: false }, timeline: { configured: false } },
    features: {
      sparkLive: false,
      sparkHistory: false,
      aggregatedLogs: logsAvailable,
      nodeLogs: logsAvailable,
      events: false,
      kerberos: false,
    },
    yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

afterEach(cleanup);

describe("ContainerDetail", () => {
  it("renders completed container metadata, logs, mapped resources and diagnostics", async () => {
    const container = {
      ...sample,
      finishedTime: sample.startedTime + 60_000,
      elapsedTime: 60_000,
      diagnosticsInfo: "Container diagnostics",
      allocatedResources: { "memory-mb": 1024, vcores: 1, "yarn.io/gpu": 2 },
    };
    renderContainer(container, true);
    expect(await screen.findByText(`Container ${container.containerId}`)).toBeTruthy();
    expect(screen.getByRole("link", { name: "nm1:8042" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Logs" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "NodeManager log URL (raw)" })).toBeTruthy();
    expect(screen.getByText(/yarn.io\/gpu=2/)).toBeTruthy();
    expect(screen.getByText("Container diagnostics")).toBeTruthy();
  });

  it("shows running time and honest fallbacks for missing node, logs, ports, resources and diagnostics", async () => {
    const container = {
      ...sample,
      finishedTime: 0,
      elapsedTime: 0,
      nodeHttpAddress: undefined,
      logUrl: undefined,
      exposedPorts: "",
      allocatedResources: undefined,
      diagnosticsInfo: "",
    };
    renderContainer(container, false);
    expect(await screen.findByText("N/A")).toBeTruthy();
    expect(screen.getByText("{}")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Logs (unavailable)" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "NodeManager log URL (raw)" })).toBeNull();
    expect(screen.queryByText(/Allocated resources \(RM mapped notation\)/)).toBeNull();
  });

  it("normalizes an omitted diagnostics field to the legacy missing value", async () => {
    const container = { ...sample, diagnosticsInfo: undefined };
    renderContainer(container, false);
    expect(await screen.findByText("None")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy diagnostics to clipboard" })).toBeTruthy();
  });
});
