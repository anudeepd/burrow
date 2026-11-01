import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutsDialog } from "./shortcuts-dialog";

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");

afterEach(() => cleanup());

describe("ShortcutsDialog", () => {
  it("groups shortcuts, displays each key, and closes from the dialog", () => {
    const onOpenChange = vi.fn();
    render(<ShortcutsDialog open onOpenChange={onOpenChange} />);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog.textContent).toContain("Everything is reachable without a mouse.");
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(1);
    expect(screen.getAllByText("Go to Overview").length).toBe(1);
    expect(dialog.querySelectorAll("kbd").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.objectContaining({ reason: "close-press" }));
  });
});
