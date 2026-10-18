/**
 * Node labels — the legacy `/cluster/nodelabels` contract (Label Name · Label Type · Num Of Active NMs · Total Resource),
 * the derived DEFAULT partition, the per-label node list, and the read-only mapping matrix.
 */
import { expect, test } from "@playwright/test";

test.describe("node labels", () => {
  test("catalogue mirrors the legacy page and stamps labels for parity", async ({ page }) => {
    const labelsResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/yarn/get-node-labels");
    await page.goto("/node-labels?parity=1");
    const labelsResponse = await labelsResponsePromise;
    expect(labelsResponse.ok()).toBe(true);
    const labelsPayload = (await labelsResponse.json()) as {
      nodeLabelInfo?: {
        name: string;
        partitionInfo?: { resourceAvailable?: { memory?: number } };
      }[];
    };
    const expectedAvailableMemory = labelsPayload.nodeLabelInfo?.find((label) => label.name === "gpu")?.partitionInfo?.resourceAvailable
      ?.memory;
    await expect(page.getByRole("heading", { name: "Node labels", level: 1 })).toBeVisible();

    const headers = (await page.locator('[role="columnheader"]').allInnerTexts()).map((t) => t.trim());
    for (const label of ["Label Name", "Label Type", "Num Of Active NMs", "Partition resources"]) {
      expect(headers, `missing legacy column ${label}`).toContain(label);
    }

    const labelNames = await page
      .locator('[data-burrow-table="burrow.node-labels"] [role="row"][data-ye]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.ye));
    // Label catalogue and membership share the generated cluster: gpu + highmem, plus DEFAULT from unlabelled nodes.
    expect(labelNames.sort()).toEqual(["", "gpu", "highmem"]);

    const gpuRow = page.locator('[data-burrow-table="burrow.node-labels"] [role="row"][data-ye="gpu"]');
    await expect(gpuRow.locator('[data-yf="nodelabel.name"][data-yv="gpu"]')).toBeVisible();
    await expect(gpuRow.locator('[data-yf="nodelabel.exclusivity"][data-yv="true"]')).toBeVisible();
    await expect(gpuRow.locator('[data-yf="nodelabel.activeNMs"][data-yv="1"]')).toBeVisible();
    const availableMemoryRaw = await gpuRow.locator('[data-yf="nodelabel.partitionInfo.resourceAvailable.memory"]').getAttribute("data-yv");
    expect(availableMemoryRaw).not.toBeNull();
    // Compare the parity stamp with the response that populated the catalogue; availability changes with running workloads.
    expect(Number(availableMemoryRaw)).toBe(expectedAvailableMemory);
    await expect(page.getByText("Exclusive Partition").first()).toBeVisible();
    await expect(page.getByText("Non Exclusive Partition").first()).toBeVisible();
  });

  test("opening a label lists its nodes and links through to their detail", async ({ page }) => {
    await page.goto("/node-labels?open=gpu&parity=1");
    await expect(page.getByRole("heading", { name: /Nodes in/ })).toBeVisible();
    const gpuNodeId = "node-r1-01.mock.local:45454";
    const gpuNode = page.locator(`[data-ye="${gpuNodeId}"]`);
    await expect(gpuNode.locator('[data-yf="node.id"]')).toBeVisible();

    // Membership rows identify nodes; the page's supported navigation is via its label-filter link and node table.
    await page.getByRole("link", { name: "Filter the node table by this label" }).click();
    await expect(page).toHaveURL(/\/nodes\?label=gpu/);
    await page.locator(`[data-ye="${gpuNodeId}"] a[href*="/nodes/"]`).click();
    await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname)).toBe(`/nodes/${gpuNodeId}`);
    await expect(page.locator('[data-yf="node.id"]').first()).toHaveAttribute("data-yv", gpuNodeId);
  });

  test("mapping view is explicitly read-only and shows the matrix", async ({ page }) => {
    await page.goto("/node-labels?view=mapping&parity=1");
    await expect(page.getByText(/Read-only/i).first()).toBeVisible();
    const boxes = page.locator('[data-burrow-table="burrow.node-labels.mapping"] input[type="checkbox"]');
    expect(await boxes.count()).toBeGreaterThan(0);
    expect(await boxes.first().isDisabled()).toBe(true);
    await expect(page.getByLabel("gpu on node-r1-01.mock.local:45454 (read-only)")).toBeChecked();
  });
  test("switching between the label catalogue and mapping fades the visualization", async ({ page }) => {
    await page.goto("/node-labels");
    await expect(page.locator('[data-burrow-table="burrow.node-labels"]')).toBeVisible();

    const fade = page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".burrow-tab-content")).some((element) =>
        element.getAnimations().some((animation) => {
          const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
          return animation.playState === "running" && Number(frames[0]?.opacity) === 0 && Number(frames[frames.length - 1]?.opacity) === 1;
        }),
      ),
    );
    await page.getByRole("button", { name: "Node to label mapping" }).click();
    expect(await (await fade).jsonValue()).toBe(true);
    await expect(page.getByText(/Read-only/i).first()).toBeVisible();
  });

  test("screenshots: catalogue and mapping (dark + light)", async ({ page }) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/node-labels?open=gpu");
      await expect(page.getByRole("heading", { name: /Nodes in/ })).toBeVisible();
      await expect(page).toHaveScreenshot(`nodes/node-labels-${scheme}.png`);

      await page.goto("/node-labels?view=mapping");
      await expect(page.getByText(/Read-only/i).first()).toBeVisible();
      await expect(page).toHaveScreenshot(`nodes/node-labels-mapping-${scheme}.png`, { fullPage: true });
    }
  });
});
