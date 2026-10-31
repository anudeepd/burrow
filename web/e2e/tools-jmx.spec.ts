/**
 * E2E for `/tools/jmx` (JMX / Server metrics) against the dev mock (`bun run dev:mock`, the real captured 464 KB / 75-bean
 * payload).
 *
 * Screenshots: `e2e/__screenshots__/tools/jmx-{dark,light}.png`.
 * Render timing: `window.__BURROW_JMX__` is stamped one animation frame after the visible rows change, so `paintedAt` is
 * `performance.now()` since navigation — first paint of the collapsed tree, and again after "Expand all" (~9k nodes).
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
async function openJmx(page: Page, path: string, minRows: number) {
  await page.goto(path);
  await page.waitForSelector('[data-burrow-jmx-root="1"]', { timeout: 60_000 });
  await page.waitForFunction((n) => (window.__BURROW_JMX__?.rows ?? 0) >= n, minRows, { timeout: 60_000 });
}

test.describe("/tools/jmx", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`renders the bean tree (${scheme})`, { tag: "@snapshot" }, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-10-03T12:04:09.000Z"));
      await page.emulateMedia({ colorScheme: scheme });
      await openJmx(page, "/tools/jmx", 100);
      await expect(page.getByRole("heading", { name: "JMX" })).toBeVisible();
      const probe = await page.evaluate(() => window.__BURROW_JMX__);
      // 25 bean groups + 75 beans = 100 rows, of which only the virtual window is in the DOM.
      expect(probe?.rows).toBe(100);
      const tree = page.locator('[data-burrow-jmx-tree="1"]');
      await expect(tree).toBeVisible();
      await expect(tree).toHaveClass(/burrow-table-scroll/);
      await expect(page.locator(".burrow-table-bottom-fade")).toHaveAttribute("data-visible", "true");
      expect(await tree.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("none");
      const summary = page.getByTestId("jmx-summary");
      await expect(summary.getByText("75", { exact: true })).toBeVisible();
      await expect(summary.getByText("2370", { exact: true })).toBeVisible();
      await expect(summary.getByText("7492", { exact: true })).toBeVisible();
      await expect(summary).toContainText("in 25 groups");
      await expect(page.getByText(/100 of 9,261 nodes/)).toBeVisible();
      const domRows = await page.locator("[data-burrow-jmx-node]").count();
      expect(domRows).toBeGreaterThan(10);
      expect(domRows).toBeLessThan(100);

      await shoot(page, `jmx-${scheme}.png`);
    });
  }

  test("measures the paint time of the full tree and stays virtualized", async ({ page }) => {
    await openJmx(page, "/tools/jmx", 100);
    const initial = await page.evaluate(() => window.__BURROW_JMX__);
    expect(initial?.rows).toBe(100); // 25 groups + 75 beans
    console.log(`[jmx] collapsed tree (${initial?.rows} rows) painted at ${initial?.paintedAt} ms`);

    await page.getByRole("button", { name: /Expand all/ }).click();
    await page.waitForFunction(() => {
      const probe = window.__BURROW_JMX__;
      return probe !== undefined && probe.rows > 2000 && probe.paints >= 2;
    });
    const full = await page.evaluate(() => window.__BURROW_JMX__);
    console.log(`[jmx] fully expanded tree (${full?.rows} rows) painted at ${full?.paintedAt} ms since navigation`);
    test.info().annotations.push({ type: "jmx-paint", description: JSON.stringify({ initial, full }) });
    expect(full?.rows).toBe(9261);
    // Virtualization: the DOM holds a window, not 9k rows.
    const domRows = await page.locator("[data-burrow-jmx-node]").count();
    expect(domRows).toBeLessThan(400);
    expect(domRows).toBeGreaterThan(10);

    // Scrolling 9 261 rows: one frame per scroll step, so `msPerFrame` is the honest "does it stay responsive" number.
    const scroll = await page.evaluate(async () => {
      const el = document.querySelector('[data-burrow-jmx-tree="1"]');
      if (!el) return null;
      const steps = 60;
      const start = performance.now();
      for (let i = 0; i < steps; i++) {
        el.scrollTop = 240 * i;
        const frame = Promise.withResolvers<void>();
        requestAnimationFrame(() => frame.resolve());
        await frame.promise;
      }
      const elapsed = performance.now() - start;
      return { steps, elapsed, msPerFrame: elapsed / steps };
    });
    console.log(
      `[jmx] scroll over the expanded tree: ${scroll?.msPerFrame.toFixed(2)} ms/frame (${scroll?.steps} frames in ${scroll?.elapsed.toFixed(0)} ms)`,
    );
    test.info().annotations.push({ type: "jmx-scroll", description: JSON.stringify(scroll) });
    expect(scroll?.msPerFrame ?? 0).toBeLessThan(100);
  });

  test("searches, auto-expands the path and reports matches", async ({ page }) => {
    await openJmx(page, "/tools/jmx", 100);
    await page.getByRole("searchbox", { name: "Search attributes and values" }).fill("HeapMemoryUsage");
    await expect(page.locator("mark").first()).toBeVisible();
    await expect(page.getByText(/^\d+ matches$/).first()).toBeVisible();
    // The path to the match is open: the nested memory object is visible.
    await expect(page.locator('[data-burrow-jmx-node][data-kind="object"]').first()).toBeVisible();
    await expect(page).toHaveURL(/q=HeapMemoryUsage/);
  });

  test("selects a bean and keeps the selection in the URL", async ({ page }) => {
    // Narrow to the one bean first: a virtualized tree only holds the window it scrolls, so deep rows are not clickable.
    await openJmx(page, "/tools/jmx?qry=java.lang:type=Memory", 2);
    await page.locator('[data-burrow-jmx-node][data-kind="bean"]').getByText("java.lang:type=Memory", { exact: true }).click();
    await expect(page).toHaveURL(/bean=java.lang%3Atype%3DMemory/);
    await expect(page.getByRole("heading", { name: "java.lang:type=Memory" })).toBeVisible();
    await expect(page.getByText("HeapMemoryUsage", { exact: true }).first()).toBeVisible();
  });

  test("filters beans with the daemon-side pattern", async ({ page }) => {
    await openJmx(page, "/tools/jmx?qry=java.nio%3A*", 6);
    expect((await page.evaluate(() => window.__BURROW_JMX__))?.rows).toBe(6); // 3 groups + 3 beans
    await expect(page.locator('[data-burrow-jmx-node][data-kind="bean"]')).toHaveCount(3);
    // Bean rows show the part that distinguishes them inside their group (the full MBean name is the entity key/title).
    await expect(page.getByText("java.nio:name=direct", { exact: true })).toBeVisible();
    await expect(page.getByText("type=BufferPool", { exact: true }).first()).toBeVisible();
  });

  test("reads a NodeManager's MBeans with ?host=", async ({ page }) => {
    await openJmx(page, "/tools/jmx?host=127.0.0.2%3A8042", 10);
    await expect(page.getByRole("heading", { name: /NodeManager 127\.0\.0\.2:8042/ })).toBeVisible();
    await expect(page.locator('[data-burrow-jmx-root="1"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "ResourceManager" })).toBeVisible();
    // The `qry` preset is still applied on the NM variant.
    await page.getByRole("combobox", { name: "MBean pattern" }).click();
    await expect(page.getByRole("option", { name: "java.nio (*)" })).toBeVisible();
  });

  test("declares a pattern the daemon has no MBean for", async ({ page }) => {
    await page.goto("/tools/jmx?qry=Hadoop%3Aservice%3DNodeManager%2C*");
    await page.waitForSelector('[data-burrow-jmx-root="1"]', { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: /rejected this MBean pattern/ })).toBeVisible();
    await expect(page.getByText(/No MBean matching/)).toBeVisible();
  });

  test("parity mode expands every node and drops virtualization", async ({ page }) => {
    await openJmx(page, "/tools/jmx?parity=1", 9261);
    const probe = await page.evaluate(() => window.__BURROW_JMX__);
    console.log(`[jmx] parity tree (${probe?.rows} DOM rows) painted at ${probe?.paintedAt} ms since navigation`);
    test.info().annotations.push({ type: "jmx-parity-paint", description: JSON.stringify(probe) });
    expect(probe?.rows).toBe(9261);
    expect(await page.locator("[data-burrow-jmx-node]").count()).toBe(9261);
  });
});
