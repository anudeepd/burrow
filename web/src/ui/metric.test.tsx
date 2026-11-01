import { afterEach, describe, expect, it } from "vitest";
import { Metric } from "./metric";

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
      </>,
    );

    expect(screen.getByText("2 KiB")).toBeTruthy();
    expect(screen.getByText("50.0%")).toBeTruthy();
    expect(container.querySelector('[data-yf="test.count"]')?.textContent).toBe("1,234");
    expect(container.querySelector('[data-yf="test.id"]')?.textContent).toBe("1234");
  });
});
