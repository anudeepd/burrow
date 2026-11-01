import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GoIcon, Kv, Panel, Section, StaleTag, Unavailable } from "./ui";

afterEach(cleanup);

describe("overview presentation primitives", () => {
  it("renders section chrome, card variants, and label/value pairs", async () => {
    const { container } = render(
      <>
        <Panel as="article" aria-label="summary" className="extra-class">
          Card
        </Panel>
        <Section
          id="identity"
          title="Identity"
          headingLevel={3}
          hint="Cluster details"
          help="About these fields"
          actions={<button type="button">Refresh</button>}
        >
          Content
        </Section>
        <dl>
          <Kv label="Version" className="version">
            <span>3.5.9</span>
          </Kv>
        </dl>
        <GoIcon />
      </>,
    );
    expect(screen.getByRole("article", { name: "summary" }).textContent).toBe("Card");
    expect(screen.getByRole("heading", { name: "Identity", level: 3 })).toBeTruthy();
    expect(screen.getByText("Cluster details")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "About Identity" }));
    expect(await screen.findByText("About these fields")).toBeTruthy();
    expect(screen.getByText("Version").parentElement?.className).toContain("version");
    expect(container.querySelector("svg.lucide-arrow-up-right")).toBeTruthy();
  });

  it("distinguishes string and node reasons and renders stale age", () => {
    const { container } = render(
      <>
        <Unavailable reason="No upstream value" />
        <Unavailable reason={<span>Not applicable</span>} variant="info" />
        <StaleTag ageMs={2500} />
        <StaleTag ageMs={0} />
      </>,
    );
    expect(screen.getByText("No upstream value")).toBeTruthy();
    expect(screen.getByText("Not applicable")).toBeTruthy();
    expect(screen.getByText("stale · 3s")).toBeTruthy();
    expect(container.querySelectorAll("svg.lucide-info")).toHaveLength(3);
  });
});
