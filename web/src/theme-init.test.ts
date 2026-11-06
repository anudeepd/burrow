import { createInstrumenter } from "@vitest/istanbul-lib-instrument";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import bootstrapSource from "../public/theme-init.js?raw";

const filename = resolve(process.cwd(), "public/theme-init.js");
// Match Vitest's Istanbul coverage global so these runtime counters enter its report.
const instrumentedBootstrap = createInstrumenter({
  coverageVariable: "__VITEST_COVERAGE__",
  coverageGlobalScope: "globalThis",
  coverageGlobalScopeFunc: false,
}).instrumentSync(bootstrapSource, filename);

function runBootstrap(prefs: Record<string, unknown> | undefined, options: { query?: string; parity?: boolean; lightPreference?: boolean } = {}) {
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  root.removeAttribute("data-motion");
  root.removeAttribute("data-rail-collapsed");
  root.removeAttribute("data-parity");
  if (prefs === undefined) localStorage.removeItem("burrow.prefs.v1");
  else localStorage.setItem("burrow.prefs.v1", JSON.stringify(prefs));
  history.replaceState({}, "", options.query ?? "/");
  window.__BURROW_PARITY__ = options.parity ?? false;
  window.matchMedia = vi.fn().mockReturnValue({ matches: options.lightPreference ?? false });
  new Function(instrumentedBootstrap)();
}

describe("pre-paint theme bootstrap", () => {
  it("resolves explicit light and dark themes and updates matching favicons", () => {
    document.head.innerHTML = `
      <link data-dark-href="dark.svg" data-light-href="light.svg" href="old.svg">
      <link data-dark-href="dark-only.svg" data-light-href="" href="existing.svg">
      <link data-dark-href="dark.svg" data-light-href="light.svg" href="light.svg">
    `;
    runBootstrap({ theme: "light" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelectorAll("link")[0]?.getAttribute("href")).toBe("light.svg");
    expect(document.querySelectorAll("link")[1]?.getAttribute("href")).toBe("existing.svg");
    expect(document.querySelectorAll("link")[2]?.getAttribute("href")).toBe("light.svg");

    runBootstrap({ theme: "dark" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.querySelectorAll("link")[0]?.getAttribute("href")).toBe("dark.svg");
    expect(document.querySelectorAll("link")[1]?.getAttribute("href")).toBe("dark-only.svg");
  });

  it("resolves system preference and applies optional motion, rail, and parity settings", () => {
    runBootstrap({ theme: "system", motion: "reduced", railCollapsed: true }, { lightPreference: true, query: "?parity=1" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-motion")).toBe("reduced");
    expect(document.documentElement.getAttribute("data-rail-collapsed")).toBe("true");
    expect(document.documentElement.getAttribute("data-parity")).toBe("1");

    runBootstrap({ theme: "system", motion: "full", railCollapsed: false }, { lightPreference: false, query: "?parity=true" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
    expect(document.documentElement.hasAttribute("data-rail-collapsed")).toBe(false);
    expect(document.documentElement.getAttribute("data-parity")).toBe("1");

    runBootstrap({ theme: "light" }, { parity: true });
    expect(document.documentElement.getAttribute("data-parity")).toBe("1");
    runBootstrap({});
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.hasAttribute("data-parity")).toBe(false);
  });

  it("uses the default theme when the preference key is absent", () => {
    document.head.replaceChildren();
    runBootstrap(undefined);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
    expect(document.documentElement.hasAttribute("data-rail-collapsed")).toBe(false);
  });

  it("falls back without setting attributes when stored preferences are malformed", () => {
    localStorage.setItem("burrow.prefs.v1", "{");
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-motion");
    document.documentElement.removeAttribute("data-rail-collapsed");
    document.documentElement.removeAttribute("data-parity");
    new Function(instrumentedBootstrap)();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
    expect(document.documentElement.hasAttribute("data-rail-collapsed")).toBe(false);
    expect(document.documentElement.hasAttribute("data-parity")).toBe(false);
  });
});
