import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { MenuCheckboxItem, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRoot, MenuTrigger } from "./menu";

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

  it("renders link items with their shortcut hint", async () => {
    render(
      <MenuRoot>
        <MenuTrigger render={<Button>Open actions</Button>}>Open actions</MenuTrigger>
        <MenuContent>
          <MenuItem href="/report" shortcut="⌘R">
            Open report
          </MenuItem>
        </MenuContent>
      </MenuRoot>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open actions" }));
    const item = await screen.findByRole("menuitem", { name: "Open report ⌘R" });
    expect(item.getAttribute("href")).toBe("/report");
  });

  it("renders labeled groups, wrapped items, tooltips, and checkbox actions", async () => {
    const onCheckedChange = vi.fn();
    render(
      <MenuRoot>
        <MenuTrigger render={<Button>More actions</Button>}>More actions</MenuTrigger>
        <MenuContent align="start">
          <MenuGroup>
            <MenuGroupLabel>Reports</MenuGroupLabel>
            <MenuItem href="/long-report" wrap title="Open the complete report" shortcut="⌘R">
              A longer report name that may wrap onto another line
            </MenuItem>
            <MenuCheckboxItem checked={false} onCheckedChange={onCheckedChange} closeOnClick>
              Pin report
            </MenuCheckboxItem>
          </MenuGroup>
        </MenuContent>
      </MenuRoot>,
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByText("Reports")).toBeTruthy();
    const item = await screen.findByRole("menuitem", { name: /A longer report name/ });
    expect(item.getAttribute("href")).toBe("/long-report");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Pin report" }));
    expect(onCheckedChange.mock.calls[0]?.[0]).toBe(true);
  });
});
