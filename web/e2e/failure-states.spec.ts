/** Regression coverage for API failures that previously looked like empty data or an indefinitely loading panel. */
import { expect, test } from "@playwright/test";

const APP = "application_1791010984040_0001";
const SPARK_APP = "application_1791010000001_0001";

async function failUntilRetry(page: import("@playwright/test").Page, path: string) {
  let recovered = false;
  await page.route(
    (url) => url.pathname === path,
    (route) => {
      if (recovered) return route.continue();
      return route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "upstream_unreachable", message: "The test upstream is unavailable." } }),
      });
    },
  );
  return () => {
    recovered = true;
  };
}

test.describe("retryable API failure states", () => {
  test("node label membership explains and retries a failed node-list request", async ({ page }) => {
    const recover = await failUntilRetry(page, "/api/yarn/nodes");
    await page.goto("/node-labels?view=mapping");

    const alert = page.getByRole("alert");
    await expect(alert.getByRole("heading", { name: "Cannot read nodes for label membership" })).toBeVisible();
    await expect(alert.getByRole("button", { name: "Retry now" })).toBeVisible();

    recover();
    await alert.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByRole("heading", { name: "Node to label mapping" })).toBeVisible();
    await expect(page.getByLabel("gpu on node-r1-01.mock.local:45454 (read-only)")).toBeChecked();
  });

  test("container picker keeps manual access and retries a failed attempt lookup", async ({ page }) => {
    const recover = await failUntilRetry(page, `/api/yarn/apps/${APP}/appattempts`);
    await page.goto(`/apps/${APP}/logs`);

    const alert = page.getByRole("alert").filter({ has: page.getByRole("heading", { name: "Could not load application attempts" }) });
    await expect(alert.getByRole("heading", { name: "Could not load application attempts" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Container id" })).toBeVisible();

    recover();
    await alert.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByRole("heading", { name: "ApplicationMaster containers" })).toBeVisible();
  });

  test("NodeManager detail failure gives a local retry", async ({ page }) => {
    const recover = await failUntilRetry(page, "/api/nm/127.0.0.3:8042/info");
    await page.goto("/nodes/127.0.0.3%3A8041");

    const alert = page.getByRole("alert").filter({ has: page.getByRole("heading", { name: "Cannot read the NodeManager" }) });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("button", { name: "Retry now" })).toBeVisible();

    recover();
    await alert.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByText("NM version", { exact: true })).toBeVisible();
  });

  test("NodeManager log discovery explains and retries a failed log listing", async ({ page }) => {
    const container = "container_1791010984040_0014_01_000002";
    const path = `/api/logs/containers/${container}`;
    let recovered = false;
    await page.route(
      (url) => url.pathname === path,
      (route) => {
        if (recovered) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            json: { source: "nm", node: "127.0.0.3:8042", files: [] },
          });
        }
        return route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "upstream_unreachable", message: "The test NodeManager is unavailable." } }),
        });
      },
    );
    await page.goto("/nodes/127.0.0.3%3A8041");

    const alert = page.getByRole("alert").filter({ has: page.getByRole("heading", { name: "Could not check NodeManager logs" }) });
    await expect(alert).toBeVisible();
    recovered = true;
    await alert.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByText(`Source nm for container ${container}`)).toBeVisible();
  });

  test("partial Spark timeline data can retry its failed source", async ({ page }) => {
    const recover = await failUntilRetry(page, `/api/spark/${SPARK_APP}/jobs`);
    await page.goto(`/apps/${SPARK_APP}/spark/timeline`);

    const retry = page.getByRole("button", { name: "Retry failed sources" });
    await expect(retry).toBeVisible();

    recover();
    await retry.click();
    await expect(page.getByRole("button", { name: "Retry failed sources" })).toHaveCount(0);
    await expect(page.getByText(/rows$/).first()).toBeVisible();
  });
});
