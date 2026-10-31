/**
 * `/tools/logs` — the daemon's own log files, paged by byte range over the captured listing and deterministic sanitized
 * log sample the dev mock serves. The viewer reads ONE window at a time, so these specs pin the window boundaries, the
 * download URL, the in-window search stepper and the honest "the backend does not serve this endpoint" state.
 */
import { type Page, expect, test } from "@playwright/test";

/**
 * Screenshots land on the exact acceptance path (`e2e/__screenshots__/tools/<name>.png`); Playwright's default template
 * would nest a directory per spec file. Assertions run before the shot, so a broken page cannot produce an artifact.
 */
async function shoot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(`tools/${name}`);
}

const FILE_ROW = (name: string) => `tr[data-ye='${name}']`;
const SEARCH = 'input[aria-label="Search inside this window"]';

test.describe("local logs", () => {
  test("lists the files, pages by byte range and jumps to either end", async ({ page }) => {
    await page.goto("/tools/logs");

    // file list: name, human size, epoch time — and the newest file is selected by default
    await expect(page.locator(FILE_ROW("resourcemanager.log"))).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(FILE_ROW("rm.out"))).toBeVisible();
    await expect(page.locator('[data-yf="log.size"][data-yv="348349"]')).toBeVisible();
    await expect(page.locator('[data-yf="log.lastModified"][data-yv="1791901814000"]')).toBeVisible();
    await expect(page).toHaveURL(/file=resourcemanager\.log/);

    // the list is sortable: a new key starts descending, the second click reverses it
    await page.getByRole("button", { name: "Size" }).click();
    await expect(page.locator("th[aria-sort='descending']")).toContainText("Size");
    await expect(page.locator("tbody tr").first()).toHaveAttribute("data-ye", "resourcemanager.log");
    await page.getByRole("button", { name: "Size" }).click();
    await expect(page.locator("th[aria-sort='ascending']")).toContainText("Size");
    await expect(page.locator("tbody tr").first()).toHaveAttribute("data-ye", "rm.out");

    // download is a plain same-origin link, no JS needed
    const download = page.locator('a[download="resourcemanager.log"]');
    await expect(download).toHaveAttribute("href", "/api/rm/logs/resourcemanager.log");

    // first window: [0, 131072) of 348 349 bytes
    await expect(page.getByText(/bytes 0–131,071 of 348,349 · 128 KiB/)).toBeVisible();
    await expect(page.locator("pre[role='log']")).toContainText("STARTUP_MSG", { timeout: 30_000 });
    await expect(page.locator("pre[role='log']")).toHaveAttribute("aria-label", /bytes 0–131,071 of 348,349/);

    // next page → the aligned second page, shown from the response headers
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/offset=131072/);
    await expect(page.getByText(/bytes 131,072–262,143 of 348,349 · 128 KiB/)).toBeVisible();

    // jump to the end lands on the same last page; jump to the start goes back
    await page.getByRole("button", { name: "Jump to the end of the file" }).click();
    await expect(page).toHaveURL(/offset=262144/);
    await page.getByRole("button", { name: "Jump to the start of the file" }).click();
    await expect(page.locator("pre[role='log']")).toContainText("STARTUP_MSG", { timeout: 30_000 });

    // tail mode keeps the end of the file in the window
    await page.getByRole("button", { name: "Follow new bytes to the end of the file" }).click();
    await expect(page).toHaveURL(/tail=(1|true)/);
    await expect(page.getByText(/of 348,349/).first()).toBeVisible();
    // …and the documented deep link (?tail=1) opens the same state
    await page.goto("/tools/logs?file=resourcemanager.log&tail=1");
    await expect(page.locator("pre[role='log']")).toContainText("Release request cache is cleaned up", { timeout: 30_000 });
  });

  test("searches inside the loaded window and steps through the matches", async ({ page }) => {
    await page.goto("/tools/logs?file=resourcemanager.log");
    await expect(page.locator("pre[role='log']")).toContainText("STARTUP_MSG", { timeout: 30_000 });

    await page.locator(SEARCH).fill("STARTUP_MSG");
    const counter = page.locator('span[aria-live="polite"] > span').first();
    await expect(counter).toHaveText(/^1 \/ \d+$/);
    const total = Number((await counter.textContent())?.split("/")[1]?.trim());
    expect(total, "STARTUP_MSG appears several times in the first 128 KiB of the deterministic RM log sample").toBeGreaterThanOrEqual(3);
    await expect(page.locator("mark[data-ansi-mark='0']")).toHaveAttribute("data-active", "true");

    // Enter steps forward, Shift+Enter back from the search input.
    await page.locator(SEARCH).press("Enter");
    await expect(counter).toHaveText(`2 / ${total}`);
    await expect(page.locator("mark[data-ansi-mark='1']")).toHaveAttribute("data-active", "true");
    await page.getByRole("button", { name: "Next match" }).click();
    await expect(counter).toHaveText(`3 / ${total}`);
    await page.locator(SEARCH).press("Shift+Enter");
    await expect(counter).toHaveText(`2 / ${total}`);
    // wraps around at both ends
    await page.getByRole("button", { name: "Previous match" }).click();
    await expect(counter).toHaveText(`1 / ${total}`);
    await page.getByRole("button", { name: "Previous match" }).click();
    await expect(counter).toHaveText(`${total} / ${total}`);

    // a query that matches nothing says so instead of pretending
    await page.locator(SEARCH).fill("no-such-token-in-this-log");
    await expect(counter).toHaveText("no match");
    await expect(page.locator("mark[data-ansi-mark]")).toHaveCount(0);
  });

  test("says exactly which endpoint is missing when the backend does not serve the listing", async ({ page }) => {
    await page.route("**/api/rm/logs", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found", message: "'logs' is not an exposed ResourceManager daemon resource" } }),
      }),
    );
    await page.goto("/tools/logs");
    await expect(page.getByText("This burrow backend does not expose local logs")).toBeVisible();
    await expect(page.getByText(/check the Burrow server version and retry/)).toBeVisible();
  });

  test("shows an actionable error when the ResourceManager does not expose its log directory", async ({ page }) => {
    await page.route("**/api/rm/logs", (route) =>
      route.fulfill({ status: 404, body: "Not Found", headers: { "x-burrow-upstream": "rm.example:8088" } }),
    );
    await page.goto("/tools/logs");

    await expect(page.getByRole("alert").getByRole("heading", { name: "Cannot read the daemon's log directory" })).toBeVisible();
    await expect(page.getByRole("alert").getByRole("button", { name: "Retry now" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading" })).toHaveCount(0);
  });

  test("shows a retryable message instead of leaving a failed discovery request loading", async ({ page }) => {
    await page.route("**/api/rm/logs", (route) => route.abort("timedout"));
    await page.goto("/tools/logs");

    await expect(page.getByRole("alert").getByRole("heading", { name: "Cannot read the daemon's log directory" })).toBeVisible();
    await expect(page.getByRole("alert").getByRole("button", { name: "Retry now" })).toBeVisible();
    await expect(page.locator(".burrow-skeleton")).toHaveCount(0);
  });

  test("dark", { tag: "@snapshot" }, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/tools/logs");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("pre[role='log']")).toContainText("STARTUP_MSG", { timeout: 30_000 });
    await shoot(page, "logs-dark.png");
  });

  test("light", { tag: "@snapshot" }, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/tools/logs");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("pre[role='log']")).toContainText("STARTUP_MSG", { timeout: 30_000 });
    await shoot(page, "logs-light.png");
  });
});
