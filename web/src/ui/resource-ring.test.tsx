import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResourceRing } from "./resource-ring";

describe("ResourceRing", () => {
  it("shows the computed percentage and a reserved arc with default presentation", () => {
    const { container } = render(<ResourceRing label="Memory" used={20} reserved={30} total={100} />);
    expect(screen.getByRole("img", { name: "Memory: 20% used" }).className).toContain("burrow-tone-live");
    expect(container.querySelectorAll("circle")).toHaveLength(3);
    expect(container.querySelector(".tnum")?.textContent).toBe("20%");
  });

  it("omits the reserved arc when used capacity already fills the available total", () => {
    const { container } = render(<ResourceRing label="Full" used={100} reserved={25} total={100} centre="full" />);
    expect(container.querySelectorAll("circle")).toHaveLength(2);
    expect(container.querySelector(".tnum")?.textContent).toBe("full");
  });

  it("defaults the reserved amount and clamps invalid capacity inputs to zero", () => {
    const { container, rerender } = render(<ResourceRing label="Unknown" used={Number.NaN} total={0} />);
    expect(screen.getByRole("img", { name: "Unknown: 0% used" })).toBeTruthy();
    expect(container.querySelectorAll("circle")).toHaveLength(2);

    rerender(<ResourceRing label="Invalid total" used={10} total={Number.POSITIVE_INFINITY} reserved={5} />);
    expect(screen.getByRole("img", { name: "Invalid total: 0% used" })).toBeTruthy();
  });
});
