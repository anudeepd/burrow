import { expect, test } from "@playwright/test";

test.describe("progress indicators", () => {
  test("keeps percentage readouts aligned across Applications and Overview", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("burrow.prefs.v1", JSON.stringify({ livePaused: true, tz: "utc" }));
    });

    await page.goto("/apps?states=RUNNING");
    const appBar = page.getByRole("progressbar", { name: /^Progress / }).first();
    await expect(appBar).toBeAttached();
    const appValue = appBar.locator("xpath=following-sibling::*[1]");
    const appMeasurement = await appValue.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      text: element.textContent?.trim(),
    }));
    expect(appMeasurement.width).toBe(48);
    expect(appMeasurement.text).toMatch(/^\d+\.\d%$/);

    await page.goto("/");
    const activeBar = page.getByRole("progressbar", { name: /complete$/ }).first();
    await expect(activeBar).toBeAttached();
    const activeValue = activeBar.locator("xpath=following-sibling::*[1]");
    const activeMeasurement = await activeValue.evaluate((element) => element.getBoundingClientRect().width);
    const activeTrackWidth = await activeBar.evaluate((element) => element.getBoundingClientRect().width);
    expect(activeMeasurement).toBe(48);
    expect(activeTrackWidth).toBeGreaterThan(32);

    const nodeBar = page.getByRole("progressbar", { name: /Physical memory utilization on/ }).first();
    await expect(nodeBar).toBeAttached();
    const nodeValue = nodeBar.locator("xpath=following-sibling::*[1]");
    const nodeMeasurement = await nodeValue.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      text: element.textContent?.trim(),
    }));
    expect(nodeMeasurement.width).toBe(48);
    expect(nodeMeasurement.text).toMatch(/^\d+\.\d%$/);
  });

  test("uses one transition duration for standard and share-bar fills", async ({ page }) => {
    await page.goto("/nodes");
    const threadFill = page.locator(".burrow-thread-fill").first();
    const shareFill = page.locator(".burrow-bar").first();
    await expect(threadFill).toBeAttached();
    await expect(shareFill).toBeAttached();

    const baseDuration = await page.locator("html").evaluate((element) => {
      const token = getComputedStyle(element).getPropertyValue("--dur-base").trim();
      const value = Number.parseFloat(token);
      return `${token.endsWith("ms") ? value / 1000 : value}s`;
    });
    const durations = await Promise.all(
      [threadFill, shareFill].map((element) => element.evaluate((node) => getComputedStyle(node).transitionDuration)),
    );
    expect(baseDuration).not.toBe("");
    expect(durations).toEqual([baseDuration, baseDuration]);
  });
  test("node utilization strips use the shared animated fill", async ({ page }) => {
    await page.goto("/nodes");
    const fill = page.locator('[data-yf="node.memUtilization"] .burrow-bar').first();
    await expect(fill).toBeVisible();
    const baseDuration = await page.locator("html").evaluate((element) => {
      const token = getComputedStyle(element).getPropertyValue("--dur-base").trim();
      const value = Number.parseFloat(token);
      return `${token.endsWith("ms") ? value / 1000 : value}s`;
    });
    await expect(fill).toHaveCSS("transition-duration", baseDuration);
  });

  test("respects reduced motion for standard, share, and segmented fills", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/nodes");
    const threadFill = page.locator(".burrow-thread-fill").first();
    const shareFill = page.locator(".burrow-bar").first();
    await expect(threadFill).toBeAttached();
    await expect(shareFill).toBeAttached();
    await expect(threadFill).toHaveCSS("transition-duration", "0s");
    await expect(shareFill).toHaveCSS("transition-duration", "0s");

    await page.goto("/apps/application_1791010000001_0001/spark/stages");
    await expect(page.locator('.burrow-thread[data-segments="true"] > span').first()).toHaveCSS("transition-duration", "0s");
  });
});
