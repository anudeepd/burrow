import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "./select";

afterEach(cleanup);

describe("Select", () => {
  it("shows a placeholder, forwards trigger clicks, and can stop popup propagation", async () => {
    const onValueChange = vi.fn();
    const onClick = vi.fn();
    const ancestorClick = vi.fn();
    render(
      <div role="group" aria-label="Select click boundary" onClick={ancestorClick}>
        <Select
          label="Resource type"
          value={null}
          placeholder="Choose a resource"
          options={[
            { value: "gpu", label: "GPU" },
            { value: "fpga", label: "FPGA" },
          ]}
          onValueChange={onValueChange}
          onClick={onClick}
          stopPopupClickPropagation
          className="wide-select"
        />
      </div>,
    );

    const trigger = screen.getByRole("combobox", { name: "Resource type" });
    expect(trigger.textContent).toContain("Choose a resource");
    fireEvent.click(trigger);
    expect(onClick).toHaveBeenCalledOnce();
    const option = await screen.findByRole("option", { name: "GPU" });
    fireEvent.click(option);
    expect(onValueChange).toHaveBeenCalledWith("gpu");
    expect(ancestorClick).toHaveBeenCalledTimes(1);
  });
});
