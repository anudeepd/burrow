import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { syntheticDag } from "../simulate";
import { DagView } from "./DagView";

const { layout } = vi.hoisted(() => ({ layout: vi.fn() }));
vi.mock("../layout/client", () => ({ layoutClient: () => ({ layout }) }));

afterEach(() => {
  cleanup();
  layout.mockReset();
});

describe("DagView layout retry", () => {
  it("starts another layout attempt when Retry is pressed", async () => {
    layout.mockRejectedValue(new Error("worker unavailable"));
    render(<DagView dag={syntheticDag({ stages: 1, nodesPerStage: 2, skipEvery: 0, seed: 3 })} />);

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(layout).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);

    await waitFor(() => expect(layout).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
