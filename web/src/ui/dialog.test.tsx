import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DialogRoot, Modal, Sheet } from "./dialog";

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

  it("defaults to a right sheet and supports a bottom sheet", () => {
    const first = render(
      <DialogRoot defaultOpen>
        <Sheet title="Right detail">Right body</Sheet>
      </DialogRoot>,
    );
    expect(screen.getByRole("dialog", { name: "Right detail" }).getAttribute("data-side")).toBe("right");
    first.unmount();

    render(
      <DialogRoot defaultOpen>
        <Sheet title="Bottom detail" side="bottom">
          Bottom body
        </Sheet>
      </DialogRoot>,
    );
    expect(screen.getByRole("dialog", { name: "Bottom detail" }).getAttribute("data-side")).toBe("bottom");
  });
});

describe("Modal", () => {
  it("opens by default with a description and closes through its accessible control", () => {
    render(
      <Modal title="Node details" description="Live node data" className="custom-modal">
        Modal body
      </Modal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Node details" });
    expect(dialog.textContent).toContain("Live node data");
    expect(dialog.textContent).toContain("Modal body");
    expect(dialog.className).toContain("custom-modal");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Node details" }).hasAttribute("data-closed")).toBe(true);
  });

  it("supports controlled visibility and the instant presentation", () => {
    const onOpenChange = vi.fn();
    render(
      <Modal open title="Quick actions" onOpenChange={onOpenChange} defaultOpen={false} instant>
        Content
      </Modal>,
    );

    expect(screen.getByRole("dialog", { name: "Quick actions" }).className).toContain("burrow-instant");
    expect(screen.queryByText("Quick actions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });
});
