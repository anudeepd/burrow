import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PopoverClose, PopoverContent, PopoverRoot, PopoverTrigger } from "./popover";

afterEach(cleanup);

describe("PopoverContent", () => {
  it("supports default positioning and optional titles", async () => {
    render(
      <>
        <PopoverRoot>
          <PopoverTrigger>Default popover</PopoverTrigger>
          <PopoverContent title="Shortcuts">Default content</PopoverContent>
        </PopoverRoot>
        <PopoverRoot>
          <PopoverTrigger>Custom popover</PopoverTrigger>
          <PopoverContent side="right" align="center" sideOffset={12}>
            Custom content
            <PopoverClose>Close panel</PopoverClose>
          </PopoverContent>
        </PopoverRoot>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Default popover" }));
    expect(await screen.findByText("Shortcuts")).toBeTruthy();
    expect(screen.getByText("Default content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Custom popover" }));
    expect(await screen.findByText("Custom content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.getByRole("dialog").hasAttribute("data-closed")).toBe(true);
  });
});
