import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HighlightedText } from "./highlighted-text";

afterEach(() => cleanup());

describe("HighlightedText", () => {
  it("renders alternating plain and matched text runs", () => {
    const { container } = render(<HighlightedText text="Banana" query="an" />);
    expect(container.textContent).toBe("Banana");
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["an", "an"]);
    expect([...container.querySelectorAll("span")].map((span) => span.textContent)).toEqual(["B", "a"]);
  });

  it("keeps all text plain when the query has no match", () => {
    const { container } = render(<HighlightedText text="plain text" query="missing" />);
    expect(container.textContent).toBe("plain text");
    expect(container.querySelector("mark")).toBeNull();
    expect(container.querySelector("span")?.textContent).toBe("plain text");
  });
});
