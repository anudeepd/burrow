import { expect, test, type Locator } from "@playwright/test";

const SPARK_DAG = "application_1791010000001_0002";

async function expectNoToolbarOverlap(status: Locator, edgeControl: Locator) {
  const overlap = await status.evaluate(
    (element, edge) => {
      const statusBox = element.getBoundingClientRect();
      const edgeBox = (edge as Element).getBoundingClientRect();
      return {
        overlaps:
          statusBox.width > 0 &&
          statusBox.height > 0 &&
          edgeBox.width > 0 &&
          edgeBox.height > 0 &&
          statusBox.left < edgeBox.right &&
          statusBox.right > edgeBox.left &&
          statusBox.top < edgeBox.bottom &&
          statusBox.bottom > edgeBox.top,
        status: { left: statusBox.left, right: statusBox.right },
        edge: { left: edgeBox.left, right: edgeBox.right },
      };
    },
    await edgeControl.elementHandle(),
  );

  expect(overlap.overlaps, `DAG status ${JSON.stringify(overlap.status)} overlaps Edges ${JSON.stringify(overlap.edge)}`).toBe(false);
}

test("Job DAG toolbar status stays clear of the Edges control at tablet width", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`/apps/${SPARK_DAG}/spark/jobs/2?expand=1`);

  const canvas = page.getByTestId("dag-canvas");
  await expect(canvas).toHaveAttribute("data-dag-layout", "ready", { timeout: 20_000 });
  const pane = await canvas.boundingBox();
  expect(pane, "Job DAG canvas should be rendered").not.toBeNull();
  expect(pane!.width, "expanded navigation should leave a narrow tablet pane").toBeLessThan(600);

  const status = canvas.locator(".burrow-dag-toolbar > span").last();
  const edgeControl = canvas.locator(".burrow-dag-edge-menu button");
  await expect(status).toBeHidden();
  await expect(edgeControl).toBeVisible();
  await expectNoToolbarOverlap(status, edgeControl);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(status).toBeVisible();
  await expectNoToolbarOverlap(status, edgeControl);
});
