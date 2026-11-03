import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CenteredPageState, EmptyState, ErrorState, StaleErrorBanner, TableSkeleton } from "./feedback";

afterEach(cleanup);

describe("shared feedback states", () => {
  it("uses the default table skeleton dimensions", () => {
    render(<TableSkeleton />);
    const skeleton = screen.getByRole("status", { name: "Loading" });
    expect(skeleton.children).toHaveLength(10);
    expect(skeleton.firstElementChild?.children).toHaveLength(7);
  });

  it("stringifies non-Error stale failures and keeps the retry action", () => {
    const retry = vi.fn();
    render(<StaleErrorBanner title="Refresh failed" error={{ message: "offline" }} onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("[object Object]");
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("renders centered empty states in spacious and compact layouts", () => {
    const view = render(
      <CenteredPageState className="centered-test">
        <EmptyState title="No results" icon={<span>empty icon</span>} action={<button type="button">Reset filters</button>}>
          Change the search terms.
        </EmptyState>
      </CenteredPageState>,
    );
    expect(view.container.textContent).toContain("Change the search terms.");
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeTruthy();

    view.rerender(
      <EmptyState title="Nothing selected" compact action={<button type="button">Continue</button>}>
        Pick an item to continue.
      </EmptyState>,
    );
    expect(screen.getByRole("status").className).toContain("w-fit");
    expect(view.container.textContent).toContain("Pick an item to continue.");
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("renders detailed errors and omits optional error content when absent", () => {
    const retry = vi.fn();
    const view = render(
      <ErrorState
        title="Load failed"
        message="The service is unavailable"
        hint="Try again shortly"
        detail="request id 42"
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("request id 42");
    expect(screen.getByText("Technical details")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(retry).toHaveBeenCalledOnce();

    view.rerender(<ErrorState title="Quiet failure" hint="Background refresh is paused" compact />);
    expect(screen.getByRole("alert").textContent).toContain("Quiet failure");
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.getByText("Background refresh is paused")).toBeTruthy();
  });

  it("uses an Error message for stale refresh failures", () => {
    render(<StaleErrorBanner title="Refresh failed" error={new Error("network down")} />);
    expect(screen.getByRole("alert").textContent).toContain("network down");
  });
});
