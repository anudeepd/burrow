import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DagView } from "./DagView";
import type { Dag } from "../types";

const { downloadSpy } = vi.hoisted(() => ({ downloadSpy: vi.fn() }));
vi.mock("~/ui/data-table/export", () => ({ download: downloadSpy }));

const DAG = JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures/spark/4.2.0/barrier-scopes/dag-job-2.json"), "utf8")) as Dag;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) }),
  });
});

afterEach(() => {
  cleanup();
  downloadSpy.mockClear();
});

describe("DagView HTML export", () => {
  it("keeps the complete source DAG and rendered graph metadata in the downloadable snapshot", { timeout: 30_000 }, async () => {
    render(<DagView dag={DAG} height={400} ariaLabel="Barrier job DAG" />);
    const canvas = await screen.findByTestId("dag-canvas");
    await waitFor(() => expect(canvas.getAttribute("data-dag-layout")).toBe("ready"), { timeout: 10_000 });

    fireEvent.click(screen.getByRole("button", { name: "Download interactive DAG snapshot (HTML)" }));
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledOnce());

    const [filename, mime, html] = downloadSpy.mock.calls[0] as [string, string, string];
    expect(filename).toBe("barrier-job-dag.html");
    expect(mime).toBe("text/html");
    expect(html).toContain("Complete DAG, layout, and metrics data");

    const document = new DOMParser().parseFromString(html, "text/html");
    const metadata = document.querySelector("svg metadata#burrow-dagviz-export");
    expect(metadata).not.toBeNull();
    const data = JSON.parse(metadata!.textContent ?? "{}") as { sourcePayload: Dag; dagViz: { graph: { nodes: unknown[] } } };
    expect(data.sourcePayload).toEqual(DAG);
    expect(data.dagViz.graph.nodes.length).toBeGreaterThan(0);
    expect(document.title).toContain("Barrier job DAG");
  });
});
