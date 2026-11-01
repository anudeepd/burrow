import { afterEach, describe, expect, it, vi } from "vitest";
import { onUserScrollIntent } from "./reveal";

const { cleanup, fireEvent } = await import("@testing-library/react");

afterEach(() => cleanup());

describe("onUserScrollIntent", () => {
  it("distinguishes real scroll input from typing and clicks inside the scrollport", () => {
    const scrollport = document.createElement("div");
    const input = document.createElement("input");
    scrollport.append(input);
    document.body.append(scrollport);
    const onIntent = vi.fn();
    const stop = onUserScrollIntent(scrollport, onIntent);

    fireEvent.wheel(scrollport, { deltaY: 0, deltaX: 0 });
    fireEvent.pointerDown(input);
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onIntent).not.toHaveBeenCalled();

    fireEvent.pointerDown(scrollport);
    fireEvent.wheel(scrollport, { deltaY: 5 });
    fireEvent.touchMove(scrollport);
    fireEvent.keyDown(scrollport, { key: "PageDown" });
    expect(onIntent).toHaveBeenCalledTimes(4);

    stop();
    fireEvent.keyDown(scrollport, { key: "End" });
    expect(onIntent).toHaveBeenCalledTimes(4);
  });
});
