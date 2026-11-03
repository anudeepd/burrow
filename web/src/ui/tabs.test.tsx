import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tab, TabContent, TabsList, TabsRoot } from "./tabs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tabs", () => {
  it("renders a default tab list, optional badges, and fades changed content", () => {
    const animation = { playState: "running", cancel: vi.fn() } as unknown as Animation;
    const animate = vi.fn(() => animation);
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    vi.stubGlobal(
      "getComputedStyle",
      () => ({ opacity: "not-a-number", getPropertyValue: () => "220ms" }) as unknown as CSSStyleDeclaration,
    );

    const makeTree = (value: string, overflowFade = false) => (
      <>
        <TabsRoot defaultValue="one">
          <TabsList label="Details" {...(overflowFade ? { overflowFade: true } : {})}>
            <Tab value="one" field="tab.one">
              One
            </Tab>
            <Tab value="two" badge={2}>
              Two
            </Tab>
          </TabsList>
        </TabsRoot>
        <TabContent value={value}>Panel {value}</TabContent>
      </>
    );
    const view = render(makeTree("one"));
    expect(screen.getByRole("tab", { name: "One" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Two 2" })).toBeTruthy();
    expect(document.querySelector('[data-scroll-cue="left"]')).toBeNull();

    view.rerender(makeTree("two", true));
    expect(document.querySelector('[data-scroll-cue="left"]')).not.toBeNull();
    view.rerender(makeTree("three", true));
    expect(animate).toHaveBeenCalled();
    expect(animation.cancel).toHaveBeenCalled();
    expect(screen.getByText("Panel three")).toBeTruthy();
  });
});
