import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Datum, Entity, SINGLETON, datumAttrs } from "./datum";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("parity datum primitives", () => {
  it("stamps missing, raw, and formatted values", () => {
    expect(datumAttrs("node.state", null, "text")).toEqual({
      "data-yf": "node.state",
      "data-yv": "",
      "data-yn": "1",
      "data-yfmt": "text",
    });
    expect(datumAttrs("node.count", 12)).toEqual({ "data-yf": "node.count", "data-yv": "12" });
    expect(SINGLETON).toBe("_");
  });

  it("supports custom entity elements and nested bare datums", () => {
    render(
      <Entity id="worker:8041" domId="worker-detail" as="section" aria-label="Worker">
        <Datum field="node.summary" raw="worker:8041" bare>
          Visible composite
        </Datum>
      </Entity>,
    );

    const entity = screen.getByRole("region", { name: "Worker" });
    expect(entity.id).toBe("worker-detail");
    expect(entity.getAttribute("data-ye")).toBe("worker:8041");
    expect(entity.querySelector("[data-yf='node.summary']")?.textContent).toBe("");
    expect(entity.querySelector("[data-yf='node.summary']")?.getAttribute("data-yv")).toBe("worker:8041");
  });

  it("wraps titled visible values in a tooltip and preserves caller content", () => {
    render(
      <Entity id="app-1">
        <Datum field="app.id" raw="application_1" title="Application id">
          Friendly id
        </Datum>
      </Entity>,
    );

    expect(screen.getByText("Friendly id").getAttribute("data-yv")).toBe("application_1");
  });

  it("warns when a Datum is rendered outside an Entity in development", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<Datum field="node.state" raw="RUNNING" />);
    expect(warn).toHaveBeenCalledWith('[parity] <Datum field="node.state"> rendered outside <Entity>');
  });
});
