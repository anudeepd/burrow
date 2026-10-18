/**
 * Structural guard for the status motion wiring (DESIGN §5.2/§6.3).
 *
 * The status table declares a motion per state, and the CSS only animates an element that carries the matching class
 * **and** `data-visible` (the shared IntersectionObserver gate) — a class without the attribute is dead, which is
 * exactly how the app timeline's live dot shipped once (`burrow-dot-pulse` with no `data-visible`, no ring, ever). jsdom
 * does not load the stylesheet, so this test asserts the contract rather than the painted result: every `pulse` state
 * renders the ring class on the element that also carries the gate, and `drain` reaches the pill.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { statusSpec } from "~/design/status";
import { Entity } from "./datum";
import { StatusDot, StatusPill } from "./status";

/** The element the CSS animates: the dot itself, or the pill's leading-icon wrapper. */
const gateOf = (el: HTMLElement) => el.querySelector<HTMLElement>(".burrow-dot-pulse");

describe("StatusDot motion", () => {
  it("paints the pulse ring for a pulse state (app RUNNING)", () => {
    const { container } = render(<StatusDot domain="app.state" state="RUNNING" />);
    const dot = container.querySelector<HTMLElement>(".burrow-dot-pulse");
    expect(dot).not.toBeNull();
    expect(dot?.dataset.visible).toBe("false"); // offscreen until the observer says otherwise
    expect(dot?.className).toContain("burrow-tone-live");
  });

  it("paints no ring for a static state (app FINISHED)", () => {
    const { container } = render(<StatusDot domain="app.state" state="FINISHED" />);
    expect(container.querySelector(".burrow-dot-pulse")).toBeNull();
  });
});

describe("StatusPill motion", () => {
  const liveStates = [
    ["app.state", "RUNNING"],
    ["node.state", "RUNNING"],
    ["queue.state", "RUNNING"],
    ["container.state", "RUNNING"],
    ["app.logAggregationStatus", "RUNNING"],
    ["spark.job", "RUNNING"],
    ["spark.stage", "ACTIVE"],
    ["spark.task", "RUNNING"],
    ["spark.sql", "RUNNING"],
    ["spark.executor", "ACTIVE"],
    ["rm.haState", "ACTIVE"],
  ] as const;

  it.each(liveStates)("uses the shared pulse for %s %s", (domain, state) => {
    const { container } = render(<StatusPill domain={domain} state={state} />);
    const gate = gateOf(container.querySelector<HTMLElement>(".burrow-pill")!);
    expect(gate?.className).toContain("burrow-dot-pulse");
    expect(gate?.dataset.visible).toBe("false");
  });

  it.each(liveStates)("matches Applications live styling for %s %s", (domain, state) => {
    const running = statusSpec("app.state", "RUNNING");
    expect(statusSpec(domain, state)).toMatchObject({
      tone: running.tone,
      icon: running.icon,
      shape: running.shape,
      motion: running.motion,
    });
  });

  it("carries the drain loop for a decommissioning node", () => {
    const { container } = render(<StatusPill domain="node.state" state="DECOMMISSIONING" />);
    const pill = container.querySelector<HTMLElement>(".burrow-pill");
    expect(pill?.className).toContain("burrow-drain");
    expect(pill?.dataset.visible).toBe("false");
  });

  it("still stamps the parity datum when the pill is the datum (field given)", () => {
    const { container } = render(
      <Entity id="_">
        <StatusPill domain="app.state" state="RUNNING" field="app.state" />
      </Entity>,
    );
    const pill = container.querySelector<HTMLElement>(".burrow-pill");
    expect(pill?.getAttribute("data-yf")).toBe("app.state");
    expect(pill?.getAttribute("data-yv")).toBe("RUNNING");
    expect(pill?.dataset.visible).toBe("false");
  });

  it("keeps boolean API values when status uses a normalized pulse key", () => {
    const { container } = render(
      <Entity id="executor-1">
        <StatusPill domain="spark.executor" state="ACTIVE" field="spark.executor.isActive" raw={true} />
      </Entity>,
    );
    const pill = container.querySelector<HTMLElement>(".burrow-pill");
    expect(pill?.getAttribute("data-yv")).toBe("true");
    expect(gateOf(pill!)?.className).toContain("burrow-dot-pulse");
  });
});
