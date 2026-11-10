import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CenteredPageState, EmptyState, ErrorState, StaleErrorBanner, TableSkeleton } from "./feedback";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("shared feedback states", () => {
  it("uses the default table skeleton dimensions", () => {
    render(<TableSkeleton />);
    const skeleton = screen.getByRole("status", { name: "Loading" });
    expect(skeleton.children).toHaveLength(10);
    expect(skeleton.firstElementChild?.children).toHaveLength(7);
  });

  it("uses a non-Error object's message for stale failures and keeps the retry action", () => {
    const retry = vi.fn();
    render(<StaleErrorBanner title="Refresh failed" error={{ message: "offline" }} onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("offline");
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
    expect(screen.queryByText("request id 42")).toBeNull();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("request id 42")).toBeTruthy();
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

  it("animates the disclosure row and unmounts the payload when closed", async () => {
    render(<ErrorState title="Load failed" message="Unavailable" detail="request id 42" />);
    fireEvent.click(screen.getByText("Technical details"));
    const details = screen.getByText("Technical details").closest("details")!;
    const wrapper = details.querySelector("div")!;
    expect(wrapper.className).toContain("transition-[grid-template-rows]");
    await waitFor(() => expect(wrapper.className).toContain("grid-rows-[1fr]"));

    fireEvent.click(screen.getByText("Technical details"));
    // The row animates back to 0fr first; the panel closes and unmounts when it arrives.
    expect(wrapper.className).toContain("grid-rows-[0fr]");
    expect(details.open).toBe(true);
    expect(screen.getByText("request id 42")).toBeTruthy();
    await waitFor(() => expect(details.open).toBe(false));
    expect(screen.queryByText("request id 42")).toBeNull();
  });

  it("cancels a pending collapse when reopened", async () => {
    render(<ErrorState title="Load failed" message="Unavailable" detail="request id 42" />);
    fireEvent.click(screen.getByText("Technical details"));
    const details = screen.getByText("Technical details").closest("details")!;
    const wrapper = details.querySelector("div")!;
    await waitFor(() => expect(wrapper.className).toContain("grid-rows-[1fr]"));

    fireEvent.click(screen.getByText("Technical details"));
    expect(wrapper.className).toContain("grid-rows-[0fr]");
    fireEvent.click(screen.getByText("Technical details"));

    expect(details.open).toBe(true);
    expect(screen.getByText("request id 42")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(details.open).toBe(true);
    expect(screen.getByText("request id 42")).toBeTruthy();
  });

  it("snaps the collapse when motion is reduced", () => {
    document.documentElement.dataset.motion = "reduced";
    try {
      render(<ErrorState title="Load failed" message="Unavailable" detail="request id 42" />);
      fireEvent.click(screen.getByText("Technical details"));
      const details = screen.getByText("Technical details").closest("details")!;
      expect(details.open).toBe(true);

      fireEvent.click(screen.getByText("Technical details"));
      expect(details.open).toBe(false);
      expect(screen.queryByText("request id 42")).toBeNull();
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });

  it("clears a pending collapse timer on unmount", () => {
    const view = render(<ErrorState title="Load failed" message="Unavailable" detail="request id 42" />);
    fireEvent.click(screen.getByText("Technical details"));
    fireEvent.click(screen.getByText("Technical details"));
    view.unmount();
  });

  it("renders element messages and hints without string normalisation", () => {
    render(<ErrorState title="Load failed" message={<span>Custom failure</span>} hint={<span>Custom hint</span>} detail="request id 42" />);
    expect(screen.getByText("Custom failure")).toBeTruthy();
    expect(screen.getByText("Custom hint")).toBeTruthy();
  });

  it("copies the expanded technical details and reports clipboard failures", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ErrorState title="Load failed" message="Unavailable" detail="request id 42" />);
    fireEvent.click(screen.getByText("Technical details"));

    fireEvent.click(screen.getByRole("button", { name: "Copy technical details" }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith("request id 42");

    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy technical details" }));
    await waitFor(() => expect(screen.getByText("Copy failed")).toBeTruthy());
  });
});
