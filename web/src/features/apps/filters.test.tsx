import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppFilters, fromLocalInput } from "./filters";
import type { Facets } from "./view";
import type { AppsSearch } from "./search";
import { parityStore } from "~/state/parity";

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
  parityStore.setState(() => ({ enabled: true }));
  window.__BURROW_PARITY__ = true;
});

describe("AppFilters", () => {
  it("parses empty, valid, and invalid datetime-local values", () => {
    expect(fromLocalInput("")).toBeUndefined();
    expect(fromLocalInput("not-a-date")).toBeUndefined();
    expect(fromLocalInput("2026-11-02T12:30")).toBe(new Date("2026-11-02T12:30").getTime());
  });

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

  it("clears a selected facet from its picker", async () => {
    const patch = vi.fn();
    render(<AppFilters search={{ user: "alice" }} facets={facets} patch={patch} now={now} compact={false} />);

    fireEvent.click(screen.getByRole("combobox", { name: "User" }));
    const anyUser = await screen.findByRole("option", { name: "Any user" });
    fireEvent.pointerDown(anyUser, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(anyUser, { button: 0, pointerType: "mouse" });
    fireEvent.click(anyUser);
    expect(patch).toHaveBeenCalledWith({ user: undefined });
  });

  it("clears every active facet chip individually", () => {
    const patch = vi.fn();
    render(
      <AppFilters
        search={{ final: "SUCCEEDED", user: "alice", queue: "default", type: "SPARK", tag: "nightly", name: "word count" }}
        facets={facets}
        patch={patch}
        now={now}
        compact={false}
      />,
    );

    for (const [label, update] of [
      ["Final status: Succeeded", { final: undefined }],
      ["User: alice", { user: undefined }],
      ["Queue: default", { queue: undefined }],
      ["Application type: SPARK", { type: undefined }],
      ["Tag: nightly", { tag: undefined }],
      ["Name: word count", { name: undefined }],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(patch).toHaveBeenCalledWith(update);
    }
  });

  it("selects a facet, collapses compact filters, and clears the debounced name", async () => {
    const patch = vi.fn();
    render(<AppFilters search={{ name: "queue" }} facets={facets} patch={patch} now={now} compact />);

    const toggle = screen.getByTestId("apps-filter-toggle");
    fireEvent.click(toggle);
    expect(screen.getByRole("combobox", { name: "Queue" })).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByRole("combobox", { name: "Queue" })).toBeNull();
    fireEvent.click(toggle);

    fireEvent.click(screen.getByRole("combobox", { name: "Queue" }));
    const queue = await screen.findByRole("option", { name: "default (2)" });
    fireEvent.pointerDown(queue, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(queue, { button: 0, pointerType: "mouse" });
    fireEvent.click(queue);
    expect(patch).toHaveBeenCalledWith({ queue: "default" });

    fireEvent.click(screen.getByRole("combobox", { name: "Application type" }));
    const appType = await screen.findByRole("option", { name: "SPARK (1)" });
    fireEvent.pointerDown(appType, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(appType, { button: 0, pointerType: "mouse" });
    fireEvent.click(appType);
    expect(patch).toHaveBeenCalledWith({ type: "SPARK" });

    fireEvent.click(screen.getByRole("combobox", { name: "Tag" }));
    const tag = await screen.findByRole("option", { name: "nightly (1)" });
    fireEvent.pointerDown(tag, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(tag, { button: 0, pointerType: "mouse" });
    fireEvent.click(tag);
    expect(patch).toHaveBeenCalledWith({ tag: "nightly" });

    fireEvent.click(screen.getByRole("button", { name: "Clear name filter" }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 275)));
    expect(patch).toHaveBeenCalledWith({ name: undefined });
  });

  it("edits both bounds and clears a finish-time range and an individual chip", async () => {
    const patch = vi.fn();
    render(
      <AppFilters
        search={{ user: "alice", startedAfter: now - 60_000, startedBefore: now, finishedAfter: now - 120_000 }}
        facets={facets}
        patch={patch}
        now={now}
        compact={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Start time range/ }));
    const from = (await screen.findByLabelText("Start time from")) as HTMLInputElement;
    const localDate = new Date(now - 5 * 60_000);
    const localValue = [
      `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, "0")}-${String(localDate.getDate()).padStart(2, "0")}`,
      `${String(localDate.getHours()).padStart(2, "0")}:${String(localDate.getMinutes()).padStart(2, "0")}`,
    ].join("T");
    fireEvent.input(from, { target: { value: localValue } });
    fireEvent.change(from, { target: { value: localValue } });
    expect(patch).toHaveBeenCalledWith({ startedAfter: new Date(localValue).getTime(), startedBefore: now });

    fireEvent.click(screen.getByRole("button", { name: /Start time range/ }));
    fireEvent.click(screen.getByRole("button", { name: /Finish time range/ }));
    const to = (await screen.findByLabelText("Finish time to")) as HTMLInputElement;
    const finishDate = new Date(now - 5 * 60_000);
    const finishValue = [
      `${finishDate.getFullYear()}-${String(finishDate.getMonth() + 1).padStart(2, "0")}-${String(finishDate.getDate()).padStart(2, "0")}`,
      `${String(finishDate.getHours()).padStart(2, "0")}:${String(finishDate.getMinutes()).padStart(2, "0")}`,
    ].join("T");
    fireEvent.input(to, { target: { value: finishValue } });
    fireEvent.change(to, { target: { value: finishValue } });
    expect(patch).toHaveBeenCalledWith({ finishedAfter: now - 120_000, finishedBefore: new Date(finishValue).getTime() });

    fireEvent.click(screen.getByRole("button", { name: "Clear finish time range" }));
    expect(patch).toHaveBeenCalledWith({ finishedAfter: undefined, finishedBefore: undefined });

    fireEvent.click(screen.getByRole("button", { name: "User: alice" }));
    expect(patch).toHaveBeenCalledWith({ user: undefined });
  });

  it("animates moving and removed filter chips when motion is enabled", () => {
    const originalParity = parityStore.get().enabled;
    const originalMotion = document.documentElement.dataset.motion;
    const originalAnimate = HTMLElement.prototype.animate;
    parityStore.setState(() => ({ enabled: false }));
    delete document.documentElement.dataset.motion;

    let phase = 0;
    let targetTransform = "none";
    const animation = {
      cancel: vi.fn(),
      oncancel: null,
      onfinish: null,
    } as unknown as Animation;
    const animate = vi.fn(
      (_keyframes?: Keyframe[] | PropertyIndexedKeyframes | null, _options?: number | KeyframeAnimationOptions) => animation,
    );
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const shift = this.dataset.filterMotionKey ? phase * 24 : 0;
      return {
        x: shift,
        y: 0,
        left: shift,
        top: 0,
        right: shift + 80,
        bottom: 24,
        width: 80,
        height: 24,
        toJSON: () => ({}),
      };
    });
    HTMLElement.prototype.animate = animate;
    vi.stubGlobal(
      "getComputedStyle",
      vi.fn(() => ({ getPropertyValue: () => "220ms", transform: targetTransform }) as unknown as CSSStyleDeclaration),
    );
    const view = render(
      <AppFilters search={{ user: "alice", queue: "default" }} facets={facets} patch={() => {}} now={now} compact={false} />,
    );
    const removedChip = screen.getByRole("button", { name: "User: alice" });
    removedChip.id = "user-chip";
    removedChip.querySelector("svg")?.setAttribute("id", "user-chip-icon");
    phase = 1;
    view.rerender(<AppFilters search={{ queue: "default" }} facets={facets} patch={() => {}} now={now} compact={false} />);

    expect(animate.mock.calls.length).toBeGreaterThan(0);
    expect(animate.mock.calls.some(([frames]) => JSON.stringify(frames).includes("translate(-24px, 0px)"))).toBe(true);
    const exit = view.container.querySelector('[role="presentation"]');
    expect(exit?.id).toBe("");
    expect(exit?.querySelector("[id]")).toBeNull();
    animation.oncancel?.(new Event("cancel") as AnimationPlaybackEvent);
    expect(exit?.isConnected).toBe(false);
    phase = 2;
    targetTransform = "matrix(1, 0, 0, 1, 0, 0)";
    view.rerender(<AppFilters search={{ queue: "default", tag: "nightly" }} facets={facets} patch={() => {}} now={now} compact={false} />);
    expect(animate.mock.calls.some(([frames]) => JSON.stringify(frames).includes("matrix(1, 0, 0, 1, 0, 0)"))).toBe(true);
    view.rerender(<AppFilters search={{}} facets={facets} patch={() => {}} now={now} compact={false} />);
    view.unmount();
    expect(animation.cancel).toHaveBeenCalled();
    rect.mockRestore();
    if (originalAnimate) HTMLElement.prototype.animate = originalAnimate;
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    parityStore.setState(() => ({ enabled: originalParity }));
    if (originalMotion === undefined) delete document.documentElement.dataset.motion;
    else document.documentElement.dataset.motion = originalMotion;
  });

  it("skips filter-chip animations when the content token is zero", () => {
    const originalParity = parityStore.get().enabled;
    const originalMotion = document.documentElement.dataset.motion;
    const originalAnimate = HTMLElement.prototype.animate;
    parityStore.setState(() => ({ enabled: false }));
    window.__BURROW_PARITY__ = false;
    delete document.documentElement.dataset.motion;
    const animate = vi.fn(() => ({ cancel: vi.fn(), oncancel: null, onfinish: null }) as unknown as Animation);
    HTMLElement.prototype.animate = animate;
    vi.stubGlobal(
      "getComputedStyle",
      vi.fn(() => ({ getPropertyValue: () => "0ms", transform: "none" }) as unknown as CSSStyleDeclaration),
    );
    const view = render(<AppFilters search={{ user: "alice" }} facets={facets} patch={() => {}} now={now} compact={false} />);
    view.rerender(<AppFilters search={{}} facets={facets} patch={() => {}} now={now} compact={false} />);
    expect(animate).not.toHaveBeenCalled();
    view.unmount();
    if (originalAnimate) HTMLElement.prototype.animate = originalAnimate;
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    parityStore.setState(() => ({ enabled: originalParity }));
    window.__BURROW_PARITY__ = originalParity;
    if (originalMotion === undefined) delete document.documentElement.dataset.motion;
    else document.documentElement.dataset.motion = originalMotion;
  });
});
