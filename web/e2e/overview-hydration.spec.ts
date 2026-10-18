import { expect, test } from "@playwright/test";

test("Overview hydrates without a React mismatch", async ({ page }) => {
  const hydrationErrors: string[] = [];
  const recordHydrationError = (message: string) => {
    if (/hydration failed|minified react error #418|cannot be a descendant|cannot contain a nested|hydration error/i.test(message)) {
      hydrationErrors.push(message);
    }
  };

  page.on("pageerror", (error) => recordHydrationError(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") recordHydrationError(message.text());
  });

  await page.goto("/");
  await expect(page.getByTestId("overview")).toBeVisible();
  await page.waitForFunction(() => ["local", "utc"].includes(document.documentElement.dataset.tz ?? ""));

  expect(hydrationErrors).toEqual([]);
});
