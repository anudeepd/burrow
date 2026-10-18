/**
 * `/tools/conf` — the ResourceManager configuration page (the legacy "Tools → Configuration", modernised).
 *
 * The page is a 1 709-row virtualized table over the real captured `/conf` payload the dev mock serves, so these specs also
 * assert the parity contract (`data-yf`/`data-yv`) and the URL state (search, overridden/final/source filters, expanded
 * property). The render-time test runs the SAME table in parity mode — no virtualization, every row in the DOM — and reports
 * the time from document start to those rows being painted: the honest upper bound for the un-virtualized case.
 */
import { type Page, expect, test } from "@playwright/test";

/**
 * Screenshots land on the exact acceptance path (`e2e/__screenshots__/tools/<name>.png`); Playwright's default template
 * would nest a directory per spec file. `expected` assertions run before the shot, so a broken page cannot produce a
 * plausible-looking artifact.
 */
async function shoot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(`tools/${name}`);
}

const TABLE = "[data-burrow-table='burrow.tools.conf']";
const SEARCH = 'input[aria-label="Search configuration"]';
const SOURCE = '[aria-label="Source filter"]';

test.describe("RM configuration", () => {
  test("shows capability and service status before the long properties table on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/tools/conf");
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "1709", { timeout: 30_000 });

    const capabilities = page.getByTestId("Burrow-capabilities");
    const properties = page.locator(TABLE);
    await expect(capabilities.getByRole("heading", { name: "Capabilities" })).toBeVisible();
    const summaryBox = await capabilities.boundingBox();
    const tableBox = await properties.boundingBox();
    expect(summaryBox).not.toBeNull();
    expect(tableBox).not.toBeNull();
    expect(summaryBox!.y + summaryBox!.height).toBeLessThanOrEqual(tableBox!.y);
  });

  test("searches by key or value, filters by source, and expands a property", async ({ page }) => {
    await page.goto("/tools/conf");
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "1709", { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Configuration" })).toBeVisible();

    // name search → one row, raw value stamped for the parity harness
    await page.locator(SEARCH).fill("scheduler.class");
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "1");
    const key = page.locator('[data-yf="conf.key"][data-yv="yarn.resourcemanager.scheduler.class"]');
    await expect(key).toBeVisible();
    await expect(page.locator('[data-yf="conf.value"]').first()).toHaveAttribute("data-yv", /CapacityScheduler/);
    await expect(page).toHaveURL(/q=scheduler\.class/);

    // The table activates property details from its row; the key datum is not itself a control.
    const row = page.getByRole("row").filter({ has: key });
    await row.click();
    const detail = page.locator('[data-burrow-conf-detail="yarn.resourcemanager.scheduler.class"]');
    await expect(detail).toBeVisible();
    await expect(detail.getByRole("link", { name: "Scheduler" })).toHaveAttribute("href", "/scheduler");
    await expect(page).toHaveURL(/open=yarn\.resourcemanager\.scheduler\.class/);

    // overridden + final filters (and the empty state they can produce)
    await page.locator(SEARCH).fill("");
    await page.getByRole("button", { name: "Show only overridden properties" }).click();
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "77");
    await page.getByRole("button", { name: "Show only final properties" }).click();
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "0");
    await expect(page.getByText("No property matches these filters")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "1709");

    // source filter: the Select carries the real distinct resources with their counts
    await page.locator(SOURCE).click();
    const yarnSite = page.getByRole("option", { name: "yarn-site.xml (40)" });
    await expect(yarnSite).toBeVisible();
    await yarnSite.click();
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "40");
    await expect(page).toHaveURL(/resource=yarn-site\.xml/);

    // a redacted value is shown as redacted, never as a value (deep link: the filter is in the URL)
    await page.goto("/tools/conf?q=hadoop.security.sensitive-config-keys");
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "1", { timeout: 30_000 });
    await expect(page.locator('[data-yf="conf.value"][data-yv="<redacted>"]')).toBeVisible();
  });

  test("renders the full 1 709-row table un-virtualized in parity mode and measures it", async ({ page }) => {
    await page.goto("/tools/conf?parity=1");
    await page.waitForFunction(
      () => document.querySelector("[data-burrow-table='burrow.tools.conf']")?.getAttribute("data-burrow-rows") === "1709",
      undefined,
      { timeout: 90_000 },
    );
    await expect(page.locator(`${TABLE} [data-ye]`)).toHaveCount(1709, { timeout: 90_000 });
    // navigation start → now, measured in the page, after every row is in the DOM
    const painted = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation").find((e): e is PerformanceNavigationTiming => e.entryType === "navigation");
      return performance.now() - (nav?.startTime ?? 0);
    });
    console.log(`[conf render] 1709 rows, parity mode (no virtualization) painted ${Math.round(painted)} ms after document start`);
    expect(painted).toBeLessThan(120_000);
    await expect(page.getByText("1,709 rows", { exact: false })).toBeVisible();
  });

  test("shows the NodeManager's own configuration when ?host= is set, with a way back to the RM", async ({ page }) => {
    await page.goto("/tools/conf?host=127.0.0.2:8042");
    await expect(page.getByRole("heading", { name: "NodeManager 127.0.0.2:8042 configuration" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link", { name: "ResourceManager configuration" })).toHaveAttribute("href", "/tools/conf");
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "1091", { timeout: 30_000 });
  });

  test("dark", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/tools/conf");
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "1709", { timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(`${TABLE} [data-ye]`).first()).toBeInViewport();
    await shoot(page, "conf-dark.png");
  });

  test("light", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/tools/conf");
    await expect(page.locator(TABLE)).toHaveAttribute("data-burrow-rows", "1709", { timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator(`${TABLE} [data-ye]`).first()).toBeInViewport();
    await shoot(page, "conf-light.png");
  });
});
