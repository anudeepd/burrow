import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteTabIndicator, TabContent, TabsList, TabsRoot, Tab } from "./tabs";

afterEach(cleanup);

describe("tab content", () => {
  it("preserves an in-progress filter and focus when changes interrupt a content fade", () => {
    const content = (value: string) => (
      <TabContent value={value}>
        <input aria-label="Filter jobs" defaultValue="" />
      </TabContent>
    );
    const view = render(content("jobs"));
    const filter = screen.getByRole("textbox", { name: "Filter jobs" });
    fireEvent.change(filter, { target: { value: "shuffle" } });
    filter.focus();

    view.rerender(content("stages"));
    view.rerender(content("executors"));

    expect((screen.getByRole("textbox", { name: "Filter jobs" }) as HTMLInputElement).value).toBe("shuffle");
    expect(document.activeElement).toBe(filter);
    view.unmount();
  });
});
describe("tab navigation", () => {
  it("renders tabs without overflow cues by default", () => {
    render(
      <TabsRoot defaultValue="one">
        <TabsList label="Sections">
          <Tab value="one">One</Tab>
        </TabsList>
      </TabsRoot>,
    );
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeTruthy();
    expect(document.querySelector(".burrow-horizontal-scroll-cues")).toBeNull();
  });

  it("does not render a route indicator until its list ref exists", () => {
    const listRef = createRef<HTMLElement>();
    const view = render(<RouteTabIndicator listRef={listRef} value="one" />);
    expect(view.container.childElementCount).toBe(0);
  });
});
