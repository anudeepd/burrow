import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RetryRow, SparkSection } from "./StateViews";

afterEach(cleanup);

describe("Spark section states", () => {
  it("renders loading, error, empty and successful content within its section", () => {
    const { rerender } = render(
      <SparkSection title="Tasks" loading subject="tasks">
        loaded tasks
      </SparkSection>,
    );
    expect(screen.getByRole("region", { name: "Tasks" }).querySelector('[aria-busy="true"]')).toBeTruthy();

    rerender(
      <SparkSection title="Tasks" error={new Error("tasks unavailable")} subject="tasks">
        loaded tasks
      </SparkSection>,
    );
    expect(screen.getAllByText("tasks unavailable").length).toBeGreaterThan(0);

    rerender(<SparkSection title="Tasks" subject="tasks" empty={<span>no tasks</span>} />);
    expect(screen.getByText("no tasks")).toBeTruthy();

    rerender(
      <SparkSection title="Tasks" subject="tasks">
        loaded tasks
      </SparkSection>,
    );
    expect(screen.getByText("loaded tasks")).toBeTruthy();
  });

  it("runs the inline retry action", () => {
    const onRetry = vi.fn();
    render(<RetryRow onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
