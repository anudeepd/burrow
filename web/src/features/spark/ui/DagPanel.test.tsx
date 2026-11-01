import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkDag, SparkStage } from "../data/schemas";

window.__BURROW_PARITY__ = true;

vi.mock("~/features/dag/react/DagViewLazy", () => ({
  DagViewLazy: ({ ariaLabel, onSelectRdd }: { ariaLabel: string; onSelectRdd?: (rddId: number) => void }) => (
    <div role="img" aria-label={ariaLabel}>
      {onSelectRdd && (
        <button type="button" onClick={() => onSelectRdd(52)}>
          Select RDD 52
        </button>
      )}
    </div>
  ),
}));

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { JobDagPanel, SqlPlanDag, StageDagPanel } = await import("./DagPanel");
const { SparkProvider } = await import("./context");
const { sp } = await import("../data/queries");

const APP_ID = "application_1791010984040_0033";
const dag: SparkDag = {
  kind: "job",
  granularity: "rdd",
  jobId: 12,
  stageId: null,
  attempt: null,
  stages: [
    {
      stageId: 4,
      attempt: 0,
      skipped: false,
      label: "Read input",
      clusters: [],
      nodes: [{ id: 52, name: "Scan", clusterId: null }],
      edges: [],
    },
  ],
  edges: [],
};
const stage = {
  stageId: 4,
  attemptId: 0,
  status: "COMPLETE",
  name: "Read input",
  numTasks: 3,
  numCompleteTasks: 3,
  numCompletedIndices: 3,
} as SparkStage;

function renderPanel(panel: ReactNode, currentDag: SparkDag = dag, seed?: (client: InstanceType<typeof QueryClient>) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } } });
  client.setQueryData(sp.dagJob(APP_ID, 12, null).queryKey, currentDag);
  seed?.(client);
  const view = render(
    <QueryClientProvider client={client}>
      <SparkProvider
        value={{ appId: APP_ID, kind: "static", sparkAppId: APP_ID, attempt: null, source: null, application: null, resolving: false }}
      >
        {panel}
      </SparkProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function failQuery(client: InstanceType<typeof QueryClient>, queryKey: readonly unknown[], error: string, clearData = false) {
  const query = client.getQueryCache().find({ queryKey })!;
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
  vi.restoreAllMocks();
});

describe("Spark job DAG panel", () => {
  it("shows a mobile stage summary, selects a stage, and offers the complete graph", () => {
    const media = {
      matches: true,
      media: "(max-width: 639px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    const onSelectStage = vi.fn();
    const onExpandStagesChange = vi.fn();
    renderPanel(
      <JobDagPanel
        appId={APP_ID}
        jobId={12}
        stages={[stage]}
        selectedStageId={4}
        onSelectStage={onSelectStage}
        onExpandStagesChange={onExpandStagesChange}
      />,
    );

    const stageButton = screen.getByRole("button", { name: "Stage 4, COMPLETE, 3 of 3 tasks" });
    expect(stageButton.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Read input")).toBeTruthy();
    fireEvent.click(stageButton);
    expect(onSelectStage).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByRole("button", { name: "Show full graph" }));
    expect(onExpandStagesChange).toHaveBeenCalledWith(true);
  });

  it("explains an unavailable mobile summary when the stage list is empty", () => {
    const media = {
      matches: true,
      media: "(max-width: 639px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    renderPanel(<JobDagPanel appId={APP_ID} jobId={12} stages={[]} onExpandStagesChange={() => undefined} />);
    expect(screen.getByText("Stage details are unavailable. Show the full graph to explore this job.")).toBeTruthy();
  });

  it("shows the mobile loading summary and the compact graph for an expanded job", () => {
    const media = {
      matches: true,
      media: "(max-width: 639px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } } });
    client.setQueryData(sp.dagJob(APP_ID, 12, null).queryKey, dag);
    render(
      <QueryClientProvider client={client}>
        <SparkProvider
          value={{ appId: APP_ID, kind: "static", sparkAppId: APP_ID, attempt: null, source: null, application: null, resolving: false }}
        >
          <JobDagPanel appId={APP_ID} jobId={12} stages={[]} stagesLoading />
        </SparkProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText("Loading stage summary…")).toBeTruthy();
  });
});

describe("Spark stage and SQL DAG panels", () => {
  it("renders a stage graph and forwards selected RDDs", () => {
    const onSelectRdd = vi.fn();
    renderPanel(<StageDagPanel appId={APP_ID} stageId={4} attemptId={0} stage={stage} onSelectRdd={onSelectRdd} />, dag, (client) =>
      client.setQueryData(sp.dagStage(APP_ID, 4, 0, null).queryKey, dag),
    );
    expect(screen.getByRole("img", { name: "RDD graph of Spark stage 4 attempt 0" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select RDD 52" }));
    expect(onSelectRdd).toHaveBeenCalledWith(52);
  });

  it("explains a stage without an RDD graph and an SQL execution without a plan", () => {
    const emptyDag = { ...dag, stages: [] };
    renderPanel(<StageDagPanel appId={APP_ID} stageId={4} attemptId={0} />, dag, (client) =>
      client.setQueryData(sp.dagStage(APP_ID, 4, 0, null).queryKey, emptyDag),
    );
    expect(screen.getByText(/This stage attempt has no RDD graph/)).toBeTruthy();
    cleanup();
    render(<SqlPlanDag execution={{ id: 22, nodes: [], edges: [] } as never} />);
    expect(screen.getByText(/No plan graph for SQL execution 22/)).toBeTruthy();
  });

  it("shows retryable graph failures and preserves cached graphs after refresh errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("retry failed");
      }),
    );
    const jobFailure = renderPanel(<JobDagPanel appId={APP_ID} jobId={12} />, dag);
    failQuery(jobFailure.client, sp.dagJob(APP_ID, 12, null).queryKey, "job graph unavailable", true);
    expect((await screen.findAllByText("job graph unavailable")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    jobFailure.unmount();
    cleanup();

    const emptyDag = { ...dag, stages: [] };
    const jobEmpty = renderPanel(<JobDagPanel appId={APP_ID} jobId={12} />, emptyDag);
    failQuery(jobEmpty.client, sp.dagJob(APP_ID, 12, null).queryKey, "empty graph refresh failed");
    expect(await screen.findByText(/Could not refresh the RDD graph of job 12/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    jobEmpty.unmount();
    cleanup();

    const jobStale = renderPanel(<JobDagPanel appId={APP_ID} jobId={12} />, dag);
    failQuery(jobStale.client, sp.dagJob(APP_ID, 12, null).queryKey, "graph refresh failed");
    expect(await screen.findByText(/Could not refresh the RDD graph of job 12/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    jobStale.unmount();
    cleanup();

    const stageKey = sp.dagStage(APP_ID, 4, 0, null).queryKey;
    const stageFailure = renderPanel(<StageDagPanel appId={APP_ID} stageId={4} attemptId={0} />, dag, (client) => {
      client.setQueryData(stageKey, dag);
    });
    failQuery(stageFailure.client, stageKey, "stage graph unavailable", true);
    expect((await screen.findAllByText("stage graph unavailable")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    stageFailure.unmount();
    cleanup();

    const stageStale = renderPanel(<StageDagPanel appId={APP_ID} stageId={4} attemptId={0} />, emptyDag, (client) => {
      client.setQueryData(stageKey, emptyDag);
    });
    failQuery(stageStale.client, stageKey, "stage graph refresh failed");
    expect(await screen.findByText(/Could not refresh the RDD graph of stage 4\.0/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    stageStale.unmount();
    cleanup();

    const populatedStage = renderPanel(<StageDagPanel appId={APP_ID} stageId={4} attemptId={0} />, dag, (client) => {
      client.setQueryData(stageKey, dag);
    });
    failQuery(populatedStage.client, stageKey, "populated stage graph refresh failed");
    expect(await screen.findByText(/Could not refresh the RDD graph of stage 4\.0/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  });
});
