import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppFilters } from "./filters";
import type { Facets } from "./view";
import type { AppsSearch } from "./search";

const facets: Facets = {
  total: 2,
  byState: { RUNNING: 1, FINISHED: 1 },
  byFinal: { SUCCEEDED: 1 },
  active: 1,
  users: [{ value: "alice", count: 1 }],
  queues: [{ value: "default", count: 2 }],
  types: [{ value: "SPARK", count: 1 }],
  tags: [{ value: "nightly", count: 1 }],
};
const now = 1_800_000_000_000;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AppFilters", () => {
  it("reveals compact facets, applies range presets, and clears the active filter set", () => {
    const patch = vi.fn();
    const search: AppsSearch = {
      final: "SUCCEEDED",
      user: "alice",
      queue: "default",
      type: "SPARK",
      tag: "nightly",
      name: "word count",
      startedAfter: now - 60 * 60_000,
      finishedBefore: now,
    };
    render(<AppFilters search={search} facets={facets} patch={patch} now={now} compact showLegacyFinishedLabel />);

    expect(screen.getByText("Final status: Succeeded")).toBeTruthy();
    expect(screen.getByText("User: alice")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "User" })).toBeNull();

    fireEvent.click(screen.getByTestId("apps-filter-toggle"));
    expect(screen.getByText("URL-synced")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "User" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Application type" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Start time range/ }));
    fireEvent.click(screen.getByRole("button", { name: "Last hour" }));
    expect(patch).toHaveBeenCalledWith({ startedAfter: now - 60 * 60_000, startedBefore: undefined });

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(patch).toHaveBeenCalledWith({
      final: undefined,
      user: undefined,
      queue: undefined,
      type: undefined,
      tag: undefined,
      name: undefined,
      startedAfter: undefined,
      startedBefore: undefined,
      finishedAfter: undefined,
      finishedBefore: undefined,
    });
  });

  it("debounces and trims name input, and resets its draft when URL state changes", async () => {
    vi.useFakeTimers();
    const patch = vi.fn();
    const view = render(<AppFilters search={{}} facets={facets} patch={patch} now={now} compact={false} />);
    const input = screen.getByRole("textbox", { name: "Filter by name or application ID" });
    fireEvent.change(input, { target: { value: "  queue report  " } });
    expect(patch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(patch).toHaveBeenCalledWith({ name: "queue report" });

    view.rerender(<AppFilters search={{ name: "server" }} facets={facets} patch={patch} now={now} compact={false} />);
    expect((screen.getByRole("textbox", { name: "Filter by name or application ID" }) as HTMLInputElement).value).toBe("server");
  });
});
