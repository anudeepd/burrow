import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, Kbd } from "./button";

afterEach(cleanup);

describe("Button", () => {
  it("renders the available variants and sizes", () => {
    const { container } = render(
      <>
        <Button>Default</Button>
        <Button variant="primary" size="sm">
          Primary small
        </Button>
        <Button variant="ghost" size="icon" aria-label="Ghost icon" />
        <Button variant="quiet" size="icon-sm" aria-label="Quiet icon" />
      </>,
    );

    expect(screen.getByRole("button", { name: "Default" }).className).toContain("bg-fabric-2");
    expect(screen.getByRole("button", { name: "Primary small" }).className).toContain("bg-live");
    expect(screen.getByRole("button", { name: "Ghost icon" }).className).toContain("burrow-control--icon");
    expect(screen.getByRole("button", { name: "Quiet icon" }).className).toContain("size-[calc(var(--ctl-h)-4px)]");
    expect(container.querySelectorAll("button")).toHaveLength(4);
  });

  it("keeps titled disabled controls hoverable and renders keyboard hints", () => {
    const { container } = render(
      <>
        <Button title="Explains the action" onClick={() => {}}>
          Enabled
        </Button>
        <Button title="Unavailable while loading" disabled>
          Disabled
        </Button>
        <Kbd className="custom-key">⌘K</Kbd>
      </>,
    );

    expect(screen.getByRole("button", { name: "Enabled" })).toBeTruthy();
    const disabled = screen.getByRole("button", { name: "Disabled" }) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    expect(disabled.parentElement?.tagName).toBe("SPAN");
    expect(screen.getByText("⌘K").tagName).toBe("KBD");
    expect(container.querySelector("kbd")?.className).toContain("custom-key");
  });
});
