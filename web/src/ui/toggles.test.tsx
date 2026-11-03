import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Segmented, Switch, Toggle } from "./toggles";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("shared toggles", () => {
  it("supports switches, toggles, and segmented options with and without hints", () => {
    const onCheckedChange = vi.fn();
    const onPressedChange = vi.fn();
    const onValueChange = vi.fn();
    render(
      <>
        <Switch label="Enable polling" checked={false} onCheckedChange={onCheckedChange} hint="Pause automatic refresh" />
        <Switch label="Plain switch" checked={true} onCheckedChange={onCheckedChange} />
        <Toggle label="Pin column" pressed={false} onPressedChange={onPressedChange} hint="Keep this column visible">
          Pin
        </Toggle>
        <Toggle label="Plain toggle" pressed={false} onPressedChange={onPressedChange}>
          Plain
        </Toggle>
        <Segmented
          label="Theme"
          value="dark"
          onValueChange={onValueChange}
          options={[
            { value: "dark", label: "Dark", aria: "Dark theme" },
            { value: "light", label: "Light", aria: "Light theme", hint: "Use a light palette" },
          ]}
        />
      </>,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Enable polling" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin column" }));
    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
    expect(onCheckedChange.mock.calls[0]?.[0]).toBe(true);
    expect(onPressedChange.mock.calls[0]?.[0]).toBe(true);
    expect(onValueChange.mock.calls[0]?.[0]).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });
});
