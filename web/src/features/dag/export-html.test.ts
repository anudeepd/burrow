import { Browser } from "happy-dom";
import { describe, expect, it } from "vitest";
import { serializeDagHtml } from "./export-html";

describe("standalone DagViz HTML export", () => {
  it("bundles SQL plan metrics and shows them with the plan line when a node is clicked", async () => {
    const planLine = "Range [codegen id : 1]\nOutput [1]: [id#205L]\nArguments: Range (0, 50, step=1, splits=Some(4))";
    const metrics = [{ name: "number of output rows", value: "50" }];
    const data = {
      sourcePayload: {
        status: "COMPLETED",
        planDescription: planLine,
        nodes: [{ nodeId: 15, nodeName: "Range", metrics }],
      },
      dagViz: {
        graph: {
          nodes: [{ id: "sql.15", label: "Range", kind: "sql", ref: 15, detail: planLine, metrics }],
          edges: [],
        },
        scene: {
          nodes: [{ node: { id: "sql.15" }, badges: [] }],
          edges: [],
          totals: { done: 0, total: 0 },
        },
      },
    };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"><metadata id="burrow-dagviz-export">${JSON.stringify(data)}</metadata><g class="burrow-dag-node" data-node-id="sql.15"><rect width="40" height="20" /></g></svg>`;
    const html = serializeDagHtml(svg, "SQL plan for execution 15");
    const browser = new Browser({ settings: { enableJavaScriptEvaluation: true } });
    try {
      const page = browser.newPage();
      page.content = html;
      await page.waitUntilComplete();
      const { document, window } = page.mainFrame;
      const script = document.querySelector("script");
      expect(script).not.toBeNull();

      const fullData = document.querySelector("#full-data")?.textContent ?? "";
      expect(fullData).toContain('"name": "number of output rows"');
      expect(fullData).toContain('"value": "50"');
      expect(document.querySelector("#raw-plan")?.textContent).toBe(planLine);

      const canvas = document.querySelector("#dag-canvas")!;
      const nodeRect = document.querySelector('#dag-canvas svg [data-node-id="sql.15"] rect')!;
      Object.defineProperty(canvas, "setPointerCapture", { configurable: true, value: () => {} });
      const mouseEvent = (type: string) =>
        new window.MouseEvent(type, { bubbles: true, clientX: 20, clientY: 20 }) as unknown as Parameters<typeof nodeRect.dispatchEvent>[0];
      const pointerDown = mouseEvent("pointerdown");
      Object.defineProperties(pointerDown, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
      nodeRect.dispatchEvent(pointerDown);
      canvas.dispatchEvent(mouseEvent("pointerup"));
      // Pointer capture retargets the browser's click from the SVG node to the canvas element.
      canvas.dispatchEvent(mouseEvent("click"));

      const inspector = document.querySelector("#inspect");
      const inspectorText = inspector?.textContent ?? "";
      expect(document.querySelector("#inspect-title")?.textContent).toBe("Range");
      expect(inspectorText).toContain("physical operator");
      expect(inspectorText).toContain("SQL plan metrics");
      expect(inspectorText).toContain("operator accumulables from the SQL plan — not stage task counters");
      expect(inspectorText).toContain("number of output rows");
      expect(inspectorText).toContain("50");
      expect(inspectorText).toContain("Plan line");
      expect(inspectorText).toContain(planLine);
      expect(inspector?.querySelectorAll(".metric-table tbody tr")).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });
});
