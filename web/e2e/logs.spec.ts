/**
 * `/apps/$appId/logs` — the container-log viewer (Playwright, dev mock).
 *
 * The mock replays real captured container logs (`fixtures/rm/logs/**`): a FAILED Spark application's AM stderr with
 * real ERROR/FATAL lines and Hadoop log4j timestamps, a 5.2 MB stdout, and a live-container userlog directory with all
 * six NodeManager files. The specs pin provenance, byte ranges, the level filter, search + match navigation,
 * jump-to-first-error, follow → eof, the polling fallback when the stream fails, and the honest "endpoint missing"
 * state. A separate spec measures first paint and scroll frame timing on a 1M-line buffer.
 *
 * Screenshots land on the exact acceptance path (`e2e/__screenshots__/logs/<name>.png`).
 */
import { type Page, expect, test } from "@playwright/test";

async function shoot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(`logs/${name}`);
}

/** An app the mock serves, so the `/apps/$appId` layout renders (the log route itself only needs the container id). */
const APP = "application_1791010984040_0001";
/** A real FAILED Spark AM stderr (42 641 B, 2 ERROR lines, Hadoop log4j timestamps). */
const FAILED = "container_1791015583684_0002_01_000001";
/** The 5.2 MB cluster-mode AM stdout captured from the live cluster. */
const BIG = "container_1791010984040_0037_01_000001";
/** A live-container userlog directory with all six NodeManager files. */
const NM = "container_1791010984040_0033_01_000001";

const logUrl = (cid: string, extra = "") => `/apps/${APP}/logs?container=${cid}${extra}`;
const pane = (page: Page) => page.locator('[role="log"]');
const followState = (page: Page) => page.locator("[data-burrow-log-follow]");

test.describe("container logs", () => {
  test("opens a container's stderr with provenance and switches files", async ({ page }) => {
    await page.goto(logUrl(FAILED, "&file=stderr"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });

    // provenance: the container id, the file size (a YARN datum), the source, and the byte range
    await expect(page.locator(`[data-yf="log.containerId"][data-yv="${FAILED}"]`).first()).toBeVisible();
    await expect(page.locator('[data-yf="log.fileSize"][data-yv="42326"]')).toBeVisible();
    await expect(page.locator('[data-burrow-log-source="jhs"]')).toBeVisible();
    await expect(page.locator("[data-burrow-log-range]")).toHaveAttribute("data-burrow-log-range", "0-42326");
    // only the virtualized window is in the DOM, so assert on text that is actually in the first screenful
    await expect(pane(page)).toContainText("ApplicationMaster");
    await expect(page).toHaveURL(/file=stderr/);

    // the file selector lists the whole userlog directory (six files) and switches the viewer
    await expect(page.locator('[aria-label="Log file"]')).toContainText("stderr");
    await page.locator('[aria-label="Log file"]').click();
    await page.getByRole("option", { name: /^stdout/ }).click();
    await expect(page).toHaveURL(/file=stdout/);
    await expect(page.locator('[data-yf="log.fileSize"][data-yv="8612"]')).toBeVisible();
  });
  test("locks application navigation while the selected log pane uses the available height", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(logUrl(FAILED, "&file=stderr"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    await expect(followState(page)).toHaveAttribute("data-burrow-log-follow", "off");

    const appScroller = page.locator(".burrow-app-scroll");
    await expect.poll(() => appScroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
    const header = page.locator('[data-burrow-app-header="yarn"]');
    const headerTop = (await header.boundingBox())!.y;
    const tabs = page.getByRole("navigation", { name: "Application sections" });
    const tabsBox = (await tabs.boundingBox())!;
    await page.mouse.move(tabsBox.x + tabsBox.width / 2, tabsBox.y + tabsBox.height / 2);
    await page.mouse.wheel(0, 120);

    await expect.poll(() => appScroller.evaluate((el) => el.scrollTop)).toBe(0);
    expect((await header.boundingBox())!.y).toBe(headerTop);
    await expect(page.getByRole("link", { name: "YARN application page" })).toBeInViewport();
  });
  test("keeps selected logs scrollable on short viewports at desktop breakpoints", async ({ page }) => {
    for (const width of [768, 1024]) {
      await page.setViewportSize({ width, height: 400 });
      await page.goto(logUrl(FAILED, "&file=stderr"));
      await expect(pane(page)).toBeVisible({ timeout: 30_000 });

      const appScroller = page.locator(".burrow-app-scroll");
      await expect.poll(() => appScroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
      const panel = page.locator("[data-burrow-log-panel]");
      await panel.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await expect(page.getByRole("button", { name: "Download" })).toBeInViewport();
      await expect.poll(() => pane(page).evaluate((el) => el.clientHeight)).toBeGreaterThan(0);
    }
  });

  test("scrolls horizontally through long unwrapped lines", async ({ page }) => {
    await page.goto(logUrl(FAILED, "&file=stderr"));
    const log = pane(page);
    await expect(log).toBeVisible({ timeout: 30_000 });
    await log.evaluate((el) => {
      el.scrollTop = 72 * 20;
    });
    await expect(log.locator('[data-line="73"]')).toContainText("py4j-0.10.9.9-src.zip");

    const dimensions = await log.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
    await log.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect.poll(() => log.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  });

  test("lists every NodeManager file for a live container", async ({ page }) => {
    await page.goto(logUrl(NM));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    // no `file` in the URL: the viewer lands on stdout (the most interesting file)
    await expect(page).toHaveURL(/file=stdout/);
    await page.locator('[aria-label="Log file"]').click();
    for (const name of ["directory.info", "launch_container.sh", "prelaunch.err", "prelaunch.out", "stderr", "stdout"]) {
      await expect(page.getByRole("option", { name: new RegExp(`^${name.replace(".", "\\.")}`) })).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-burrow-log-source="nm"]')).toBeVisible();
  });

  test("filters by level and jumps to the first error", async ({ page }) => {
    await page.goto(logUrl(FAILED, "&file=stderr"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    await expect(pane(page).locator('[aria-label="INFO"]').first()).toBeVisible();

    // filter to WARN+: INFO rows are excluded from the rendered set, WARN stays, and the status bar counts both
    await page.goto(logUrl(FAILED, "&file=stderr&filter=WARN"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    await expect(pane(page).locator('[aria-label="WARN"]').first()).toBeVisible();
    await expect(pane(page).locator('[aria-label="INFO"]')).toHaveCount(0);
    await expect(page.locator("[data-burrow-log-lines]")).toContainText("/");

    // jump to first error is independent of search: it lands on the real ERROR line (file line 393)
    await page.goto(logUrl(FAILED, "&file=stderr"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Jump to first error" }).click();
    await expect(pane(page).locator('[data-line="393"]')).toBeInViewport();
    await expect(pane(page).locator('[data-line="393"]')).toContainText("ERROR");

    // a log with no ERROR says so instead of pretending
    await page.goto(logUrl(BIG, "&file=stdout"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Jump to first error" }).click();
    await expect(page.getByText("No ERROR/FATAL line in the loaded window")).toBeVisible();
  });

  test("searches literal and regex with match navigation", async ({ page }) => {
    await page.goto(logUrl(FAILED, "&file=stderr"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });

    const search = page.locator('input[aria-label="Search the log"]');
    await search.fill("Task");
    const hits = page.locator("[data-burrow-log-hits]");
    await expect(hits).toContainText("match 1 of", { timeout: 20_000 });
    const total = Number((await hits.textContent())!.match(/of (\d+)/)![1]);
    expect(total).toBeGreaterThan(1);
    await expect(pane(page).locator("mark[data-ansi-mark]").first()).toBeVisible();

    await search.press("Enter");
    await expect(hits).toContainText("match 2 of");
    await search.press("Shift+Enter");
    await expect(hits).toContainText("match 1 of");

    await page.getByRole("button", { name: "Next match" }).click();
    await expect(hits).toContainText("match 2 of");
    await page.getByRole("button", { name: "Previous match" }).click();
    await expect(hits).toContainText("match 1 of");

    // regex mode changes the match set
    await page.getByRole("button", { name: "Regular expression search" }).click();
    await search.fill("Task\\s+\\d+");
    await expect(hits).toContainText("of", { timeout: 20_000 });

    // case sensitivity is a real toggle
    await page.getByRole("button", { name: "Case-sensitive search" }).click();
    await search.fill("TASKSETMANAGER");
    await expect(page.locator("mark[data-ansi-mark]")).toHaveCount(0);
  });

  test("explains icon controls in the log toolbar", async ({ page }) => {
    await page.goto(logUrl(FAILED, "&file=stderr"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    const tooltip = page.locator('[role="tooltip"][data-open]');

    // Disabled match arrows still explain how to enable them; the wrapper keeps the hint hoverable.
    await page.getByTestId("previous-match-trigger").hover();
    await expect(tooltip).toContainText("Search for text to enable match navigation");

    const search = page.getByRole("searchbox", { name: "Search the log" });
    await search.fill("Task");
    await expect(page.locator("[data-burrow-log-hits]")).toContainText("match 1 of", { timeout: 20_000 });
    await page.getByRole("button", { name: "Clear search" }).hover();
    await expect(tooltip).toContainText("Clear search");
    await page.getByTestId("next-match-trigger").hover();
    await expect(tooltip).toContainText("Go to the next search match");

    await page.getByRole("button", { name: "Regular expression search" }).hover();
    await expect(tooltip).toContainText("regular-expression operators");
    await page.getByRole("button", { name: "Case-sensitive search" }).hover();
    await expect(tooltip).toContainText("Match uppercase and lowercase letters exactly");
    await page.getByRole("button", { name: "Wrap long lines" }).hover();
    await expect(tooltip).toContainText("Wrap long log lines");

    await page.getByRole("button", { name: "Show elapsed time since previous timestamp" }).hover();
    await expect(tooltip).toContainText("milliseconds elapsed since the previous timestamp");
    await page.getByRole("button", { name: "Copy the loaded log text" }).hover();
    await expect(tooltip).toContainText("Copy the loaded log text");
  });

  test("follows the stream and ends at eof", async ({ page }) => {
    // `?tail=` implies follow; the stream replays the captured tail then sends eof
    await page.goto(logUrl(BIG, "&file=stdout&tail=262144"));
    await expect(followState(page)).toHaveAttribute("data-burrow-log-follow", "ended", { timeout: 30_000 });
    await expect(pane(page)).toContainText("BURROW_SUMMARY");
    // The captured file is 5,244,972 bytes; tail=262144 requests its last 256 KiB.
    await expect(page.locator("[data-burrow-log-range]")).toHaveAttribute("data-burrow-log-range", "4982828-5244972");
    await expect(pane(page)).toContainText("BURROW_BIGLOG end sum=8002000");
  });

  test("appends live lines without a flash animation", async ({ page }) => {
    await page.addInitScript(() => {
      const host = window as Window & { __ysLogFlashAnimations?: number };
      host.__ysLogFlashAnimations = 0;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.closest("[data-line]") && this.classList.contains("bg-live")) {
          host.__ysLogFlashAnimations = (host.__ysLogFlashAnimations ?? 0) + 1;
        }
        return animate.apply(this, args);
      };
    });
    const liveLine = "2026-10-03 13:50:29,000 INFO [main] live-update-probe\n";
    await page.route("**/files/stderr/stream**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `event: chunk\ndata: ${JSON.stringify({ start: 42326, text: liveLine })}\n\nevent: eof\ndata: {}\n\n`,
      }),
    );
    await page.goto(logUrl(FAILED, "&file=stderr&follow=1"));
    const log = pane(page);
    await expect(log).toContainText("live-update-probe", { timeout: 30_000 });
    await expect(followState(page)).toHaveAttribute("data-burrow-log-follow", "ended");
    expect(await page.evaluate(() => (window as Window & { __ysLogFlashAnimations?: number }).__ysLogFlashAnimations)).toBe(0);
  });

  test("falls back to polling when the stream fails, and says so", async ({ page }) => {
    await page.route("**/files/*/stream*", (route) => route.abort());
    await page.goto(logUrl(FAILED, "&file=stderr&follow=1"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    // after the stream fails repeatedly the viewer switches transport and labels it
    await expect(followState(page)).toHaveAttribute("data-burrow-log-follow", "polling", { timeout: 30_000 });
    // polling still delivers the log body
    await expect(pane(page)).toContainText("TaskSetManager");
  });

  test("keeps the loaded lines visible when enabling follow cannot load a tail window", async ({ page }) => {
    await page.goto(logUrl(FAILED, "&file=stderr"));
    const log = pane(page);
    await expect(log).toBeVisible({ timeout: 30_000 });
    await expect(log).toContainText("ApplicationMaster");

    await page.route("**/api/logs/containers/**/files/stderr?*", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (params.has("tail") || params.has("offset")) {
        await route.fulfill({ status: 503, body: "tail temporarily unavailable" });
        return;
      }
      await route.continue();
    });
    await page.getByRole("switch", { name: "Follow new log output" }).click();

    await expect(log).toBeVisible();
    await expect(log).toContainText("ApplicationMaster");
    await expect(page.getByText("Cannot read this log file")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("could not be loaded", { timeout: 10_000 });
  });

  test("reads the latest window by byte range when the backend rejects tail reads", async ({ page }) => {
    await page.route("**/api/logs/containers/**/files/stdout?*", async (route) => {
      if (new URL(route.request().url()).searchParams.has("tail")) {
        await route.fulfill({ status: 503, body: "tail not supported by this gateway" });
        return;
      }
      await route.continue();
    });
    await page.goto(logUrl(BIG, "&file=stdout"));
    const log = pane(page);
    await expect(log).toBeVisible({ timeout: 30_000 });
    await expect(log).not.toContainText("BURROW_SUMMARY");

    await page.getByRole("switch", { name: "Follow new log output" }).click();
    await expect(log).toContainText("BURROW_SUMMARY", { timeout: 30_000 });
    await expect(page.locator("[data-burrow-log-range]")).toHaveAttribute("data-burrow-log-range", "4982828-5244972");
    await expect(followState(page)).toHaveAttribute("data-burrow-log-follow", "ended", { timeout: 30_000 });
  });

  test("says exactly which endpoint is missing when the backend does not serve logs", async ({ page }) => {
    await page.route("**/api/logs/containers/**", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found", message: "no log routes in this build" } }),
      }),
    );
    await page.goto(logUrl(FAILED, "&file=stderr"));
    await expect(page.getByText("GET /api/logs/containers/{id} is not served by this backend")).toBeVisible();
  });

  test("picks a container when the URL does not name one", async ({ page }) => {
    await page.goto(`/apps/${APP}/logs`);
    // The running-app fixture includes this AM attempt and its NodeManager log source.
    await expect(page.getByRole("heading", { name: "ApplicationMaster containers" })).toBeVisible({ timeout: 30_000 });
    const amContainer = page.locator("tr").filter({ hasText: "container_1791010984040_0001_01_000001" });
    await expect(amContainer).toContainText("Aggregated (JobHistory)");
    await amContainer.getByRole("button", { name: "Logs", exact: true }).click();
    await expect(page).toHaveURL(/container=(%22)?container_1791010984040_0001_01_000001/);
  });

  test("dark", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(logUrl(FAILED, "&file=stderr&parity=1"));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(pane(page)).toContainText("TaskSetManager", { timeout: 30_000 });
    await shoot(page, "logs-dark.png");
  });

  test("light", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(logUrl(FAILED, "&file=stderr&parity=1"));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(pane(page)).toContainText("TaskSetManager", { timeout: 30_000 });
    await shoot(page, "logs-light.png");
  });
});

test.describe("phone log toolbar", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("tooltip-wrapped search toggles remain operable by touch", async ({ page }) => {
    await page.goto(logUrl(FAILED, "&file=stderr"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    const appScroller = page.locator(".burrow-app-scroll");
    await expect.poll(() => appScroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);

    const regex = page.getByRole("button", { name: "Regular expression search" });
    await regex.tap();
    await expect(regex).toHaveAttribute("aria-pressed", "true");

    const wrap = page.getByRole("button", { name: "Wrap long lines" });
    // Narrow viewports default to wrapping; tapping turns it off.
    await expect(wrap).toHaveAttribute("aria-pressed", "true");
    await wrap.tap();
    await expect(wrap).toHaveAttribute("aria-pressed", "false");
  });
});
test.describe("timezone-aware log timestamps", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("absolute log line timestamps switch between local and UTC", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("burrow.prefs.v1", JSON.stringify({ tz: "local", livePaused: true, liveIntervalMs: 30000 }));
    });
    await page.goto(logUrl(FAILED, "&file=stderr&parity=1"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Show clock time" })).toHaveAttribute("aria-pressed", "true");

    const timestamp = pane(page)
      .locator("[data-line] > span:nth-child(2)")
      .filter({ hasText: /^\d{2}:\d{2}:\d{2}\.\d{3}$/ })
      .first();
    await expect(timestamp).toBeVisible();
    const localTime = (await timestamp.innerText()).trim();
    await page.getByTestId("tz-toggle").getByRole("button", { name: /UTC/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-tz", "utc");
    await expect(timestamp).not.toHaveText(localTime);
  });

  test("relative timestamps show elapsed time for full date stamps", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(logUrl(FAILED, "&file=stderr&ts=relative&parity=1"));
    await expect(pane(page)).toBeVisible({ timeout: 30_000 });
    await expect(pane(page).locator('[data-line="3"] > span:nth-child(2)')).toHaveText("+0 ms");
  });
});

test.describe("container logs — performance", () => {
  test("renders a 1M-line buffer and scrolls it without long frames", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const LINES = 1_000_000;
    // A synthetic 1M-line body (a perf fixture, generated here — never presented as cluster data).
    const parts: string[] = new Array(LINES);
    for (let i = 0; i < LINES; i++) parts[i] = `2026-10-03 12:00:00,000 INFO [main] task=${i} payload=${"x".repeat(18)}`;
    const text = `${parts.join("\n")}\n`;
    const bytes = Buffer.from(text, "utf8");
    const size = bytes.length;

    // The initial read is answered with the whole body (the product's own cap is 8 MiB per request; this spec is about
    // what the renderer does with a 1M-line buffer, so the mock hands it one).
    await page.route("**/api/logs/containers/perf1m**", (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/perf1m")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ source: "nm", node: "perf:8042", files: [{ name: "stdout", size, lastModified: 0 }] }),
        });
      }
      if (path.includes("/files/stdout")) {
        const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
        const start = Math.max(0, Math.min(size, offset));
        return route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-burrow-log-size": String(size),
            "x-burrow-log-start": String(start),
            "x-burrow-log-end": String(size),
            "x-burrow-log-source": "nm",
          },
          body: bytes.subarray(start),
        });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    const t0 = Date.now();
    await page.goto(`/apps/${APP}/logs?container=perf1m&file=stdout`);
    await expect(pane(page).locator("[data-line]").first()).toBeVisible({ timeout: 90_000 });
    const firstPaintMs = Date.now() - t0;
    await expect(page.locator("[data-burrow-log-lines]")).toContainText("1,000,000");

    // Scroll the full height in 90 steps and record per-frame time.
    const frames = await page.evaluate(async () => {
      const el = document.querySelector('[role="log"]') as HTMLElement;
      const times: number[] = [];
      await new Promise<void>((resolve) => {
        let i = 0;
        let last = performance.now();
        const step = () => {
          const now = performance.now();
          if (i > 0) times.push(now - last);
          last = now;
          el.scrollTop = (i / 90) * (el.scrollHeight - el.clientHeight);
          i++;
          if (i <= 90) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      times.sort((a, b) => a - b);
      const at = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))] ?? 0;
      return { n: times.length, p50: at(0.5), p95: at(0.95), max: times[times.length - 1] ?? 0 };
    });

    // Search across all 1M lines (chunked async scan) and time it.
    const searchStart = Date.now();
    await page.locator('input[aria-label="Search the log"]').fill("task=999999");
    await expect(page.locator("[data-burrow-log-hits]")).toContainText("match 1 of", { timeout: 60_000 });
    const searchMs = Date.now() - searchStart;

    // `performance.memory` is a Chromium extension not in the DOM lib; read it through a narrow local type.
    const heapMB = await page.evaluate(() => {
      const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      return mem ? Math.round(mem.usedJSHeapSize / 1048576) : null;
    });

    const report = {
      lines: LINES,
      bytes: size,
      firstPaintMs,
      scrollFrames: frames,
      searchMs,
      heapMB,
    };
    console.log(`[logs-perf] ${JSON.stringify(report)}`);
    await testInfo.attach("logs-perf.json", { body: JSON.stringify(report, null, 1), contentType: "application/json" });
    expect(firstPaintMs).toBeLessThan(30_000);
    expect(frames.p95).toBeLessThan(120);
  });
});
