import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HelpTip, OptionalTooltip, Tooltip } from "./tooltip";

afterEach(cleanup);

describe("shared tooltip surfaces", () => {
  it("leaves empty optional labels alone and wraps supplied labels", () => {
    render(
      <>
        <OptionalTooltip label="">
          <button type="button">Plain action</button>
        </OptionalTooltip>
        <OptionalTooltip label="Extra context">
          <button type="button">Explained action</button>
        </OptionalTooltip>
      </>,
    );
    expect(screen.getByRole("button", { name: "Plain action" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Explained action" })).toBeTruthy();
  });

  it("opens a help popover and supports controlled tooltip placement", async () => {
    render(
      <>
        <HelpTip label="Resource units" className="custom-help">
          Memory is measured in MiB.
        </HelpTip>
        <Tooltip label="Bottom hint" side="bottom" align="start" open>
          <button type="button">Static trigger</button>
        </Tooltip>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "About Resource units" }));
    expect(await screen.findByText("Memory is measured in MiB.")).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toBe("Bottom hint");
  });
});
