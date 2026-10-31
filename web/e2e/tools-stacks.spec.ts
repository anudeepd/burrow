/**
 * E2E for `/tools/stacks` (Server stacks) against the dev mock, which replays the real 167 KB / 230-thread dump.
 *
 * Screenshots: `e2e/__screenshots__/tools/stacks-{dark,light}.png`.
 */
import { expect, test, type Page } from "@playwright/test";

/**
 * Screenshots must land on the exact acceptance path (`e2e/__screenshots__/tools/<name>.png`) — Playwright's default
 * snapshot template would nest them under a per-spec directory. Every assertion runs before the shot, so a broken page
 * cannot produce a plausible-looking artifact.
 */
async function shoot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(`tools/${name}`);
}

// The vite dev server transforms the whole app on first request; on a loaded machine hydration can take tens of seconds.
test.describe.configure({ timeout: 120_000 });

/** Navigate and wait for the page's own root marker, so every later assertion runs against a rendered page. */
async function openStacks(page: Page, path: string) {
  await page.goto(path);
  await page.waitForSelector('[data-burrow-stacks-root="1"]', { timeout: 60_000 });
}

test.describe("/tools/stacks", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`renders the thread dump (${scheme})`, { tag: "@snapshot" }, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-10-03T12:04:09.000Z"));
      await page.emulateMedia({ colorScheme: scheme });
      await openStacks(page, "/tools/stacks");
      await expect(page.getByRole("heading", { name: "Server stacks" })).toBeVisible();
      await expect(page.locator('[data-burrow-stacks-root="1"]')).toBeVisible();
      const tree = page.locator("[data-burrow-stacks-rows]");
      await expect(tree).toHaveClass(/burrow-table-scroll/);
      await expect(page.locator(".burrow-table-bottom-fade")).toHaveAttribute("data-visible", "true");
      expect(await tree.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("none");
      // 230 threads collapse to 230 rows; the caption proves both the parse and the state histogram.
      await expect(page.getByText("230 threads · 230 rows")).toBeVisible();
      await expect(page.locator("[data-burrow-stacks-rows]")).toHaveAttribute("data-burrow-stacks-rows", "230");
      await expect(page.getByRole("button", { name: /^TIMED_WAITING 186$/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^RUNNABLE 26$/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^WAITING 18$/ })).toBeVisible();

      await shoot(page, `stacks-${scheme}.png`);
    });
  }

  test("filters by state and reads a thread's frames", async ({ page }) => {
    await openStacks(page, "/tools/stacks");
    await expect(page.locator("[data-burrow-stacks-rows]")).toHaveAttribute("data-burrow-stacks-rows", "230");
    await page.getByRole("button", { name: /^TIMED_WAITING 186$/ }).click();
    await expect(page).toHaveURL(/state=TIMED_WAITING/);
    await expect(page.locator("[data-burrow-stacks-rows]")).toHaveAttribute("data-burrow-stacks-rows", "186");
    await page.getByRole("button", { name: /^All states 230$/ }).click();
    await expect(page.locator("[data-burrow-stacks-rows]")).toHaveAttribute("data-burrow-stacks-rows", "230");
  });

  test("searches frames with a match count and highlight", async ({ page }) => {
    await openStacks(page, "/tools/stacks");
    await page.getByRole("searchbox", { name: "Search threads and frames" }).fill("CallQueueManager");
    await expect(page.locator("mark").first()).toBeVisible();
    await expect(page.getByText(/\d+ of 230 threads match/)).toBeVisible();
    // Matching threads open automatically so the hit frame is on screen.
    await expect(page.locator('[data-kind="frame"]').first()).toBeVisible();
    await expect(page).toHaveURL(/q=CallQueueManager/);
  });

  test("selecting a thread writes a URL that reloads into the same view", async ({ page }) => {
    await openStacks(page, "/tools/stacks");
    // The 2nd thread of the dump is `Thread 3 (Finalizer)` — selecting it must open its frames and put it in the URL.
    await page.locator('[data-kind="thread"]').nth(1).click();
    await expect(page).toHaveURL(/thread=/);
    await expect(page.locator("[data-burrow-stacks-rows]")).toHaveAttribute("data-burrow-stacks-rows", "234"); // 230 + 4 frames

    // Reopen the link the UI produced: the same thread, same frames (a shareable deep link).
    const link = page.url();
    await page.goto(link);
    await page.waitForSelector('[data-burrow-stacks-root="1"]', { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Finalizer" })).toBeVisible();
    await expect(page.getByText(/^Frames \(4\)$/)).toBeVisible();
    await expect(page.locator("aside").getByText("waiting on java.lang.ref.ReferenceQueue$Lock@73af089d").first()).toBeVisible();
    await expect(page.locator("[data-burrow-stacks-rows]")).toHaveAttribute("data-burrow-stacks-rows", "234");
  });

  test("expands every frame in parity mode", async ({ page }) => {
    await openStacks(page, "/tools/stacks?parity=1");
    const rows = await page.locator("[data-burrow-stacks-rows]").getAttribute("data-burrow-stacks-rows");
    expect(Number(rows)).toBeGreaterThan(1000);
    await expect(page.locator('[data-kind="frame"]').first()).toBeVisible();
  });
});
