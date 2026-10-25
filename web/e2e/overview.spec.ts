/**
 * Overview end-to-end (`bun run e2e`), against the same-origin mock API (`bun run dev:mock`), which replays the real
 * captured ResourceManager payloads from `fixtures/rm/overview/`.
 *
 * What is asserted:
 *  1. every section renders, and every datum the section must show is present with a non-empty `data-yv`
 *     (the parity contract: `docs/contracts/parity-dom.md`);
 *  2. the click-throughs exist and point at the filtered views;
 *  3. `?parity=1` freezes the page and is announced;
 *  4. screenshots in dark and light (committed under `e2e/__screenshots__/`).
 */
import { expect, test, type Page } from "@playwright/test";

/** Required field ids per section. These are the sections' reason to exist — a missing one fails the run. */
const REQUIRED_FIELDS = {
  identity: [
    "cluster.info.id",
    "cluster.info.state",
    "cluster.info.haState",
    "cluster.info.haZooKeeperConnectionState",
    "cluster.info.rmStateStoreName",
    "cluster.info.startedOn",
    "cluster.info.derived.rmVersionText",
    "cluster.info.derived.hadoopVersionText",
  ],
  metrics: [
    "cluster.metrics.appsSubmitted",
    "cluster.metrics.appsPending",
    "cluster.metrics.appsRunning",
    "cluster.metrics.derived.appsCompletedAll",
    "cluster.metrics.appsFailed",
    "cluster.metrics.appsKilled",
    "cluster.metrics.containersAllocated",
    "cluster.metrics.containersPending",
    "cluster.metrics.containersReserved",
    "cluster.metrics.derived.usedResourcesText",
    "cluster.metrics.derived.totalResourcesText",
    "cluster.metrics.derived.reservedResourcesText",
    "cluster.metrics.utilizedMBPercent",
    "cluster.metrics.utilizedVirtualCoresPercent",
    "cluster.metrics.totalMB",
    "cluster.metrics.allocatedMB",
    "cluster.metrics.availableMB",
    "cluster.metrics.reservedMB",
    "cluster.metrics.totalVirtualCores",
    "cluster.metrics.allocatedVirtualCores",
    "cluster.metrics.availableVirtualCores",
    "cluster.metrics.reservedVirtualCores",
  ],
  nodeCounters: [
    "cluster.metrics.activeNodes",
    "cluster.metrics.decommissioningNodes",
    "cluster.metrics.decommissionedNodes",
    "cluster.metrics.lostNodes",
    "cluster.metrics.unhealthyNodes",
    "cluster.metrics.rebootedNodes",
    "cluster.metrics.shutdownNodes",
  ],
  scheduler: [
    "scheduler.type",
    "scheduler.derived.schedulingResourceTypes",
    "scheduler.derived.minAllocationText",
    "scheduler.derived.maxAllocationText",
    "scheduler.derived.maximumClusterPriority",
    "scheduler.schedulerBusy",
    "scheduler.rmDispatcherEventQueueSize",
    "scheduler.schedulerDispatcherEventQueueSize",
  ],
  activeApp: ["app.state", "app.name", "app.user", "app.queue", "app.progress", "app.elapsedTime", "app.startedTime", "app.allocatedMB"],
} as const;

async function yv(page: Page, field: string): Promise<string | null> {
  return page.locator(`[data-yf="${field}"]`).first().getAttribute("data-yv");
}

test.describe("overview", () => {
  test("keeps cluster identity in two columns through tablet widths", async ({ page }) => {
    for (const [width, expectedColumns] of [
      [375, 2],
      [768, 2],
      [1440, 4],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/?parity=1");

      const identity = page.getByTestId("identity");
      await expect(identity).toBeVisible();
      const columnCount = await identity.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
      expect(columnCount, `identity columns at ${width}px`).toBe(expectedColumns);
    }
  });

  test("keeps cluster version and build timestamps readable on phones and tablets", async ({ page }) => {
    for (const width of [375, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/?parity=1");

      for (const field of ["cluster.info.derived.rmVersionText", "cluster.info.derived.hadoopVersionText"]) {
        const value = page.locator(`[data-yf="${field}"]`);
        await expect(value).toBeVisible();
        const layout = await value.evaluate((element) => ({
          text: element.textContent,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          whiteSpace: getComputedStyle(element).whiteSpace,
          textOverflow: getComputedStyle(element).textOverflow,
          display: getComputedStyle(element).display,
          lineTops: (() => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return Array.from(new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))));
          })(),
        }));
        expect(layout.whiteSpace, `${field} at ${width}px`).not.toBe("nowrap");
        expect(layout.textOverflow, `${field} at ${width}px`).not.toBe("ellipsis");
        expect(layout.scrollWidth, `${field} at ${width}px`).toBeLessThanOrEqual(layout.clientWidth + 1);
        if (width === 375) {
          expect(layout.lineTops.length, `${field} at ${width}px should wrap instead of hiding its timestamp`).toBeGreaterThan(1);
        }
        expect(layout.text).toContain("3.4.3");
        expect(layout.text).toContain(" on ");
        const builtOnField = field.includes("rmVersion")
          ? "cluster.info.resourceManagerVersionBuiltOn"
          : "cluster.info.hadoopVersionBuiltOn";
        await expect(value.locator(`[data-yf="${builtOnField}"]`)).toHaveAttribute("data-yv", "2026-01-01T00:00Z");
      }
    }
  });

  test("keeps the ZooKeeper diagnosis fully readable on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 354, height: 784 });
    await page.goto("/?parity=1");

    const diagnosis = page.locator('[data-yf="cluster.info.haZooKeeperConnectionState"]');
    await expect(diagnosis).toContainText("Connected to ZooKeeper at zk1.mock.local:2181,zk2.mock.local:2181,zk3.mock.local:2181");
    const layout = await diagnosis.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      whiteSpace: getComputedStyle(element).whiteSpace,
      textOverflow: getComputedStyle(element).textOverflow,
    }));
    expect(layout.clientWidth).toBeGreaterThan(0);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.whiteSpace).not.toBe("nowrap");
    expect(layout.textOverflow).not.toBe("ellipsis");
  });

  test("uses grouped metric rows without clipping counters on phones or desktops", async ({ page }) => {
    for (const [width, expectedColumns] of [
      [375, 1],
      [1440, 3],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/?parity=1");

      const overviewMetrics = page.getByTestId("cluster-metrics");
      const metricRows = overviewMetrics.locator("[data-overview-metric-row='true']");
      await expect.poll(() => metricRows.count()).toBe(13);
      await expect(overviewMetrics.getByRole("heading", { name: "Applications" })).toBeVisible();
      await expect(overviewMetrics.getByRole("heading", { name: "Containers" })).toBeVisible();
      await expect(overviewMetrics.getByRole("heading", { name: "YARN resource allocation" })).toBeVisible();
      const firstRow = page.getByTestId("metric-apps-submitted").locator("[data-overview-metric-row='true']");
      await expect(firstRow).toHaveCSS("border-radius", "0px");
      const applicationGrid = overviewMetrics.locator(".burrow-overview-card-grid--apps");
      const layout = await applicationGrid.evaluate((grid) => ({
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        rows: [...new Set([...grid.querySelectorAll("[data-overview-metric-row]")].map((row) => Math.round(row.getBoundingClientRect().y)))]
          .length,
        clipped: [...grid.querySelectorAll("[data-overview-metric-row]")].some((row) => row.scrollWidth > row.clientWidth + 1),
      }));
      expect(layout).toEqual({ columns: expectedColumns, rows: Math.ceil(6 / expectedColumns), clipped: false });
    }

    const labels = page.getByTestId("identity").locator("dt");
    const labelStyles = await labels.evaluateAll((elements) =>
      elements.map((element) => ({ fontSize: getComputedStyle(element).fontSize, color: getComputedStyle(element).color })),
    );
    expect(labelStyles).toHaveLength(8);
    expect(labelStyles.every(({ fontSize }) => Number.parseFloat(fontSize) >= 12)).toBe(true);
    await expect(labels.first()).toHaveClass(/text-ink-2/);
  });

  test("uses the design-system spacing between overview metric columns", async ({ page }) => {
    await page.goto("/?parity=1");

    const grid = page.getByTestId("cluster-metrics").locator(".burrow-overview-card-grid--apps");
    await expect(grid).toBeVisible();
    await expect(grid).toHaveCSS("column-gap", "20px");
  });

  test("renders every section from the real captured payloads", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("overview")).toBeVisible();

    for (const [section, fields] of Object.entries(REQUIRED_FIELDS)) {
      if (section === "activeApp") {
        // The rail is honest about an idle cluster: either rows with every field, or the explicit empty state.
        const rows = page.locator('[data-testid^="app-row-"]');
        if ((await rows.count()) === 0) {
          await expect(page.getByText("Nothing is running right now")).toBeVisible();
          continue;
        }
        for (const field of fields) {
          await expect(page.locator(`[data-yf="${field}"]`).first(), `activeApp: ${field}`).toBeAttached();
          await expect.poll(async () => yv(page, field), { message: `${field} must carry a raw value` }).not.toBeNull();
        }
        continue;
      }
      for (const field of fields) {
        await expect(page.locator(`[data-yf="${field}"]`).first(), `${section}: ${field} must be rendered`).toBeAttached();
        await expect.poll(async () => yv(page, field), { message: `${field} must carry a raw value` }).not.toBeNull();
      }
    }

    // The parity contract's core rule: every rendered datum sits inside an entity with a stable key.
    const orphans = await page
      .locator("[data-yf]")
      .evaluateAll((els) => els.filter((el) => el.closest("[data-ye]") === null).map((el) => el.getAttribute("data-yf")));
    expect(orphans).toEqual([]);
  });
  test("uses scheduler REST data when the optional scheduler overview endpoint is unavailable", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/yarn/scheduler-overview",
      (route) =>
        route.fulfill({
          status: 404,
          contentType: "application/json",
          headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
          json: {
            error: {
              code: "upstream_status",
              message: "Sorry, got error 404: /v1/cluster/scheduler-overview controller for v1 not found",
              upstream: { url: "http://rm.example:8088/ws/v1/cluster/scheduler-overview", status: 404 },
            },
          },
        }),
    );
    await page.goto("/");
    const scheduler = page.getByTestId("scheduler");
    await expect(scheduler).toBeVisible();
    await expect(scheduler.getByRole("heading", { name: "Scheduler overview could not be read" })).toHaveCount(0);
    await expect(scheduler).toContainText("Detailed scheduler information is unavailable on this cluster.");
    await expect(scheduler.locator('[data-yf="scheduler.derived.schedulerName"]')).toHaveAttribute("data-yv", "Capacity Scheduler");
    await expect(scheduler.getByRole("heading", { name: "Queue headroom" })).toBeVisible();
  });

  test("keeps unexpected scheduler overview failures visible", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/yarn/scheduler-overview",
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
          json: { error: { code: "internal", message: "scheduler overview test failure" } },
        }),
    );
    await page.goto("/");
    const scheduler = page.getByTestId("scheduler");
    await expect(scheduler.getByRole("heading", { name: "Scheduler overview could not be read" })).toBeVisible();
    await expect(scheduler).toContainText("scheduler overview test failure");
  });

  test("the composite resource cells reproduce the RM's legacy text", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("metric-total-resources")).toBeVisible();
    // Totals include all default nodes in the current mock cluster.
    const total = page.getByTestId("metric-total-resources").locator('[data-yf="cluster.metrics.derived.totalResourcesText"]');
    await expect(total).toHaveAttribute("data-yv", "<memory:448 GB, vCores:176>");
    await expect(page.getByTestId("metric-total-resources")).toContainText(/Memory\s+448 GB\s+·\s+176 vCores/);
    await expect(page.getByTestId("metric-total-resources")).not.toContainText("<memory:");
    await expect(page.getByTestId("metric-used-resources")).toBeVisible();
    await expect(page.getByTestId("metric-reserved-resources")).toBeVisible();
  });

  test("separates average physical node memory from the RM aggregate counter", async ({ page }) => {
    await page.goto("/?parity=1");

    const average = page.locator('[data-yf="cluster.metrics.derived.averageNodeMemoryUtilization"]');
    await expect(page.getByText("Average node physical memory", { exact: true })).toBeAttached();
    await expect(average).toBeAttached();
    await expect(average).toHaveAttribute("data-yv", /\d/);
    await expect(page.locator('[data-yf="cluster.metrics.utilizedMBPercent"]')).toBeAttached();
    await page.getByRole("button", { name: "About ResourceManager memory utilization" }).click();
    await expect(page.getByRole("dialog")).toContainText(/average across \d+ reporting NodeManagers and can exceed 100%/);
  });

  test("keeps the allocation and history panels level on wide screens", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/?parity=1");

    const layout = await page.locator(".burrow-overview-utilization-grid").evaluate((grid) => {
      const [allocation, history] = Array.from(grid.children);
      if (!allocation || !history) throw new Error("Expected allocation and history panels");
      const allocationRect = allocation.getBoundingClientRect();
      const historyRect = history.getBoundingClientRect();
      const chart = history.querySelector(".burrow-overview-history-chart");
      return {
        allocationBottom: allocationRect.bottom,
        historyBottom: historyRect.bottom,
        chartHeight: chart?.getBoundingClientRect().height ?? 0,
      };
    });

    expect(Math.abs(layout.allocationBottom - layout.historyBottom)).toBeLessThanOrEqual(1);
    expect(layout.chartHeight).toBeLessThanOrEqual(256);
  });

  test("renders active applications as rows rather than a card grid", async ({ page }) => {
    await page.goto("/?parity=1");
    const rail = page.getByTestId("active-rail");
    await expect(rail).toBeVisible();
    await expect(rail).not.toHaveClass(/grid-cols/);
    const row = rail.locator('[data-testid^="app-row-"]').first();
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/border-b/);
    const facts = row.getByTestId("app-row-facts");
    await expect(facts).toHaveClass(/grid-cols-2/);
    await expect(facts.locator("[data-yf]")).toHaveCount(9);
  });

  test("keeps the active application name visible on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const longName =
      "com.example.analytics.pipelines.sessionization.SessionizationDriver --input hdfs://nameservice1/warehouse/events/hour=* --partitions 4096";
    await page.route(/\/api\/yarn\/apps\?.*states=/, async (route) => {
      const response = await route.fetch();
      const payload = (await response.json()) as { apps?: { app?: { name: string } | { name: string }[] } };
      const apps = payload.apps?.app;
      const app = Array.isArray(apps) ? apps[0] : apps;
      if (app) app.name = longName;
      await route.fulfill({ response, json: payload });
    });
    await page.goto("/?parity=1");

    const longApp = page.locator('[data-testid^="app-row-"]').filter({ hasText: longName }).locator('[data-yf="app.name"]');
    await expect(longApp).toBeVisible();
    const layout = await longApp.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      whiteSpace: getComputedStyle(element).whiteSpace,
      textOverflow: getComputedStyle(element).textOverflow,
    }));
    expect(layout.clientWidth).toBeGreaterThan(200);
    expect(layout.whiteSpace).not.toBe("nowrap");
    expect(layout.textOverflow).not.toBe("ellipsis");
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.height).toBeGreaterThan(layout.lineHeight);
  });

  test("the session utilisation chart keeps its frame while collecting", async ({ page }) => {
    // parity freezes after the first load, so exactly one sample exists and the collecting state holds:
    // the chart frame (grid + tick labels) must already be rendered behind the collecting note, keeping the
    // card at its full height so the neighbour card never shifts when the trend line arrives.
    await page.goto("/?parity=1");
    await expect(page.getByTestId("cluster-metrics")).toBeVisible();
    await expect(page.getByTestId("history-collecting")).toBeVisible();
    const chart = page.locator('svg[aria-label="Cluster memory utilisation, sampled while this tab has been open"]');
    await expect(chart).toBeVisible();
    await expect(chart.locator("text")).toContainText(["0%", "50%", "100%"]);
  });

  test("overview sections use the shared page-entry cascade", async ({ page }) => {
    await page.goto("/");
    const groups = page.getByTestId("overview").locator(".burrow-overview-group");
    const panels = page.getByTestId("overview").locator("[data-page-motion='cards'] > section");
    await expect(groups).toHaveCount(3);
    await expect(panels).toHaveCount(7);
    await expect(groups.first()).toHaveCSS("animation-name", "burrow-page-content-in");
    await expect(groups.first()).toHaveCSS("animation-duration", "0.24s");
    await expect(panels.first()).toHaveCSS("animation-name", "burrow-page-content-in");
  });

  test("changing the history window fades each affected chart", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("metric-apps-pending")).toBeVisible();
    await expect(page.getByTestId("metric-apps-running")).toBeVisible();
    await expect(page.locator('svg[aria-label^="Cluster memory utilisation"]')).toBeAttached();

    const fade = page.waitForFunction(() => {
      const isFadeRunning = (element: Element | null) =>
        element?.getAnimations().some((animation) => {
          const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
          return animation.playState === "running" && Number(frames[0]?.opacity) === 0 && Number(frames[frames.length - 1]?.opacity) === 1;
        }) ?? false;
      const wrappers = [
        document.querySelector('svg[aria-label^="Cluster memory utilisation"]')?.parentElement ?? null,
        document.querySelector('[data-testid="metric-apps-pending"]')?.parentElement ?? null,
        document.querySelector('[data-testid="metric-apps-running"]')?.parentElement ?? null,
      ];
      return wrappers.every(isFadeRunning);
    });

    await page.getByTestId("history-window-5m").click();
    await expect(page).toHaveURL(/window=5m/);
    expect(await (await fade).jsonValue()).toBe(true);
  });

  test("click-throughs point at the filtered views", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("metric-apps-running-link")).toHaveAttribute("href", "/apps?states=RUNNING");
    await expect(page.getByTestId("metric-apps-failed-link")).toHaveAttribute("href", "/apps?states=FAILED");
    await expect(page.getByTestId("node-count-lost-link")).toHaveAttribute("href", "/nodes?states=LOST");
    await page.getByText("Queue headroom", { exact: true }).first().click();
    await expect(page.locator('[data-ye="root.default"]')).toBeVisible();
  });

  test("parity mode freezes the page and says so", async ({ page }) => {
    await page.goto("/?parity=1");
    await expect(page.getByTestId("topbar").getByText("parity", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-parity", "1");
    // data-yv is the raw value, never the tweened one
    await expect.poll(async () => yv(page, "cluster.metrics.appsSubmitted")).toMatch(/^\d+$/);
  });

  test("the shell's live control is honoured and reports the cadence", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("topbar")).toHaveAttribute("data-live", "live");
    await expect(page.getByRole("combobox", { name: "Refresh interval" })).toContainText(/\d+ s/);
    await page.getByTestId("live-pause").click();
    await expect(page.getByTestId("topbar")).toHaveAttribute("data-live", "paused");
    await expect(page.getByTestId("last-updated")).toContainText("paused");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`screenshot · ${theme}`, async ({ page }) => {
      // "system" + emulateMedia: the pre-paint bootstrap (public/theme-init.js) resolves the OS scheme, so both themes
      // come from the same code path a real user hits.
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript(() => {
        try {
          localStorage.setItem("burrow.prefs.v1", JSON.stringify({ theme: "system", tz: "utc", motion: "reduced" }));
        } catch {
          /* storage disabled: the OS scheme is used anyway */
        }
      });
      // parity: freezes data + animations so the screenshot is deterministic across runs
      await page.goto("/?parity=1");
      await expect(page.getByTestId("overview")).toBeVisible();
      await expect(page.getByTestId("cluster-metrics")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByTestId("overview").scrollIntoViewIfNeeded();
      await expect(page).toHaveScreenshot(`overview/${theme}.png`, { fullPage: true });
    });
  }
});
