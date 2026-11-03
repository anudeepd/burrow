import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "~/api/client";
import { InlineNote, RetryRow, SparkEmpty, SparkFailureState, SparkLoading, SparkSection, SparkStaleErrorBanner } from "./StateViews";

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

  it("uses default skeleton dimensions and suppresses retries for a missing backend route", () => {
    const onRetry = vi.fn();
    render(
      <>
        <SparkLoading />
        <SparkStaleErrorBanner
          error={new ApiError("unknown API group '/api/spark'", "http", 404, "not_found")}
          subject="the Spark source"
          onRetry={onRetry}
        />
        <SparkStaleErrorBanner error={new Error("history server timed out")} subject="SQL executions" onRetry={onRetry} />
      </>,
    );

    expect(screen.getByRole("status", { name: "Loading" }).querySelectorAll("[aria-hidden='true']")).toHaveLength(56);
    expect(screen.getAllByRole("alert")[0]?.textContent).toContain("Could not refresh the Spark source");
    expect(screen.getAllByRole("alert")[0]?.querySelector("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry now" })).toBeTruthy();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("renders classified full-page failures, empty content, and both inline note tones", () => {
    const onRetry = vi.fn();
    render(
      <>
        <SparkFailureState
          error={new ApiError("unknown API group '/api/spark'", "http", 404, "not_found")}
          subject="the Spark source"
          onRetry={onRetry}
        />
        <SparkEmpty title="No executions" action={<button type="button">Choose another application</button>}>
          The event log has no SQL executions.
        </SparkEmpty>
        <InlineNote>Task metrics are unavailable.</InlineNote>
        <InlineNote tone="warn">The source returned a partial response.</InlineNote>
      </>,
    );

    expect(screen.getByRole("alert").textContent).toContain("Spark API routes are not implemented");
    expect(screen.getByRole("status").textContent).toContain("The event log has no SQL executions.");
    expect(screen.getByRole("button", { name: "Choose another application" })).toBeTruthy();
    expect(screen.getByText("Task metrics are unavailable.")).toBeTruthy();
    expect(screen.getByText("The source returned a partial response.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
