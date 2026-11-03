import { renderToString } from "react-dom/server";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("useMounted server selection", () => {
  it("uses an effect without a layout effect when window is unavailable", async () => {
    vi.stubGlobal("window", undefined);
    vi.resetModules();
    const { useMounted } = await import("./use-mounted");
    function Probe() {
      return <span>{useMounted() ? "mounted" : "server"}</span>;
    }
    expect(renderToString(<Probe />)).toContain("server");
  });

  it("uses the layout effect in the browser and reports mounted", async () => {
    vi.resetModules();
    const { useMounted } = await import("./use-mounted");
    const { result } = renderHook(() => useMounted());
    expect(result.current).toBe(true);
  });
});
