import { afterEach, describe, expect, it } from "vitest";
import { Metric } from "./metric";
import { Entity } from "./datum";

const { cleanup, render, screen } = await import("@testing-library/react");

afterEach(() => cleanup());

describe("Metric", () => {
  it("uses the matching formatter for byte, percentage, integer, and identifier values", () => {
    const { container } = render(
      <>
        <Metric label="Bytes" field="test.bytes" raw={2048} fmt="bytes" />
        <Metric label="Utilization" field="test.pct" raw={50} fmt="pct" />
        <Metric label="Count" field="test.count" raw={1234} fmt="int" />
        <Metric label="Application" field="test.id" raw={1234} fmt="id" />
        <Metric label="Megabytes" field="test.mb" raw={2048} fmt="mb" />
        <Metric label="Default integer" field="test.default" raw={42} />
      </>,
    );

    expect(screen.getByText("2 KiB")).toBeTruthy();
    expect(screen.getByText("50.0%")).toBeTruthy();
    expect(container.querySelector('[data-yf="test.count"]')?.textContent).toBe("1,234");
    expect(container.querySelector('[data-yf="test.id"]')?.textContent).toBe("1234");
    expect(screen.getByText("2 GiB")).toBeTruthy();
    expect(container.querySelector('[data-yf="test.default"]')?.textContent).toBe("42");
  });

  it("covers linked cards, composite values, and row trends with optional notes", () => {
    const { container } = render(
      <>
        <Entity id="root">
          <Metric label="Queue" field="queue.state" raw="RUNNING" href="/queues/root" tone="ok" footnote="Live queue">
            <span>Root queue</span>
          </Metric>
        </Entity>
        <Entity id="_">
          <Metric
            label="Capacity"
            field="cluster.capacity"
            raw="custom text"
            layout="row"
            href="/nodes"
            spark={[
              { t: 1, v: 12 },
              { t: 2, v: 15 },
            ]}
            footnote="Across partitions"
            footnoteClassName="test-footnote"
          />
        </Entity>
        <Entity id="trend-test">
          <Metric
            label="Trend card"
            field="metric.trend"
            raw="unknown"
            spark={[
              { t: 1, v: 1 },
              { t: 2, v: 3 },
            ]}
            size="sm"
          />
        </Entity>
      </>,
    );

    expect(screen.getByRole("link", { name: /Queue/ }).getAttribute("href")).toBe("/queues/root");
    expect(screen.getByRole("link", { name: /Capacity/ }).getAttribute("href")).toBe("/nodes");
    expect(container.querySelector('[data-overview-metric-row="true"] .burrow-metric-spark')).not.toBeNull();
    expect(container.querySelector(".test-footnote")?.textContent).toBe("Across partitions");
    expect(screen.getByText("Root queue")).toBeTruthy();
  });
});
