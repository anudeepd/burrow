import { expect, test } from "@playwright/test";

test("hides table scrollbar chrome without disabling native scrolling", async ({ page }) => {
  await page.goto("/apps");
  const scrollport = page.locator('[data-burrow-table="apps"]');
  await expect(scrollport).toBeVisible();
  await expect.poll(() => scrollport.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  const style = await scrollport.evaluate((node) => {
    const el = node as HTMLElement;
    const scrollbar = getComputedStyle(el, "::-webkit-scrollbar");
    const style = getComputedStyle(el);
    return {
      width: scrollbar.width,
      display: scrollbar.display,
      scrollbarWidth: style.scrollbarWidth,
      scrollbarGutter: style.scrollbarGutter,
    };
  });

  expect(style.width).toBe("0px");
  expect(style.display).toBe("none");
  expect(style.scrollbarWidth).toBe("none");
  expect(style.scrollbarGutter).toBe("auto");

  await scrollport.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => scrollport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});

test("node labels remain scrollable on a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto("/node-labels");
  const scrollport = page.locator("main .burrow-page-scroll");
  await expect(page.locator('[data-burrow-table="burrow.node-labels"]')).toBeVisible();
  await expect.poll(() => scrollport.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0);

  await scrollport.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => scrollport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});

test("applications filters and rows remain reachable on a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto("/apps");

  const scrollport = page.locator("main .burrow-apps-page");
  const tableBody = page.locator('[data-burrow-table-root="apps"] .burrow-table-scroll');
  await expect(page.locator('[data-burrow-table="apps"]')).toBeVisible();
  await expect.poll(() => tableBody.evaluate((node) => node.clientHeight)).toBeGreaterThan(0);
  await expect.poll(() => scrollport.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0);

  await scrollport.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => scrollport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Export" })).toBeInViewport();
});
