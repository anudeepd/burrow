import { expect, test } from "@playwright/test";

test.describe("virtualized tool table scrolling", () => {
  for (const { name, path, selector } of [
    { name: "JMX", path: "/tools/jmx", selector: '[data-burrow-jmx-tree="1"]' },
    { name: "Stacks", path: "/tools/stacks", selector: "[data-burrow-stacks-rows]" },
  ]) {
    test(`${name} hides browser scrollbars and fades clipped rows`, async ({ page }) => {
      await page.goto(path);
      const tree = page.locator(selector);
      await expect(tree).toBeVisible();
      await expect(tree).toHaveClass(/burrow-table-scroll/);
      await expect(page.locator(".burrow-table-bottom-fade")).toHaveAttribute("data-visible", "true");

      const style = await tree.evaluate((el) => {
        const computed = getComputedStyle(el);
        return { scrollbarWidth: computed.scrollbarWidth, scrollbarGutter: computed.scrollbarGutter };
      });
      expect(style).toEqual({ scrollbarWidth: "none", scrollbarGutter: "auto" });
    });
  }
});
