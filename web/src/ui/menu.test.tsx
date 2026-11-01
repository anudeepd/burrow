import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { MenuContent, MenuRadioGroup, MenuRoot, MenuTrigger } from "./menu";

afterEach(cleanup);

describe("menu radio group", () => {
  it("renders an optional group label and forwards the selected value", async () => {
    const onValueChange = vi.fn();
    render(
      <MenuRoot>
        <MenuTrigger render={<Button>View options</Button>}>View options</MenuTrigger>
        <MenuContent>
          <MenuRadioGroup
            label="Density"
            value="comfortable"
            onValueChange={onValueChange}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </MenuContent>
      </MenuRoot>,
    );

    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    const option = await screen.findByRole("menuitemradio", { name: "Compact" });
    fireEvent.click(option);
    expect(onValueChange).toHaveBeenCalledWith("compact");
  });
});
