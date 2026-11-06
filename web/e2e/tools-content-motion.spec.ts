import { expect, test } from "@playwright/test";

const resultPanes = [
  { name: "JMX tree", path: "/tools/jmx", ready: '[data-burrow-jmx-tree="1"]' },
  { name: "server stacks", path: "/tools/stacks", ready: "[data-burrow-stacks-rows]" },
  { name: "daemon log files", path: "/tools/logs", ready: 'tr[data-ye="resourcemanager.log"]' },
] as const;

test("custom tool result panes use the bounded page-entry movement", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });

  for (const pane of resultPanes) {
    await page.goto(pane.path);
    await expect(page.locator(pane.ready), `${pane.name} should finish loading`).toBeVisible({ timeout: 60_000 });
    const result = page.locator(".burrow-page-result-enter");
    await expect(result, `${pane.name} should mark its loaded result pane`).toHaveCount(1);
    await expect(result, `${pane.name} should move with the shared page-entry animation`).toHaveCSS(
      "animation-name",
      "burrow-page-content-shift",
    );
  }
});
test("custom tool result panes drop movement under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tools/jmx");
  await expect(page.locator('[data-burrow-jmx-tree="1"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".burrow-page-result-enter")).toHaveCSS("animation-name", "none");
});
