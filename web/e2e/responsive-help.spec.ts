import { expect, test } from "@playwright/test";

const PREFS_KEY = "burrow.prefs.v1";
test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ livePaused: true, motion: "reduced" })), PREFS_KEY);
});

test("desktop column definitions work on hover and from the keyboard without sorting", async ({ page }) => {
  await page.goto("/apps");
  const header = page.locator('[data-burrow-table="apps"] [data-col="id"]').first();
  const help = header.getByRole("button", { name: "About ID", exact: true });
  await help.hover();
  await expect(page.getByRole("tooltip")).toContainText("Application id");
  await page.mouse.move(0, 0);
  await help.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog").filter({ hasText: "Application id" });
  await expect(dialog).toBeVisible();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await expect(page).not.toHaveURL(/sort=/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(help).toBeFocused();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("navigation closes after selecting a route and returns focus to its trigger", async ({ page }) => {
    await page.goto("/apps");
    const trigger = page.getByTestId("rail-toggle");
    await trigger.tap();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: /^Nodes(?:\s+[\d,]+)?$/ }).tap();
    await expect(page).toHaveURL(/\/nodes$/);
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("heading", { name: "Nodes", exact: true, level: 1 })).toBeVisible();
  });

  test("a column definition opens on tap, fits the viewport, and does not change the sort", async ({ page }) => {
    await page.goto("/apps");
    const help = page.getByRole("button", { name: "About ID", exact: true });
    await help.tap();
    const dialog = page.getByRole("dialog").filter({ hasText: "Application id" });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(page).not.toHaveURL(/sort=/);
    await expect(dialog).toHaveScreenshot("mobile/apps-help-dialog.png");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
