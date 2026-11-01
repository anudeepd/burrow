import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DialogRoot, Sheet } from "./dialog";

afterEach(cleanup);

describe("Sheet", () => {
  it("renders its titled content at the requested edge", () => {
    render(
      <DialogRoot defaultOpen>
        <Sheet title="Details" description="Expanded record" side="left">
          Sheet body
        </Sheet>
      </DialogRoot>,
    );

    expect(screen.getByRole("dialog", { name: "Details" }).getAttribute("data-side")).toBe("left");
    expect(screen.getByText("Expanded record")).toBeTruthy();
    expect(screen.getByText("Sheet body")).toBeTruthy();
  });
});
