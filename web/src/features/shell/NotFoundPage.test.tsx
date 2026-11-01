import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundPage } from "./NotFoundPage";

afterEach(cleanup);

describe("NotFoundPage", () => {
  it("explains the missing route and links back to the overview", () => {
    render(<NotFoundPage />);
    expect(screen.getByText("That route does not exist in this build.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to the overview" }).getAttribute("href")).toBe("/");
  });
});
