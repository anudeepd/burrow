import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./rail", () => ({
  Rail: ({ onNavigate }: { onNavigate: () => void }) => (
    <button type="button" onClick={onNavigate}>
      Choose a route
    </button>
  ),
}));

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { RailDrawer } = await import("./rail-drawer");

afterEach(cleanup);

describe("RailDrawer", () => {
  it("closes after navigation", () => {
    const onOpenChange = vi.fn();
    render(<RailDrawer open onOpenChange={onOpenChange} returnFocus={createRef<HTMLButtonElement>()} />);
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose a route" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
