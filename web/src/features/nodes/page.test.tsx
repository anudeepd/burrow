import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node } from "~/api/schemas";
import { copyText } from "~/lib/copy";
import { Field, FieldLabel, KvGrid, PageHead, SearchField, Section, Stat, Unavailable, CopyButton } from "./page";
import { TopConsumers } from "./TopConsumers";

vi.mock("~/lib/copy", () => ({ copyText: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shared node page components", () => {
  it("renders optional page chrome and section heading variants", () => {
    const { rerender } = render(
      <>
        <PageHead title="Nodes" description="Node inventory" actions={<button type="button">Refresh</button>} />
        <Section title="Resources" actions={<button type="button">Details</button>}>
          <span>body</span>
        </Section>
      </>,
    );
    expect(screen.getByText("Node inventory")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Resources" })).toBeTruthy();
    rerender(
      <>
        <PageHead title="Bare" />
        <Section title={<strong>Custom section</strong>}>
          <span>body</span>
        </Section>
        <Section>
          <span>plain section</span>
        </Section>
      </>,
    );
    expect(screen.getByRole("heading", { name: "Bare" })).toBeTruthy();
    expect(screen.getByText("Custom section").tagName).toBe("STRONG");
    expect(screen.getByText("plain section")).toBeTruthy();
  });

  it("renders fields with and without parity data, hints, and mono styling", () => {
    const { container } = render(
      <dl>
        <Field label={<b>Custom label</b>} hint="Details" mono>
          raw child
        </Field>
        <Field label="Node state" field="node.state" raw="RUNNING" hint="From the ResourceManager">
          Running
        </Field>
      </dl>,
    );
    expect(screen.getByRole("button", { name: "About Field details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "About Node state" })).toBeTruthy();
    expect(container.querySelector('[data-yf="node.state"][data-yv="RUNNING"]')?.textContent).toBe("Running");
    expect(container.querySelector("dd.font-mono")?.textContent).toBe("raw child");
  });

  it("supports all grid columns and statistic tones", () => {
    const { rerender, container } = render(
      <>
        <KvGrid>
          <FieldLabel>Label</FieldLabel>
        </KvGrid>
        <Stat label="Healthy" value="4" sub="nodes" tone="warn" />
      </>,
    );
    expect(container.querySelector("dl")?.className).toContain("lg:grid-cols-3");
    expect(screen.getByText("nodes")).toBeTruthy();
    expect(container.querySelector(".text-warn")).toBeTruthy();
    rerender(
      <>
        <KvGrid columns={2}>
          <FieldLabel htmlFor="custom-id">Two columns</FieldLabel>
        </KvGrid>
        <KvGrid columns={4}>
          <FieldLabel>Four columns</FieldLabel>
        </KvGrid>
        <Stat label="Current" value="1" tone="live" />
        <Stat label="Failed" value="0" tone="fail" />
        <Stat label="OK" value="3" tone="ok" />
      </>,
    );
    expect(container.querySelectorAll("dl")[0]?.className).toContain("sm:grid-cols-2");
    expect(container.querySelectorAll("dl")[1]?.className).toContain("lg:grid-cols-4");
    expect(container.querySelector('label[for="custom-id"]')).toBeTruthy();
    expect(container.querySelector(".text-live")).toBeTruthy();
    expect(container.querySelector(".text-fail")).toBeTruthy();
    expect(container.querySelector(".text-ok")).toBeTruthy();
  });

  it("shows availability hints only when supplied", () => {
    const { rerender } = render(<Unavailable title="No data" reason="The endpoint is not available." />);
    expect(screen.getByRole("status").textContent).toContain("The endpoint is not available.");
    expect(screen.queryByText("Try the ResourceManager again.")).toBeNull();
    rerender(<Unavailable title="No data" reason="The endpoint is not available." hint="Try the ResourceManager again." />);
    expect(screen.getByText("Try the ResourceManager again.")).toBeTruthy();
  });

  it("debounces search, supports the default placeholder, and clears the draft", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<SearchField value="" label="Search nodes" onChange={onChange} />);
    const input = screen.getByRole("searchbox", { name: "Search nodes" }) as HTMLInputElement;
    expect(input.placeholder).toBe("Search");
    fireEvent.change(input, { target: { value: "worker" } });
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(onChange).toHaveBeenCalledWith("worker");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input.value).toBe("");
  });

  it("copies text with the default label and confirms success", async () => {
    vi.useFakeTimers();
    vi.mocked(copyText).mockResolvedValueOnce(true);
    const { container } = render(<CopyButton value="worker:8041" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(copyText).toHaveBeenCalledWith("worker:8041");
    expect(container.querySelector("svg.text-ok")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(container.querySelector("svg.text-ok")).toBeNull();
    vi.mocked(copyText).mockRejectedValueOnce(new Error("copy failed"));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("svg.text-ok")).toBeNull();
  });
});

describe("TopConsumers", () => {
  const makeNode = (id: string, state: string, numContainers: number) =>
    ({
      id,
      state,
      nodeHostName: id,
      numContainers,
      usedMemoryMB: 100,
      memUtilization: 25,
      cpuUtilization: 10,
    }) as Node;

  it("includes decommissioning nodes and excludes unschedulable states", () => {
    const onOpen = vi.fn();
    const running = makeNode("running", "RUNNING", 4);
    const decommissioning = makeNode("draining", "DECOMMISSIONING", 2);
    render(<TopConsumers nodes={[running, decommissioning, makeNode("lost", "LOST", 20)]} onOpen={onOpen} />);
    const rows = screen.getAllByTestId("top-consumer-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain("draining");
    fireEvent.click(rows[1]!);
    expect(onOpen).toHaveBeenCalledWith(decommissioning);
  });
});
