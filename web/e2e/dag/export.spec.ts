import { expect, test } from "@playwright/test";
import { serializeDagHtml } from "../../src/features/dag/export-html";

test("standalone DagViz HTML export shows SQL metrics and plan line on node selection", async ({ page }) => {
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

  await page.setContent(serializeDagHtml(svg, "SQL plan for execution 15"));
  await expect(page.locator("script")).toHaveCount(1);
  const fullData = (await page.locator("#full-data").textContent()) ?? "";
  expect(fullData).toContain('"name": "number of output rows"');
  expect(fullData).toContain('"value": "50"');
  expect(await page.locator("#raw-plan").textContent()).toBe(planLine);

  await page.locator('#dag-canvas svg [data-node-id="sql.15"] rect').click();
  const inspector = page.locator("#inspect");
  await expect(page.locator("#inspect-title")).toHaveText("Range");
  await expect(inspector).toContainText("physical operator");
  await expect(inspector).toContainText("SQL plan metrics");
  await expect(inspector).toContainText("operator accumulables from the SQL plan — not stage task counters");
  await expect(inspector).toContainText("number of output rows");
  await expect(inspector).toContainText("50");
  await expect(inspector).toContainText("Plan line");
  await expect(inspector).toContainText(planLine);
  await expect(inspector.locator(".metric-table tbody tr")).toHaveCount(1);
});
