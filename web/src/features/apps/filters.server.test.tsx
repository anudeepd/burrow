// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppFilters } from "./filters";

describe("AppFilters server rendering", () => {
  it("renders without browser layout effects", () => {
    const html = renderToString(
      <AppFilters
        search={{}}
        facets={{ total: 0, byState: {}, byFinal: {}, active: 0, users: [], queues: [], types: [], tags: [] }}
        patch={() => undefined}
        now={0}
        compact={false}
      />,
    );
    expect(html).toContain('aria-label="Application filters"');
  });
});
