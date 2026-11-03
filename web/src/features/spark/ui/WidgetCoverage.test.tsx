import { afterEach, describe, expect, it } from "vitest";
import type { SparkStage } from "../data/schemas";

const { cleanup, render, screen } = await import("@testing-library/react");
const { PageHeader } = await import("./PageHeader");
const { stagePeakMemoryDistributions } = await import("./StageAggregates");
const { batchTimeOf, ReceiverTrend } = await import("./StreamingCharts");

afterEach(cleanup);

describe("small Spark page widgets", () => {
  it("shows a known title description, handles non-string titles, and hides empty descriptions", () => {
    const view = render(
      <>
        <PageHeader title="Jobs" />
        <PageHeader title={<span>Custom title</span>}>
          <button type="button">Action</button>
        </PageHeader>
        <PageHeader title="Unknown" description="" hideTitle />
      </>,
    );

    expect(screen.getByText("Review Spark jobs, their status, and the stages they coordinate.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Custom title" }).className).toContain("text-h2");
    expect(screen.getByRole("button", { name: "Action" })).toBeTruthy();
    expect(view.container.querySelector("p")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Unknown" }).className).toContain("sr-only");
  });

  it("extracts only peak-memory series Spark actually reported", () => {
    expect(stagePeakMemoryDistributions(undefined)).toEqual([]);
    expect(stagePeakMemoryDistributions({ executorMetricsDistributions: null } as unknown as SparkStage)).toEqual([]);

    const stage = {
      executorMetricsDistributions: {
        quantiles: [0, 0.5, 1],
        peakMemoryMetrics: {
          JVMHeapMemory: [100, 200, 300],
          JVMOffHeapMemory: null,
          OnHeapExecutionMemory: [],
          OffHeapExecutionMemory: [400],
        },
      },
    } as unknown as SparkStage;
    expect(stagePeakMemoryDistributions(stage)).toMatchObject([
      {
        key: "peakMemory.JVMHeapMemory",
        field: "executorMetricsDistributions.peakMemoryMetrics.JVMHeapMemory",
        series: { quantiles: [0, 0.5, 1], values: [100, 200, 300] },
      },
      { key: "peakMemory.OffHeapExecutionMemory", series: { quantiles: [0], values: [400] } },
    ]);

    expect(
      stagePeakMemoryDistributions({
        executorMetricsDistributions: { peakMemoryMetrics: { JVMHeapMemory: [100] } },
      } as unknown as SparkStage),
    ).toEqual([]);
  });

  it("normalizes streaming batch time and filters invalid receiver samples", () => {
    expect(batchTimeOf({ batchTime: "2026-11-03T00:00:00Z", batchId: 1 } as never)).toBe(Date.parse("2026-11-03T00:00:00Z"));
    expect(batchTimeOf({ batchTime: null, batchId: 2 } as never)).toBe(2);
    expect(batchTimeOf({ batchTime: null, batchId: Number.NaN } as never)).toBeNull();

    render(
      <ReceiverTrend
        receiver={
          {
            streamName: null,
            streamId: null,
            eventRates: [
              [null, 1],
              [1, null],
              [Number.NaN, 2],
              [2, Number.POSITIVE_INFINITY],
              [3, 4],
            ],
          } as never
        }
      />,
    );
    expect(screen.getByRole("img", { name: "Event rate of stream ? over 1 samples" })).toBeTruthy();
  });
});
