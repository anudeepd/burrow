import { expect, test, type Page } from "@playwright/test";
import NODES_SAMPLE from "../src/api/schemas/samples/nodes.json" with { type: "json" };

const PREFS_KEY = "burrow.prefs.v1";
const nodesTable = (page: Page) => page.locator('[data-burrow-table="burrow.nodes"]');

test("fades the Nodes rows in when initial data arrives", async ({ page }) => {
  await page.addInitScript((key: string) => {
    localStorage.setItem(key, JSON.stringify({ livePaused: true, liveIntervalMs: 30000 }));
  }, PREFS_KEY);
  const firstNode = NODES_SAMPLE.nodes.node[0];
  if (!firstNode) throw new Error("The nodes sample must include a node");
  const body = nodesTable(page).locator('[role="rowgroup"]').nth(1);
  let releaseResponse = () => {};
  const responseHeld = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/yarn/nodes",
    async (route) => {
      await responseHeld;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
        json: NODES_SAMPLE,
      });
    },
  );

  try {
    await page.goto("/nodes");
    await expect(page.getByRole("status", { name: "Loading" })).toBeVisible({ timeout: 5000 });
    await expect(body).toHaveCSS("opacity", "0");
    await body.evaluate((element) => {
      element.addEventListener("transitionrun", (event) => {
        if (event.target === element && (event as TransitionEvent).propertyName === "opacity") {
          element.setAttribute("data-e2e-opacity-transition", "started");
        }
      });
    });
  } finally {
    releaseResponse();
  }
  await expect(page.locator(`[role="row"][data-ye="${firstNode.id}"]`)).toBeVisible();
  await expect(body).toHaveAttribute("data-e2e-opacity-transition", "started");
});
