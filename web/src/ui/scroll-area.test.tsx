import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";

vi.mock("@base-ui/react/scroll-area", async () => {
  const React = await import("react");
  const part = (name: string, forwardsRef = false) => {
    const render = (props: Record<string, unknown>, ref?: React.Ref<HTMLDivElement>) =>
      React.createElement(
        "div",
        {
          ...props,
          ref,
          "data-part": name,
          ...(props.orientation ? { "data-orientation": props.orientation } : {}),
        },
        props.children as React.ReactNode,
      );
    return forwardsRef ? React.forwardRef<HTMLDivElement, Record<string, unknown>>(render) : render;
  };
  return {
    ScrollArea: {
      Root: part("root"),
      Viewport: part("viewport", true),
      Content: part("content"),
      Scrollbar: part("scrollbar"),
      Thumb: part("thumb"),
    },
  };
});

const { cleanup, render } = await import("@testing-library/react");
const { ScrollArea } = await import("./scroll-area");

afterEach(cleanup);

describe("ScrollArea", () => {
  it("renders only the requested bars and forwards the viewport ref", () => {
    const viewportRef = createRef<HTMLDivElement>();
    const view = render(
      <ScrollArea orientation="vertical" className="test-root" viewportClassName="test-viewport" viewportRef={viewportRef}>
        <div>wide content</div>
      </ScrollArea>,
    );
    const bars = () =>
      [...view.container.querySelectorAll<HTMLElement>('[data-part="scrollbar"]')].map((el) => el.getAttribute("data-orientation"));

    expect(viewportRef.current).not.toBeNull();
    expect(view.container.querySelector(".test-root")).not.toBeNull();
    expect(viewportRef.current?.className).toContain("test-viewport");
    expect(bars()).toEqual(["vertical"]);

    view.rerender(
      <ScrollArea orientation="horizontal">
        <div>wide content</div>
      </ScrollArea>,
    );
    expect(bars()).toEqual(["horizontal"]);

    view.rerender(
      <ScrollArea orientation="both">
        <div>wide content</div>
      </ScrollArea>,
    );
    expect(bars()).toEqual(["vertical", "horizontal"]);
  });
});
