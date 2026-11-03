import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLogSearchHotkey } from "./use-log-search-hotkey";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function addSearch(disabled = false): HTMLInputElement {
  const wrapper = document.createElement("div");
  wrapper.dataset.burrowLogSearch = "";
  const input = document.createElement("input");
  input.type = "search";
  input.disabled = disabled;
  wrapper.append(input);
  document.body.append(wrapper);
  return input;
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "f", ...init });
  window.dispatchEvent(event);
  return event;
}

describe("useLogSearchHotkey", () => {
  it("focuses and selects the search input for Ctrl+F and Cmd+F", () => {
    const input = addSearch();
    const focus = vi.spyOn(input, "focus");
    const select = vi.spyOn(input, "select");
    const hook = renderHook(() => useLogSearchHotkey());

    const ctrl = keydown({ ctrlKey: true, key: "F" });
    expect(ctrl.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();

    keydown({ metaKey: true });
    expect(focus).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledTimes(2);
    hook.unmount();
    keydown({ ctrlKey: true });
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it("ignores prevented, modified, composing, unrelated, and dialog shortcuts", () => {
    addSearch();
    renderHook(() => useLogSearchHotkey());
    const prevented = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    prevented.preventDefault();
    window.dispatchEvent(prevented);

    keydown({ altKey: true, ctrlKey: true });
    keydown({ shiftKey: true, ctrlKey: true });
    keydown({ isComposing: true, ctrlKey: true });
    keydown({ key: "g", ctrlKey: true });
    keydown({});
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    keydown({ ctrlKey: true });
    expect(prevented.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(document.querySelector("[data-burrow-log-search] input"));
  });

  it("ignores missing or disabled search fields", () => {
    renderHook(() => useLogSearchHotkey());
    expect(keydown({ ctrlKey: true }).defaultPrevented).toBe(false);
    document.body.innerHTML = "";
    addSearch(true);
    expect(keydown({ ctrlKey: true }).defaultPrevented).toBe(false);
  });
});
