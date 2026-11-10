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

    const retry = page.getByRole("button", { name: "Retry now" });
    await expect(retry).toBeVisible();

    recover();
    await retry.click();
    await expect(page.getByRole("button", { name: "Retry now" })).toHaveCount(0);
    await expect(page.getByText(/rows$/).first()).toBeVisible();
  });

  test("expanded technical details survive polling and copy without moving the payload", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await failUntilRetry(page, "/api/yarn/nodes");
    await page.goto("/nodes");

    const alert = page.getByRole("alert").filter({ has: page.getByRole("heading", { name: "Cannot read the node list" }) });
    await expect(alert).toBeVisible();
    await alert.getByText("Technical details").click();
    const pre = alert.locator("pre");
    await expect(pre).toBeVisible();
    const wrapper = alert.locator("xpath=./details/div[1]");
    await expect(wrapper).toHaveCSS("transition-property", "grid-template-rows");
    await expect(wrapper).toHaveCSS("transition-duration", "0.24s");
    await page.waitForTimeout(320);
    const beforePoll = await pre.boundingBox();

    // The node query polls live; the error and its expanded panel must not remount and collapse.
    await page.waitForTimeout(3_500);
    await expect(alert).toBeVisible();
    await expect(pre).toBeVisible();
    const afterPoll = await pre.boundingBox();
    expect(beforePoll).not.toBeNull();
    expect(afterPoll).not.toBeNull();
    expect(Math.abs((afterPoll!.width ?? 0) - (beforePoll!.width ?? 0))).toBeLessThan(1);

    const copy = alert.getByRole("button", { name: "Copy technical details" });
    await copy.click();
    await expect(copy).toContainText("Copied");
    const afterCopy = await pre.boundingBox();
    expect(afterCopy).not.toBeNull();
    expect(Math.abs((afterCopy!.width ?? 0) - (afterPoll!.width ?? 0))).toBeLessThan(1);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("upstream_unreachable");

    // Collapse keeps the payload mounted for the row animation, then removes it.
    await alert.locator("summary").click();
    await expect(wrapper).toHaveClass(/grid-rows-\[0fr\]/);
    await expect(pre).toBeVisible();
    await expect(pre).toBeHidden();
  });

  test("a failed Spark page keeps its expanded details open across the live poll", async ({ page }) => {
    const spark = "application_1791010000001_0005";
    await failUntilRetry(page, `/api/spark/${spark}/jobs`);
    await page.goto(`/apps/${spark}/spark/jobs`);

    const alert = page.getByRole("alert").filter({ has: page.getByRole("heading", { name: "The Spark source is unreachable" }) });
    await expect(alert).toBeVisible();
    await alert.getByText("Technical details").click();
    await expect(alert.locator("pre")).toBeVisible();

    // React Query resets error -> pending at the start of the live refetch; the panel must survive it.
    await page.waitForTimeout(3_500);
    await expect(alert).toBeVisible();
    await expect(alert.locator("pre")).toBeVisible();
  });

  test("bounds a long failure message and scrolls its payload", async ({ page }) => {
    const long = "java.lang.IllegalStateException: the ResourceManager did not answer. ".repeat(40);
    await page.route("**/api/yarn/nodes*", (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "upstream_unreachable", message: long, hint: long } }),
      }),
    );
    await page.goto("/nodes");

    const alert = page.getByRole("alert").first();
    await expect(alert).toBeVisible();
    const message = alert.locator("p").first();
    expect(await message.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    await alert.getByText("Technical details").click();
    const pre = alert.locator("pre");
    await expect(pre).toBeVisible();
    await page.waitForTimeout(320);
    const payload = await pre.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    expect(payload.client).toBeLessThanOrEqual(288);
    expect(payload.scroll).toBeGreaterThan(payload.client);
  });
});
