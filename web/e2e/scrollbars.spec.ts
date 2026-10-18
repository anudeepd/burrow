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
