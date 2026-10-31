/**
 * Scheduler — Playwright proof against the dev mock, over the REAL captured fixtures.
 *
 * The dev mock answers `/api/yarn/scheduler` with its own capacity tree (consistent with the mock's apps/nodes). The Fair
 * and FIFO payloads come from the captures in `fixtures/rm/scheduler/{fair,fifo}/` and are fulfilled per-test with
 * `page.route`, so one server can render all three scheduler types without cycling the real cluster.
 *
 * Screenshots (dark + light) land in `e2e/__screenshots__/scheduler/`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { SchedulerResponseSchema, type CapacitySchedulerInfo, type QueueInfo } from "../src/api/schemas";

const fixture = (rel: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../fixtures/rm/scheduler/${rel}`, import.meta.url)), "utf8"));

const FAIR = fixture("fair/scheduler.json");
const FIFO = fixture("fifo/scheduler.json");
const CAPACITY = fixture("capacity/scheduler.json");

/** Serve scheduler fixtures without mixing Fair/FIFO data with the mock's captured Capacity scheduler-overview response. */
async function useScheduler(page: Page, body: unknown) {
  const parsed = SchedulerResponseSchema.safeParse(body);
  const type = parsed.success ? parsed.data.scheduler.schedulerInfo.type : undefined;
  await page.route(
    (url) => url.pathname === "/api/yarn/scheduler",
    (route) => route.fulfill({ json: body, headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" } }),
  );
  if (type === "fairScheduler" || type === "fifoScheduler") {
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
              message: "scheduler-overview is unavailable for this captured scheduler fixture",
              upstream: { url: "http://rm.example:8088/ws/v1/cluster/scheduler-overview", status: 404 },
            },
          },
        }),
    );
  }
}

function activityPayload(rowCount: number) {
  return {
    activities: {
      nodeId: "127.0.0.3:8041",
      timestamp: 1791011019914,
      allocations: [
        {
          partition: "<DEFAULT_PARTITION>",
          finalAllocationState: "SKIPPED",
          root: {
            name: "root",
            allocationState: "SKIPPED",
            diagnostic: "root allocation",
            children: Array.from({ length: Math.max(0, rowCount - 1) }, (_, index) => ({
              name: `root.queue-${index}`,
              allocationState: "SKIPPED",
              diagnostic: `queue ${index} allocation`,
            })),
          },
        },
      ],
    },
  };
}

function findQueue(queues: readonly QueueInfo[], path: string): QueueInfo | undefined {
  for (const queue of queues) {
    if (queue.queuePath === path) return queue;
    const nested = findQueue(queue.queues?.queue ?? [], path);
    if (nested) return nested;
  }
  return undefined;
}

const yv = async (page: Page, field: string) => {
  const el = page.locator(`[data-yf="${field}"]`).first();
  return el.getAttribute("data-yv");
};

test.describe("scheduler", () => {
  test("numeric-looking URL values do not replace the scheduler with a route error", async ({ page }) => {
    await page.goto("/scheduler?queueHide=0");
    const tree = page.locator('[data-burrow-table="scheduler-capacity-tree"]');
    await expect(tree.locator('[role="row"][data-ye="root.default"]')).toBeVisible();
    await expect(tree.getByRole("columnheader").first()).toBeVisible();
  });

  test("shows the queue workspace in the first phone viewport", { tag: "@snapshot" }, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/scheduler?parity=1");

    const queueHeading = page.getByRole("heading", { name: "Queue headroom" });
    await expect(queueHeading).toBeInViewport();
    const firstQueueRow = page.locator('[data-burrow-table="scheduler-capacity-tree"] [role="row"][data-ye]').first();
    await expect(firstQueueRow).toBeVisible();
    await expect(firstQueueRow).toBeInViewport();
    const scroller = page.locator(".burrow-page-scroll");
    await expect
      .poll(() =>
        scroller.evaluate((element) => {
          const node = element as HTMLElement;
          const box = node.getBoundingClientRect();
          const visibleTop = box.top + node.clientTop;
          const visibleBottom = visibleTop + node.clientHeight;
          const heading = document.querySelector<HTMLElement>("h2");
          const headingBox = heading?.getBoundingClientRect();
          return Boolean(headingBox && headingBox.top >= visibleTop - 1 && headingBox.bottom <= visibleBottom + 1);
        }),
      )
      .toBe(true);
    await expect(page).toHaveScreenshot("scheduler/mobile-queue-first-screen.png");
    await page.getByRole("button", { name: "More scheduler metrics" }).click();
    await expect(page.getByText("Scheduling Resource Type")).toBeVisible();
  });

  test("activity grouping keeps the table in view after a cached result shrinks", async ({ page }) => {
    // The compact mobile metrics bring the table higher, so keep this below-fold case below the viewport.
    await page.setViewportSize({ width: 390, height: 500 });
    await page.addInitScript(() => {
      localStorage.setItem("burrow.prefs.v1", JSON.stringify({ livePaused: true, liveIntervalMs: 30000 }));
    });

    let groupedRequests = 0;
    let releaseGroupedRefresh = () => {};
    const groupedRefreshHeld = new Promise<void>((resolve) => {
      releaseGroupedRefresh = resolve;
    });
    await page.route("**/api/yarn/scheduler/activities**", async (route) => {
      const grouped = new URL(route.request().url()).searchParams.get("groupBy") === "DIAGNOSTIC";
      if (grouped) groupedRequests += 1;
      if (grouped && groupedRequests === 2) await groupedRefreshHeld;
      await route.fulfill({
        status: 200,
        headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
        json: activityPayload(grouped && groupedRequests > 1 ? 1 : 24),
      });
    });

    const table = page.locator('[data-burrow-table="scheduler-activities"]');
    const expectTablePanelVisible = async () => {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const panel = document.querySelector<HTMLElement>("[data-burrow-activities-region]");
            const scroller = panel?.closest<HTMLElement>(".burrow-page-scroll");
            if (!panel || !scroller) return false;
            const panelRect = panel.getBoundingClientRect();
            const scrollerRect = scroller.getBoundingClientRect();
            const visibleTop = scrollerRect.top + scroller.clientTop;
            const visibleBottom = visibleTop + scroller.clientHeight;
            return panelRect.top >= visibleTop - 1 && panelRect.bottom <= visibleBottom + 1;
          }),
        )
        .toBe(true);
    };
    const parkControlAtViewportBottom = async (control: "NodeManager" | "Detailed" | "Group by diagnostic") => {
      await page.evaluate((name) => {
        const panel = document.querySelector<HTMLElement>("[data-burrow-activities-region]");
        const scroller = panel?.closest<HTMLElement>(".burrow-page-scroll");
        const target =
          name === "NodeManager"
            ? document.querySelector<HTMLElement>('[role="combobox"][aria-label="NodeManager"]')
            : Array.from(document.querySelectorAll<HTMLElement>("button")).find((button) => button.textContent?.trim() === name);
        if (!scroller || !target) throw new Error(`${name} control is missing`);
        const visibleBottom = scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight;
        const gapBelowControl = visibleBottom - target.getBoundingClientRect().bottom;
        scroller.scrollTop = Math.max(0, scroller.scrollTop - gapBelowControl + 2);
      }, control);
      await expect
        .poll(() =>
          page.evaluate((name) => {
            const panel = document.querySelector<HTMLElement>("[data-burrow-activities-region]");
            const scroller = panel?.closest<HTMLElement>(".burrow-page-scroll");
            const target =
              name === "NodeManager"
                ? document.querySelector<HTMLElement>('[role="combobox"][aria-label="NodeManager"]')
                : Array.from(document.querySelectorAll<HTMLElement>("button")).find((button) => button.textContent?.trim() === name);
            if (!scroller || !panel || !target) return false;
            const bottom = scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight;
            return target.getBoundingClientRect().bottom <= bottom && panel.getBoundingClientRect().bottom > bottom;
          }, control),
        )
        .toBe(true);
    };
    await page.goto("/scheduler?tab=activities&nodeId=127.0.0.3%3A8041");
    await expect(table).toHaveAttribute("data-burrow-rows", "24");

    await page.getByRole("button", { name: "Group by diagnostic" }).click();
    await expect(page).toHaveURL(/groupBy=DIAGNOSTIC/);
    await expect(table).toHaveAttribute("data-burrow-rows", "24");

    await page.getByRole("button", { name: "Detailed" }).click();
    await expect(page).not.toHaveURL(/groupBy=DIAGNOSTIC/);
    await expect(table).toHaveAttribute("data-burrow-rows", "24");
    await page.waitForTimeout(650);

    const beforeToggle = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".burrow-page-scroll");
      const tableElement = document.querySelector<HTMLElement>('[data-burrow-table="scheduler-activities"]');
      const groupButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Group by diagnostic");
      if (!scroller || !tableElement || !groupButton) throw new Error("Activities page controls are missing");
      const visibleBottom = scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight;
      const buttonBottom = groupButton.getBoundingClientRect().bottom;
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.max(0, Math.min(maxScrollTop, scroller.scrollTop + buttonBottom - (visibleBottom - 1)));
      return {
        buttonBottom: groupButton.getBoundingClientRect().bottom,
        tableTop: tableElement.getBoundingClientRect().top,
        visibleBottom,
      };
    });
    expect(beforeToggle.buttonBottom).toBeLessThanOrEqual(beforeToggle.visibleBottom);
    expect(beforeToggle.tableTop).toBeGreaterThan(beforeToggle.visibleBottom);

    try {
      await page.getByRole("button", { name: "Group by diagnostic" }).click();
      await expect(page).toHaveURL(/groupBy=DIAGNOSTIC/);
      await expect.poll(() => groupedRequests).toBe(2);
      await expect(table).toHaveAttribute("data-burrow-rows", "24");
    } finally {
      releaseGroupedRefresh();
    }

    await expect(table).toHaveAttribute("data-burrow-rows", "1");
    await expectTablePanelVisible();

    // Exercise each filter/control from the awkward state where the control is visible but the table tail is below it.
    await parkControlAtViewportBottom("NodeManager");
    await page.getByRole("combobox", { name: "NodeManager" }).click();
    await page.getByRole("option", { name: "latest (any node)" }).click();
    await expect(page).not.toHaveURL(/nodeId=/);
    await expectTablePanelVisible();

    await parkControlAtViewportBottom("Detailed");
    await page.getByRole("button", { name: "Detailed" }).click();
    await expect(page).not.toHaveURL(/groupBy=DIAGNOSTIC/);
    await expectTablePanelVisible();

    await parkControlAtViewportBottom("Group by diagnostic");
    await page.getByRole("button", { name: "Group by diagnostic" }).click();
    await expect(page).toHaveURL(/groupBy=DIAGNOSTIC/);
    await expectTablePanelVisible();
  });

  test("node-label partition summaries stay compact and scroll when multiple labels do not fit", async ({ page }) => {
    await page.setViewportSize({ width: 840, height: 900 });
    await page.goto("/scheduler?parity=1");

    const strip = page.getByRole("region", { name: "Partition resource totals" });
    await expect(strip.locator('[data-yf="queue.derived.partitionUiTag"]')).toHaveCount(3);
    const layout = await page.evaluate(() => {
      const summary = document.querySelector<HTMLElement>('[aria-label="Partition resource totals"]');
      const table = document.querySelector<HTMLElement>('[data-burrow-table-root="scheduler-node-labels"]');
      const header = table?.querySelector<HTMLElement>('[role="row"]');
      const cue = summary?.parentElement?.querySelector<HTMLElement>('[data-scroll-cue="right"]');
      if (!summary || !table || !header || !cue) throw new Error("Partition summary or table chrome is missing");
      return {
        summaryHeight: summary.getBoundingClientRect().height,
        headerGap: header.getBoundingClientRect().top - summary.getBoundingClientRect().bottom,
        needsScroll: summary.scrollWidth > summary.clientWidth,
        rightCueVisible: cue.classList.contains("opacity-100"),
      };
    });

    expect(layout.summaryHeight).toBeLessThanOrEqual(40);
    expect(layout.headerGap).toBeLessThanOrEqual(70);
    expect(layout.needsScroll).toBe(true);
    expect(layout.rightCueVisible).toBe(true);
  });

  test("capacity: queue freeness is the primary reading and every value is stamped for parity", async ({ page }) => {
    await page.goto("/scheduler?parity=1");
    await expect(page.getByRole("heading", { name: "Scheduler", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Queue headroom" })).toBeVisible();

    // Scheduler facts now share sources and units with Overview.
    expect(await yv(page, "scheduler.type")).toBe("capacityScheduler");
    await expect(page.locator('[data-yf="scheduler.derived.schedulerName"]')).toHaveAttribute("data-yv", "Capacity Scheduler");
    await expect(page.locator('[data-yf="scheduler.derived.schedulingResourceTypes"]')).toHaveAttribute(
      "data-yv",
      "[memory-mb (unit=Mi), vcores]",
    );
    await expect(page.locator('[data-yf="scheduler.derived.minAllocationText"]')).toHaveText("256 MiB · 1 vCore");
    await expect(page.locator('[data-yf="scheduler.derived.maxAllocationText"]')).toHaveText("16 GiB · 8 vCores");
    await expect(page.locator('[data-yf="scheduler.derived.maximumClusterPriority"]')).toHaveAttribute("data-yv", "10");
    const maximumMemory = page.locator('[data-yf="scheduler.maximumAllocation.memory"]');
    await expect(maximumMemory).toHaveAttribute("data-yv", "16384");
    await expect(maximumMemory).toHaveAttribute("data-yfmt", "mb");
    await expect(page.getByText("The ResourceManager did not return this setting.")).toHaveCount(0);
    await expect(page.getByText("not in the REST contract")).toHaveCount(0);
    await expect(page.getByText("YARN memory allocation")).toBeVisible();
    await expect(page.getByText("Average node physical memory")).toBeVisible();

    // the tree renders every queue of the mock tree, keyed by path
    const rowIds = await page
      .locator('[data-burrow-table="scheduler-capacity-tree"] [role="row"][data-ye]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.ye));
    expect(rowIds).toContain("root");
    expect(rowIds.length).toBeGreaterThan(3);

    // freeness bar + derived freeness ids are on the page
    await expect(page.locator('[data-yf="queue.capacities.queueCapacitiesByPartition.absoluteUsedCapacity"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="queue.derived.freeGuaranteedPct"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="queue.derived.burstRoomPct"]').first()).toBeVisible();
    // every rendered datum carries both attributes
    const missing = await page.locator("[data-yf]").evaluateAll((els) => els.filter((el) => el.getAttribute("data-yv") === null).length);
    expect(missing).toBe(0);

    // accessible hierarchy: a real ARIA tree twin with levels, next to the grid
    await expect(page.getByRole("tree", { name: "Queue hierarchy" })).toBeAttached();
    const treeItems = page.getByRole("treeitem");
    expect(await treeItems.count()).toBeGreaterThan(3);
    await expect(page.getByRole("treeitem").first()).toHaveAttribute("aria-expanded", "true");

    // treemap + node labels
    await expect(page.getByRole("img", { name: /Queue resource map/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Node-label partitions" })).toBeVisible();
  });

  test("live queue updates keep rows calm while the running state badge pulses", async ({ page }) => {
    const changed = JSON.parse(JSON.stringify(CAPACITY)) as { scheduler: { schedulerInfo: CapacitySchedulerInfo } };
    const queue = findQueue(changed.scheduler.schedulerInfo.queues?.queue ?? [], "root.default");
    expect(queue).toBeDefined();
    if (!queue) return;
    const defaultPartition = queue.capacities?.queueCapacitiesByPartition?.find((partition) => (partition.partitionName ?? "") === "");
    expect(defaultPartition).toBeDefined();
    if (!defaultPartition) return;
    defaultPartition.usedCapacity = 21;
    defaultPartition.absoluteUsedCapacity = 21;

    let showChangedMetrics = false;
    await page.route(
      (url) => url.pathname === "/api/yarn/scheduler",
      (route) =>
        route.fulfill({
          json: showChangedMetrics ? changed : CAPACITY,
          headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
        }),
    );
    await page.addInitScript(() => {
      const state = window as Window & { __ysRowFlashCalls?: string[] };
      state.__ysRowFlashCalls = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.parentElement?.classList.contains("burrow-row") && this.classList.contains("pointer-events-none")) {
          state.__ysRowFlashCalls?.push(this.parentElement.getAttribute("data-ye") ?? "unknown");
        }
        return animate.apply(this, args);
      };
    });

    await page.goto("/scheduler");
    const row = page.locator('[data-burrow-table="scheduler-capacity-tree"] [role="row"][data-ye="root.default"]');
    const used = row.locator('[data-yf="queue.capacities.queueCapacitiesByPartition.usedCapacity"]');
    await expect(used).toHaveAttribute("data-yv", "333.55048");
    await expect(row.locator(".burrow-dot-pulse")).toHaveCount(1);

    showChangedMetrics = true;
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(used).toHaveAttribute("data-yv", "21");
    await page.waitForTimeout(250);

    const flashes = await page.evaluate(() => (window as Window & { __ysRowFlashCalls?: string[] }).__ysRowFlashCalls ?? []);
    expect(flashes).toEqual([]);
    await expect(row.locator(".burrow-dot-pulse")).toHaveCount(1);
  });

  test("Overview and Scheduler queue bars share a rounded five-pixel track and value spacing", async ({ page }) => {
    await page.goto("/");
    const overviewRow = page.locator('[data-ye="root.default"]');
    const overviewBar = overviewRow.getByRole("progressbar").first();
    await expect(overviewBar).toBeVisible();
    const overview = await overviewBar.evaluate((bar) => {
      const value = bar.nextElementSibling as HTMLElement;
      const barRect = bar.getBoundingClientRect();
      const valueRect = value.getBoundingClientRect();
      return {
        height: barRect.height,
        gap: valueRect.left - barRect.right,
        valueWidth: valueRect.width,
        textAlign: getComputedStyle(value).textAlign,
      };
    });

    await page.goto("/scheduler");
    const treeRow = page.locator('[data-burrow-table="scheduler-capacity-tree"] [role="row"][data-ye="root.default"]');
    const queueBar = treeRow.locator('[role="img"], [role="progressbar"]').first();
    await expect(queueBar).toBeVisible();
    const queue = await queueBar.evaluate((bar) => {
      const value = bar.nextElementSibling as HTMLElement;
      const barRect = bar.getBoundingClientRect();
      const valueRect = value.getBoundingClientRect();
      return {
        height: barRect.height,
        gap: valueRect.left - barRect.right,
        valueWidth: valueRect.width,
        textAlign: getComputedStyle(value).textAlign,
      };
    });

    expect(overview).toEqual({ height: 5, gap: 8, valueWidth: 80, textAlign: "left" });
    expect(queue).toEqual(overview);
  });

  test("capacity: health, configuration and activities tabs render real payloads", async ({ page }) => {
    await page.goto("/scheduler?parity=1");

    await page.getByRole("tab", { name: "Health" }).click();
    await expect(page.getByRole("heading", { name: "Aggregate scheduler counts" })).toBeVisible();
    await expect(page.getByText("Total Container Allocations(count)")).toBeVisible();
    await expect(page.getByText("Last scheduler run")).toBeVisible();
    for (const kind of ["Allocation", "Reservation", "Release", "Preemption"]) {
      await expect(page.getByRole("heading", { name: `Last ${kind}` })).toBeVisible();
    }

    await page.getByRole("tab", { name: "Configuration" }).click();
    await expect(page.locator('[data-yf="conf.property.name"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="conf.property.value"]').first()).toBeVisible();

    await page.getByRole("tab", { name: "Activities" }).click();
    await expect(page.locator('[data-yf="activities.allocations.root.name"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="activities.allocations.finalAllocationState"]').first()).toBeVisible();
  });

  test("scheduler content panels fade on tab switches", async ({ page }) => {
    await page.goto("/scheduler");
    await expect(page.getByRole("heading", { name: "Queue headroom" })).toBeVisible();
    const queuePanel = page.getByRole("tabpanel").filter({ has: page.getByRole("heading", { name: "Queue headroom" }) });
    await expect
      .poll(() => queuePanel.evaluate((element) => element.getAnimations().filter((animation) => animation.playState === "running").length))
      .toBe(0);
    await expect(queuePanel).toHaveCSS("transition-duration", "0.22s");

    const fade = queuePanel.evaluate(
      (element) =>
        new Promise<string>((resolve) => {
          const onTransition = (event: Event) => {
            const transition = event as TransitionEvent;
            if (transition.propertyName !== "opacity") return;
            element.removeEventListener("transitionrun", onTransition);
            resolve(transition.propertyName);
          };
          element.addEventListener("transitionrun", onTransition);
        }),
    );
    await page.getByRole("tab", { name: "Health" }).click();
    expect(await fade).toBe("opacity");
    await expect(page.getByRole("heading", { name: "Aggregate scheduler counts" })).toBeVisible();
  });

  test("switching scheduler tabs keeps the current page position", async ({ page }) => {
    await page.setViewportSize({ width: 1080, height: 420 });
    await page.addInitScript(() => {
      localStorage.setItem("burrow.prefs.v1", JSON.stringify({ livePaused: true, liveIntervalMs: 30000, motion: "reduced" }));
    });
    await page.goto("/scheduler?tab=activities");
    await expect(page.getByRole("tab", { name: "Activities" })).toBeVisible();

    const scrollport = page.locator(".burrow-page-scroll");
    const startingScrollTop = await page.evaluate(() => {
      const scrollport = document.querySelector<HTMLElement>(".burrow-page-scroll");
      const tablist = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Scheduler sections"]');
      if (!scrollport || !tablist) throw new Error("Scheduler tabs are missing");
      const scrollportRect = scrollport.getBoundingClientRect();
      const tablistRect = tablist.getBoundingClientRect();
      const targetBottom = scrollportRect.top + scrollport.clientTop + scrollport.clientHeight - 8;
      scrollport.scrollTop += tablistRect.bottom - targetBottom;
      return scrollport.scrollTop;
    });
    const expectScrollPositionToStay = () =>
      expect.poll(() => scrollport.evaluate((element) => element.scrollTop), { timeout: 1000 }).toBe(startingScrollTop);

    for (const [name, visibleContent] of [
      ["Health", page.getByRole("heading", { name: "Aggregate scheduler counts" })],
      ["Configuration", page.locator('[data-yf="conf.property.name"]').first()],
      ["Activities", page.locator('[data-yf="activities.allocations.root.name"]').first()],
    ] as const) {
      await page.getByRole("tab", { name }).click();
      await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
      await expect(visibleContent).toBeVisible();
      await expectScrollPositionToStay();
    }
  });

  test("changing the treemap area basis updates its reading and queue layout", async ({ page }) => {
    await page.goto("/scheduler");
    const treemap = page.getByRole("img", { name: /Queue resource map/ });
    await expect(treemap).toBeVisible();
    const rectangles = page.locator('svg[aria-label^="Queue resource map"] rect');
    await expect(rectangles.first()).toBeAttached();
    const radii = await rectangles.evaluateAll((rects) => rects.map((rect) => Number((rect as SVGRectElement).getAttribute("rx"))));
    expect(radii.length).toBeGreaterThan(0);
    expect(radii.every((radius) => radius > 0)).toBe(true);
    const before = await rectangles.evaluateAll((rects) =>
      rects.map((rect) => [rect.getAttribute("x"), rect.getAttribute("y"), rect.getAttribute("width"), rect.getAttribute("height")]),
    );

    const guaranteedShareButton = page.getByRole("button", { name: "Guaranteed share", exact: true });
    await guaranteedShareButton.click();
    const firstRect = rectangles.first();
    await expect(firstRect).toHaveCSS("transition-property", /width/);
    await expect(treemap).toHaveAttribute("aria-label", /guaranteed share/);
    await expect(guaranteedShareButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/with a guaranteed share/)).toBeVisible();

    const after = await rectangles.evaluateAll((rects) =>
      rects.map((rect) => [rect.getAttribute("x"), rect.getAttribute("y"), rect.getAttribute("width"), rect.getAttribute("height")]),
    );
    expect(after).not.toEqual(before);
  });

  test("capacity: a queue drill-down shows the legacy Queue Status labels and the user table", async ({ page }) => {
    await useScheduler(page, CAPACITY);
    await page.goto("/scheduler/root.default?parity=1");
    await expect(page.getByRole("heading", { name: "Queue Status" })).toBeVisible();
    for (const label of [
      "Queue State",
      "Used Capacity",
      "Absolute Used Capacity",
      "Used Resources",
      "Ordering Policy",
      "Default Application Priority",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Freeness" })).toBeVisible();
    // the per-user table is its own entity per row
    await expect(page.locator('[data-burrow-table="scheduler-users"]')).toBeVisible();
    await expect(page.locator('[data-ye^="root.default#"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="queueuser.username"]').first()).toBeVisible();
    // the queue's own entity wraps the status block
    await expect(page.locator('[data-ye="root.default"]').first()).toBeAttached();
  });
  test("queue user usage is scoped to default partition, not the aggregate", async ({ page }) => {
    const payload = SchedulerResponseSchema.parse(structuredClone(CAPACITY));
    const info = payload.scheduler.schedulerInfo;
    if (info.type !== "capacityScheduler") throw new Error("Expected capacity scheduler fixture");
    const rootQueues = (info as CapacitySchedulerInfo).queues?.queue ?? [];
    const queue = findQueue(rootQueues, "root.etl.ingest");
    if (!queue) throw new Error("Expected root.etl.ingest in scheduler fixture");
    queue.users = {
      user: [
        {
          username: "partition-user",
          numPendingApplications: 0,
          numActiveApplications: 1,
          userWeight: 1,
          resourcesUsed: { memory: 1024, vCores: 2 },
          resources: {
            resourceUsagesByPartition: [
              { partitionName: "", used: { memory: 0, vCores: 0 } },
              { partitionName: "ssd", used: { memory: 1024, vCores: 2 } },
            ],
          },
        },
      ],
    };
    await useScheduler(page, payload);
    await page.goto("/scheduler/root.etl.ingest?parity=1");
    const row = page.locator('[data-ye="root.etl.ingest#partition-user"]');
    const usage = row.locator('[data-yf="queueuser.resourcesUsed"]');
    await expect(usage).toHaveText("0 B · 0 vCores");
    expect(JSON.parse((await usage.getAttribute("data-yv")) ?? "{}")).toMatchObject({ memory: 0, vCores: 0 });
  });

  test("queue detail tabs are clickable and show their matching tables", async ({ page }) => {
    await page.setViewportSize({ width: 1080, height: 520 });
    await page.goto("/scheduler/root.default?parity=1");
    await expect(page.getByRole("heading", { name: "Queue Status" })).toBeVisible();
    const scrollport = page.locator(".burrow-page-scroll");
    const startingScrollTop = await page.evaluate(() => {
      const scrollport = document.querySelector<HTMLElement>(".burrow-page-scroll");
      const tablist = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Queue sections"]');
      if (!scrollport || !tablist) throw new Error("Queue tabs are missing");
      const scrollportRect = scrollport.getBoundingClientRect();
      const tablistRect = tablist.getBoundingClientRect();
      const targetBottom = scrollportRect.top + scrollport.clientTop + scrollport.clientHeight - 8;
      scrollport.scrollTop += tablistRect.bottom - targetBottom;
      return scrollport.scrollTop;
    });

    for (const [name, table] of [
      ["Applications", "scheduler-queue-apps"],
      ["Partitions", "scheduler-partitions"],
      ["Activities", "scheduler-activities"],
      ["Configuration", "scheduler-conf"],
      ["Users", "scheduler-users"],
    ] as const) {
      const tab = page.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(`[data-burrow-table="${table}"]`)).toBeVisible();
      await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBe(startingScrollTop);
    }
  });

  test("fair: the same freeness reading from the fair shape", async ({ page }) => {
    await useScheduler(page, FAIR);
    await page.goto("/scheduler?parity=1");
    await expect(page.getByRole("heading", { name: "Queue headroom" })).toBeVisible();
    expect(await yv(page, "scheduler.type")).toBe("fairScheduler");
    const rowIds = await page
      .locator('[data-burrow-table="scheduler-fair-tree"] [role="row"][data-ye]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.ye));
    expect(rowIds).toContain("root");
    expect(rowIds).toContain("root.etl.transform");
    await expect(page.locator('[data-yf="queue.usedResources.memory"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="queue.derived.fairShareFreeMb"]').first()).toBeVisible();
    // no per-user table in the fair shape, and the health tab says why
    await page.getByRole("tab", { name: "Health" }).click();
    await expect(page.getByText(/Health counters are only reported by the Capacity Scheduler/)).toBeVisible();
  });

  test("fifo: the single-queue block, with fractions converted for display", async ({ page }) => {
    await useScheduler(page, FIFO);
    await page.goto("/scheduler?parity=1");
    await expect(page.getByRole("heading", { name: "FifoScheduler Queue" })).toBeVisible();
    expect(await yv(page, "scheduler.type")).toBe("fifoScheduler");
    expect(await yv(page, "scheduler.qstate")).toBe("RUNNING");
    expect(await yv(page, "scheduler.numNodes")).toBe("0");
    for (const label of [
      "Minimum Queue Memory Capacity",
      "Maximum Queue Memory Capacity",
      "Number of Nodes",
      "Used Node Capacity",
      "Available Node Capacity",
      "Total Node Capacity",
      "Number of Node Containers",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });

  for (const theme of ["dark", "light"] as const) {
    test(`screenshot · capacity · ${theme}`, { tag: "@snapshot" }, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1500 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript(() => {
        try {
          localStorage.setItem("burrow.prefs.v1", JSON.stringify({ theme: "system", tz: "utc", motion: "reduced" }));
        } catch {
          /* storage disabled: the OS scheme applies anyway */
        }
      });
      await page.goto("/scheduler?parity=1");
      await expect(page.getByRole("heading", { name: "Queue headroom" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page).toHaveScreenshot(`scheduler/capacity-${theme}.png`, { fullPage: true });
    });

    test(`screenshot · fair · ${theme}`, { tag: "@snapshot" }, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1200 });
      await useScheduler(page, FAIR);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript(() => {
        localStorage.setItem("burrow.prefs.v1", JSON.stringify({ theme: "system", tz: "utc", motion: "reduced" }));
      });
      await page.goto("/scheduler?parity=1");
      await expect(page.getByRole("heading", { name: "Queue headroom" })).toBeVisible();
      await expect(page).toHaveScreenshot(`scheduler/fair-${theme}.png`, { fullPage: true });
    });

    test(`screenshot · fifo · ${theme}`, { tag: "@snapshot" }, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await useScheduler(page, FIFO);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript(() => {
        localStorage.setItem("burrow.prefs.v1", JSON.stringify({ theme: "system", tz: "utc", motion: "reduced" }));
      });
      await page.goto("/scheduler?parity=1");
      await expect(page.getByRole("heading", { name: "FifoScheduler Queue" })).toBeVisible();
      await expect(page).toHaveScreenshot(`scheduler/fifo-${theme}.png`, { fullPage: true });
    });

    test(`screenshot · queue detail · ${theme}`, { tag: "@snapshot" }, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1400 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript(() => {
        localStorage.setItem("burrow.prefs.v1", JSON.stringify({ theme: "system", tz: "utc", motion: "reduced" }));
      });
      await page.goto("/scheduler/root.default?parity=1");
      await expect(page.getByRole("heading", { name: "Queue Status" })).toBeVisible();
      await expect(page).toHaveScreenshot(`scheduler/queue-${theme}.png`, { fullPage: true });
    });
  }
});
test.describe("timezone-aware scheduler timestamps", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("activity snapshot time switches between local and UTC", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("burrow.prefs.v1", JSON.stringify({ tz: "local", livePaused: true, liveIntervalMs: 30000 }));
    });
    await page.goto("/scheduler?parity=1");
    await page.getByRole("tab", { name: "Activities" }).click();

    const timestamp = page.locator('[data-yf="activities.timestamp"]').first();
    await expect(timestamp).toBeVisible();
    const localTime = (await timestamp.innerText()).trim();
    await page.getByTestId("tz-toggle").getByRole("button", { name: /UTC/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-tz", "utc");
    await expect(timestamp).not.toHaveText(localTime);
  });
});
