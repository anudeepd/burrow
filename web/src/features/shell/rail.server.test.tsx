// @vitest-environment node
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined }),
}));
vi.mock("~/api/connection", () => ({
  useConnection: (select: (state: { consecutiveFailures: number; lastCache: string | null }) => unknown) =>
    select({ consecutiveFailures: 0, lastCache: null }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    delete props.activeOptions;
    return createElement("a", props, children);
  },
  useLocation: () => ({ pathname: "/" }),
}));

import { Rail } from "./rail";

describe("Rail server rendering", () => {
  it("uses the server-safe layout effect and renders expanded navigation", () => {
    const html = renderToString(<Rail />);
    expect(html).toContain('aria-label="Sections"');
    expect(html).toContain("Applications");
    expect(html).toContain('data-collapsed="false"');
  });
});
