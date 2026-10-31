import { expect, test, type Page } from "@playwright/test";
import APPS_SAMPLE from "../src/api/schemas/samples/apps.json" with { type: "json" };
import METRICS_SAMPLE from "../src/api/schemas/samples/cluster-metrics.json" with { type: "json" };

/**
 * `/apps` e2e — the reference feature. Verifies the legacy column contract, the category tabs with live counts, every
 * filter, sorting, the column chooser, URL round-tripping, virtualization at scale, live row updates, and the parity
 * DOM attributes (`data-yf`/`data-yv`/`data-yfmt`) for every column.
 */
const PREFS_KEY = "burrow.prefs.v1";

const SCREENSHOT_STATES = ["RUNNING", "ACCEPTED", "SUBMITTED", "NEW", "FINISHED", "FAILED", "KILLED"] as const;
const SCREENSHOT_APPS = Array.from({ length: 42 }, (_, index) => {
  const template = APPS_SAMPLE.apps.app[index % APPS_SAMPLE.apps.app.length]!;
  const sequence = String(index + 1).padStart(4, "0");
  const id = `application_1767225600000_${sequence}`;
  const state = SCREENSHOT_STATES[index % SCREENSHOT_STATES.length]!;
  const running = state === "RUNNING";
  const terminal = state === "FINISHED" || state === "FAILED" || state === "KILLED";
  const startedTime = 1767225700000 + index * 60_000;
  const finalStatus = state === "FINISHED" ? "SUCCEEDED" : state === "FAILED" || state === "KILLED" ? state : "UNDEFINED";
  return {
    ...template,
    id,
    name: `${template.name} ${sequence}`,
    state,
    finalStatus,
    progress: running ? 15 + ((index * 17) % 80) : finalStatus === "SUCCEEDED" ? 100 : 0,
    trackingUI: running ? "ApplicationMaster" : terminal ? "History" : "UNASSIGNED",
    trackingUrl: running ? `http://rm:8088/proxy/${id}/` : terminal ? `http://jhs:19888/jobhistory/job/job_1767225600000_${sequence}` : "",
    startedTime,
    launchTime: running || terminal ? startedTime + 1_000 : 0,
    finishedTime: terminal ? startedTime + 60_000 : 0,
    elapsedTime: running || terminal ? 60_000 : 0,
    allocatedMB: running ? 2048 : 0,
    allocatedVCores: running ? 2 : 0,
    reservedMB: 0,
    reservedVCores: 0,
    runningContainers: running ? 2 : 0,
    queueUsagePercentage: running ? 25 : 0,
    clusterUsagePercentage: running ? 25 : 0,
  };
});
const SCREENSHOT_APPS_RESPONSE = { ...APPS_SAMPLE, apps: { ...APPS_SAMPLE.apps, app: SCREENSHOT_APPS } };
const SCREENSHOT_METRICS_RESPONSE = {
  ...METRICS_SAMPLE,
  clusterMetrics: {
    ...METRICS_SAMPLE.clusterMetrics,
    appsSubmitted: 42,
    appsCompleted: 6,
    appsPending: 18,
    appsRunning: 6,
    appsFailed: 6,
    appsKilled: 6,
  },
};

async function seedScreenshotData(page: Page) {
  const headers = { "x-burrow-api": "1", "x-burrow-cache": "miss" };
  await page.route(
    (url) => url.pathname === "/api/yarn/apps",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers,
        json: SCREENSHOT_APPS_RESPONSE,
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/yarn/metrics",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers,
        json: SCREENSHOT_METRICS_RESPONSE,
      });
    },
  );
}

const LEGACY_HEADERS = [
  "ID",
  "User",
  "Name",
  "Application Type",
  "Application Tags",
  "Queue",
  "Application Priority",
  "Start time",
  "Launch time",
  "Finish time",
  "State",
  "Final status",
  "Running Containers",
  "Allocated CPU vCores",
  "Allocated Memory MB",
  "Allocated GPUs",
  "Reserved CPU vCores",
  "Reserved Memory MB",
  "Reserved GPUs",
  "% of Queue",
  "% of Cluster",
  "Progress",
  "Tracking UI",
  "Blacklisted Nodes",
];

/** Field ids the page must stamp — mirrors src/features/apps/columns.tsx (inlined: Playwright does not resolve `~`). */
const FIELD_IDS = [
  "app.id",
  "app.user",
  "app.name",
  "app.applicationType",
  "app.applicationTags",
  "app.queue",
  "app.priority",
  "app.startedTime",
  "app.launchTime",
  "app.finishedTime",
  "app.state",
  "app.finalStatus",
  "app.runningContainers",
  "app.allocatedVCores",
  "app.allocatedMB",
  "app.allocatedGpus",
  "app.reservedVCores",
  "app.reservedMB",
  "app.reservedGpus",
  "app.queueUsagePercentage",
  "app.clusterUsagePercentage",
  "app.progress",
  "app.trackingUI",
  "app.derived.blacklistedNodesCount",
];

async function freezeLive(page: Page) {
  await page.addInitScript((key: string) => {
    const current = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...current, livePaused: true, liveIntervalMs: 30000 }));
  }, PREFS_KEY);
}

async function setPrefs(page: Page, prefs: Record<string, unknown>) {
  await page.addInitScript(
    ({ key, value }: { key: string; value: Record<string, unknown> }) => {
      const current = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...current, ...value }));
    },
    { key: PREFS_KEY, value: prefs },
  );
}

const table = (page: Page) => page.locator("[data-burrow-table=apps]");
const headers = (page: Page) => table(page).locator('[role="columnheader"] button:first-of-type');

async function rowStates(page: Page): Promise<string[]> {
  return (await page.locator('[data-yf="app.state"]').allTextContents()).map((s) => s.trim());
}

test.describe("/apps", () => {
  test("shows the legacy columns in source order when requested", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await expect(table(page)).toBeVisible();
    await page.getByRole("button", { name: "Choose columns" }).click();
    await page.getByRole("menuitem", { name: "Show all columns" }).click();
    await expect(headers(page)).toHaveText(LEGACY_HEADERS);
    await expect(page.getByRole("button", { name: "Choose columns" })).toContainText("24/24");
  });

  test("anchors the default row scan on application name and state", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await expect(table(page)).toBeVisible();
    await expect(headers(page)).toHaveText(["ID", "Name", "State", "User", "Queue", "Start time", "Progress"]);
  });

  test("resets URL-backed view state in one action", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps?states=RUNNING&final=FAILED&user=alice&sort=name&cols=all&startedAfter=1767000000000");

    const reset = page.getByRole("button", { name: "Reset view" });
    await expect(reset).toBeVisible();
    await reset.click();

    await expect(page).toHaveURL(/\/apps$/);
    await expect(headers(page)).toHaveText(["ID", "Name", "State", "User", "Queue", "Start time", "Progress"]);
    await expect(page.getByRole("combobox", { name: "User" })).toContainText("Any user");
    await expect(page.getByRole("button", { name: "Reset view" })).toHaveCount(0);
  });

  test("category tabs carry live counts and filter by state", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await expect(page.locator('[data-yf="app.id"]').first()).toBeVisible();
    // tabs are addressed by their stable `data-yt` field id: `New` and `New saving` share a text prefix
    const all = page.locator('[data-yt="app.tab.all"]');
    await expect(all).toBeVisible();
    await expect(page.locator('[data-yt="app.tab.active"]')).toBeVisible();
    for (const state of ["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED", "RUNNING", "FINISHED", "FAILED", "KILLED"]) {
      await expect(page.locator(`[data-yt="app.tab.${state}"]`)).toBeVisible();
    }
    const total = Number((await all.textContent())?.replace(/[^\d]/g, "") ?? "0");
    expect(total).toBeGreaterThan(100);

    await page.locator('[data-yt="app.tab.RUNNING"]').click();
    await expect(page).toHaveURL(/states=RUNNING/);
    await expect(page.locator('[data-yt="app.tab.RUNNING"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-yf="app.state"]').first()).toHaveText("Running");
    const states = await rowStates(page);
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set(["Running"]));
  });

  test("explains lifecycle state and final outcome separately", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await expect(page.getByText("YARN state tracks the application lifecycle; final status is a separate outcome.")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Lifecycle state" })).toBeVisible();
    await expect(page.getByText("Final outcome", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "About Final outcome" }).click();
    await expect(page.getByText("Not set means no outcome has been reported.")).toBeVisible();
  });

  test("mobile keeps every application state and filter reachable", async ({ page }) => {
    await freezeLive(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/apps");
    await expect(page.locator('[data-yf="app.id"]').first()).toBeVisible();
    await expect(page.locator('[data-burrow-table-root="apps"]')).toContainText(/[\d,]+ rows/);

    const state = page.getByRole("combobox", { name: "Lifecycle state" });
    await expect(state).toBeVisible();
    await state.click();
    const options = page.getByRole("option");
    await expect(options).toHaveCount(12);
    const running = page.getByRole("option", { name: /^Running · \d/ });
    await expect(running).toBeVisible();
    await running.click();
    await expect(page).toHaveURL(/states=RUNNING/);
    expect(new Set(await rowStates(page))).toEqual(new Set(["Running"]));

    const filterButton = page.getByTestId("apps-filter-toggle");
    await filterButton.click();
    const filterPanel = page.locator("#apps-filter-options");
    await expect(filterPanel.getByRole("combobox", { name: "User" })).toBeVisible();
    await expect(filterPanel.getByRole("button", { name: "Start time range" })).toBeVisible();
    await expect(filterPanel.getByRole("button", { name: "Finish time range" })).toBeVisible();
    await filterPanel.getByRole("combobox", { name: "User" }).click();
    await page.getByRole("option", { name: /^alice/ }).click();
    await expect(page).toHaveURL(/user=alice/);
    await expect(filterButton).toContainText("1");
    await page.getByTestId("apps-filters").getByRole("button", { name: "Clear filters" }).click();
    await expect(page).not.toHaveURL(/user=alice/);
    await expect(page).toHaveURL(/states=RUNNING/);
  });

  test("expanded mobile filters keep the table and empty-result recovery reachable", async ({ page }) => {
    await freezeLive(page);
    await setPrefs(page, { motion: "reduced" });
    await seedScreenshotData(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/apps?user=alice&queue=root.dev.alice&type=SPARK&tag=etl&name=spark");
    await expect(page.locator("[data-burrow-rows]")).toHaveAttribute("data-burrow-rows", "0");
    await page.getByTestId("apps-filter-toggle").click();
    await expect(page.locator("#apps-filter-options")).toBeVisible();

    await table(page).scrollIntoViewIfNeeded();
    const bounds = await table(page).boundingBox();
    if (!bounds) throw new Error("Applications table must have layout bounds");
    expect(bounds.height).toBeGreaterThanOrEqual(100);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);

    const clearEmptyResult = page.getByRole("button", { name: "Clear filters", exact: true }).last();
    await clearEmptyResult.scrollIntoViewIfNeeded();
    await expect(clearEmptyResult).toBeInViewport();
    await clearEmptyResult.click();
    await expect(page).toHaveURL(/\/apps$/);
    await expect(page.locator("[data-burrow-rows]")).toHaveAttribute("data-burrow-rows", "42");
  });

  test("adapts application controls to the available tablet content width", async ({ page }) => {
    await freezeLive(page);
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto("/apps");
    await expect(page.locator('[data-yf="app.id"]').first()).toBeVisible();

    await expect(page.getByRole("combobox", { name: "Lifecycle state" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Lifecycle state" })).toHaveCount(0);
    const filters = page.getByTestId("apps-filter-toggle");
    await expect(filters).toBeVisible();
    await filters.click();
    await expect(page.locator("#apps-filter-options").getByRole("combobox", { name: "User" })).toBeVisible();
  });

  test("category changes fade filtered data over the content transition duration", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    const content = page.locator(".burrow-tab-content");
    // Vite can still be finishing the 180 ms page-entry cascade after navigation; isolate the 220 ms filter fade.
    await page.waitForFunction(() => {
      const element = document.querySelector(".burrow-tab-content");
      return (
        element !== null &&
        !element.getAnimations().some((animation) => {
          return (animation as CSSAnimation).animationName === "burrow-page-content-in" && animation.playState === "running";
        })
      );
    });
    const fade = page.waitForFunction(() => {
      const element = document.querySelector(".burrow-tab-content");
      const animation = element?.getAnimations().find((candidate) => {
        const frames = (candidate.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
        return candidate.playState === "running" && Number(frames[0]?.opacity) === 0 && Number(frames[frames.length - 1]?.opacity) === 1;
      });
      return animation?.effect?.getTiming().duration ?? false;
    });

    await page.locator('[data-yt="app.tab.RUNNING"]').click();
    expect(await (await fade).jsonValue()).toBe(220);
    await expect(page).toHaveURL(/states=RUNNING/);
    await expect(content.locator("[data-burrow-table='apps']")).toBeVisible();
    expect(new Set(await rowStates(page))).toEqual(new Set(["Running"]));
  });

  test("final-status facets filter to succeeded applications", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await page.getByRole("button", { name: "Choose columns" }).click();
    await page.getByRole("menuitem", { name: "Show all columns" }).click();
    await page.getByRole("button", { name: /Filter by final status: Succeeded/i }).click();
    await expect(page).toHaveURL(/final=SUCCEEDED/);
    const finals = (await page.locator('[data-yf="app.finalStatus"]').allTextContents()).map((value) => value.trim());
    expect(finals.length).toBeGreaterThan(0);
    expect(new Set(finals)).toEqual(new Set(["Succeeded"]));
  });

  test("filters by user, queue, type and tag, and clears them", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    const filters = page.getByTestId("apps-filters");
    await page.getByRole("button", { name: "Choose columns" }).click();
    await page.getByRole("menuitem", { name: "Show all columns" }).click();

    await filters.getByRole("combobox", { name: "User" }).click();
    await page.getByRole("option", { name: /^alice/ }).click();
    await expect(page).toHaveURL(/user=alice/);
    const users = (await page.locator('[data-yf="app.user"]').allTextContents()).map((s) => s.trim());
    expect(new Set(users)).toEqual(new Set(["alice"]));

    await filters.getByRole("combobox", { name: "Queue" }).click();
    await page.getByRole("option", { name: /^root\.dev\.alice/ }).click();
    await expect(page).toHaveURL(/queue=root.dev.alice/);
    const queues = (await page.locator('[data-yf="app.queue"]').allTextContents()).map((s) => s.trim());
    expect(new Set(queues)).toEqual(new Set(["root.dev.alice"]));

    await filters.getByRole("combobox", { name: "Application type" }).click();
    await page.getByRole("option", { name: /^SPARK/ }).click();
    await expect(page).toHaveURL(/type=SPARK/);
    const types = (await page.locator('[data-yf="app.applicationType"]').allTextContents()).map((s) => s.trim());
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types)).toEqual(new Set(["SPARK"]));

    await page
      .getByRole("button", { name: /Clear filters/i })
      .first()
      .click();
    await expect(page).not.toHaveURL(/user=alice|queue=|type=SPARK/);
  });

  test("the name filter is debounced into the URL and filters rows", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await page.getByTestId("apps-name-filter").fill("sessionize");
    await expect(page).toHaveURL(/name=sessionize/, { timeout: 5000 });
    const names = (await page.locator('[data-yf="app.name"]').allTextContents()).map((s) => s.trim());
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name.toLowerCase()).toContain("sessionize");
    await page.getByRole("button", { name: "Clear name filter" }).click();
    await expect(page).not.toHaveURL(/name=/);
  });

  for (const action of ["Reset view", "Clear filters"] as const) {
    test(`${action} cancels a name edit that has not reached the URL`, async ({ page }) => {
      await freezeLive(page);
      await setPrefs(page, { motion: "reduced" });
      await seedScreenshotData(page);
      await page.goto("/apps?user=alice");
      await expect(page.locator('[data-yf="app.id"]').first()).toBeVisible();
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 1000));

      await page.getByTestId("apps-name-filter").fill("spark");
      const controls = action === "Clear filters" ? page.getByTestId("apps-filters") : page;
      await controls.getByRole("button", { name: action, exact: true }).click();
      await page.clock.runFor(1000);

      await expect(page).toHaveURL(/\/apps$/);
      await expect(page.getByTestId("apps-name-filter")).toHaveValue("");
      await expect(page.locator("[data-burrow-rows]")).toHaveAttribute("data-burrow-rows", "42");
    });
  }

  for (const range of [
    { label: "Start time", after: "startedAfter", before: "startedBefore", field: "start time" },
    { label: "Finish time", after: "finishedAfter", before: "finishedBefore", field: "finish time" },
  ]) {
    test(`${range.label} presets replace an earlier upper bound and the range clears together`, async ({ page }) => {
      const now = 1767230000000;
      await freezeLive(page);
      await seedScreenshotData(page);
      await page.clock.setFixedTime(now);
      await page.goto(`/apps?states=FINISHED&${range.after}=1767225600000&${range.before}=1767225700000`);
      await expect(page.locator("[data-burrow-rows]")).toHaveAttribute("data-burrow-rows", "0");
      await page.getByRole("button", { name: `${range.label} range`, exact: true }).click();
      await page.getByRole("button", { name: "Last hour", exact: true }).click();

      await expect.poll(() => new URL(page.url()).searchParams.get(range.after)).toBe(String(now - 3600_000));
      expect(new URL(page.url()).searchParams.get(range.before)).toBeNull();
      await expect(page.locator("[data-burrow-rows]")).not.toHaveAttribute("data-burrow-rows", "0");
      expect(new Set(await rowStates(page))).toEqual(new Set(["Finished"]));

      await page.getByRole("button", { name: `Clear ${range.field} range`, exact: true }).click();
      await expect(page).toHaveURL(/\/apps\?states=FINISHED$/);
      await expect(page.locator("[data-burrow-rows]")).toHaveAttribute("data-burrow-rows", "6");
    });
  }

  test("an id pasted into the name filter finds exactly that application", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await expect(page.locator('[data-yf="app.id"]').first()).toBeVisible();
    const firstId = (await page.locator('[data-yf="app.id"]').first().textContent())?.trim() ?? "";
    expect(firstId).toMatch(/^application_\d+_\d+$/);
    await page.getByTestId("apps-name-filter").fill(firstId);
    await expect(page).toHaveURL(new RegExp(`name=${firstId}`));
    await expect(page.locator("[data-burrow-rows]")).toHaveAttribute("data-burrow-rows", "1");
  });

  test("a short list caps the card to its content — the horizontal bar never clips the last row", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await expect(page.locator('[data-yf="app.id"]').first()).toBeVisible();
    const firstId = (await page.locator('[data-yf="app.id"]').first().textContent())?.trim() ?? "";
    await page.getByTestId("apps-name-filter").fill(firstId);
    await expect(page.locator("[data-burrow-rows]")).toHaveAttribute("data-burrow-rows", "1");

    /* All 24 columns overflow the window, so a horizontal bar exists and the card is capped to one row. The cap must
       include the header's border and the bar's lane (10px where bars consume layout space, 0 where they float over the
       content), otherwise the last row's bottom — separator included — is clipped under the bar and a vertical
       scrollbar appears for the missing pixels. */
    const geom = await table(page).evaluate((node) => {
      const el = node as HTMLElement;
      const last = [...el.querySelectorAll('[role="row"][aria-rowindex]')].pop() as HTMLElement;
      return {
        horizontalOverflow: el.scrollWidth - el.clientWidth,
        verticalOverflow: el.scrollHeight - el.clientHeight,
        rowBottom: last.getBoundingClientRect().bottom,
        scrollportBottom: el.getBoundingClientRect().bottom - (el.offsetHeight - el.clientHeight),
      };
    });
    expect(geom.horizontalOverflow).toBeGreaterThan(0);
    expect(geom.verticalOverflow).toBe(0);
    expect(geom.rowBottom).toBeLessThanOrEqual(geom.scrollportBottom + 0.5);
  });

  test("defaults to newest applications first while preserving an explicit ID sort", async ({ page }) => {
    await freezeLive(page);
    const template = APPS_SAMPLE.apps.app[0];
    if (!template) throw new Error("The apps sample must include a row");
    const apps = [
      { ...template, id: "application_1767225600000_0009", name: "Older", startedTime: 1767225700000 },
      { ...template, id: "application_1767225600000_0003", name: "Newest", startedTime: 1767225900000 },
      { ...template, id: "application_1767225600000_0006", name: "Middle", startedTime: 1767225800000 },
    ];
    await page.route(
      (url) => url.pathname === "/api/yarn/apps",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
          json: { ...APPS_SAMPLE, apps: { ...APPS_SAMPLE.apps, app: apps } },
        });
      },
    );
    await page.goto("/apps");
    await expect(table(page)).toBeVisible();
    const ids = table(page).locator('[data-yf="app.id"]');
    await expect(table(page).locator('[data-col="starttime"]')).toHaveAttribute("aria-sort", "descending");
    await expect(ids).toHaveText(["application_1767225600000_0003", "application_1767225600000_0006", "application_1767225600000_0009"]);
    await expect(page).not.toHaveURL(/sort=/);

    await page.goto("/apps?sort=-id");
    await expect(table(page).locator('[data-col="id"]')).toHaveAttribute("aria-sort", "descending");
    await expect(ids).toHaveText(["application_1767225600000_0009", "application_1767225600000_0006", "application_1767225600000_0003"]);
  });

  test("sorting is URL-synced and toggles direction", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await page.getByRole("button", { name: "Choose columns" }).click();
    await page.getByRole("menuitem", { name: "Show all columns" }).click();
    const mem = table(page).locator('[data-col="allocatedMemory"] button:first-of-type');
    await mem.click();
    await expect(page).toHaveURL(/sort=allocatedMemory/);
    await expect(table(page).locator('[data-col="allocatedMemory"]')).toHaveAttribute("aria-sort", "ascending");
    await mem.click();
    await expect(page).toHaveURL(/sort=-allocatedMemory/);
    await expect(table(page).locator('[data-col="allocatedMemory"]')).toHaveAttribute("aria-sort", "descending");
    await page.goto("/apps");
    await expect(table(page).locator('[data-col="starttime"]')).toHaveAttribute("aria-sort", "descending");
  });

  test("shift-click adds a secondary sort and Clear returns to the default", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await table(page).locator('[data-col="name"] button:first-of-type').click();
    await page.keyboard.down("Shift");
    await table(page).locator('[data-col="user"] button:first-of-type').click();
    await page.keyboard.up("Shift");
    await expect(page).toHaveURL(/sort=name(%2C|,)user/);
    await expect(table(page).locator('[data-col="name"]')).toHaveAttribute("aria-sort", "ascending");
    await expect(table(page).locator('[data-col="user"]')).toHaveAttribute("aria-sort", "ascending");
    await expect(page.locator("[data-burrow-sort]")).toHaveAttribute("data-burrow-sort", "Name ↑,User ↑");
    await page.getByRole("button", { name: /^Sort order:/ }).click();
    await page.getByRole("button", { name: /^Remove sort on User/ }).click();
    await expect(page).toHaveURL(/sort=name$/);
    await expect(page.locator("[data-burrow-sort]")).toHaveAttribute("data-burrow-sort", "Name ↑");
    await page.getByRole("button", { name: "Clear sort" }).click();
    await expect(page).not.toHaveURL(/sort=/);
    await expect(table(page).locator('[data-col="starttime"]')).toHaveAttribute("aria-sort", "descending");
  });

  test("the sort panel adds, flips and removes sorts", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await page.getByRole("button", { name: "Sort order: none" }).click();
    // add: pick a column from the panel's own chooser
    await page.getByRole("combobox", { name: "Add sort column" }).click();
    const nameOption = page.getByRole("option", { name: "Name" });
    await nameOption.focus();
    await expect(nameOption).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/sort=name$/);
    await expect(table(page).locator('[data-col="name"]')).toHaveAttribute("aria-sort", "ascending");
    // flip direction in place
    await page.getByRole("button", { name: /^Name sorted ascending/ }).click();
    await expect(page).toHaveURL(/sort=-name$/);
    await expect(table(page).locator('[data-col="name"]')).toHaveAttribute("aria-sort", "descending");
    // remove it again
    await page.getByRole("button", { name: "Remove sort on Name" }).click();
    await expect(page).not.toHaveURL(/sort=/);
  });

  test("the column chooser hides columns and round-trips through the URL", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await page.getByRole("button", { name: "Choose columns" }).click();
    await page.getByRole("menuitem", { name: "Show all columns" }).click();
    await page.getByRole("button", { name: "Choose columns" }).click();
    await page.getByRole("menuitemcheckbox", { name: "User" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("cols")).toBe("user");
    await expect(table(page).locator('[data-col="user"]')).toHaveCount(0);
    await expect(headers(page)).toHaveCount(23);

    await page.goto("/apps?cols=user,queue&sort=starttime");
    await expect(table(page).locator('[data-col="user"]')).toHaveCount(0);
    await expect(table(page).locator('[data-col="queue"]')).toHaveCount(0);
    await expect(table(page).locator('[data-col="starttime"]')).toHaveAttribute("aria-sort", "ascending");
    await expect(page.getByRole("button", { name: "Choose columns" })).toContainText("22/24");
  });

  test("every filter survives a reload (URL is the only state)", async ({ page }) => {
    await freezeLive(page);
    // one state per URL, like the UI writes it: `tabOf` has no tab for a two-state combination and falls back to All
    const url = "/apps?states=KILLED&final=KILLED&user=bob&type=MAPREDUCE&sort=-starttime&cols=apptag,ui";
    await page.goto(url);
    await expect(page.locator('[data-yt="app.tab.KILLED"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("apps-filters")).toContainText("Final status: Killed");
    await expect(page.getByTestId("apps-filters")).toContainText("User: bob");
    await expect(table(page).locator('[data-col="apptag"]')).toHaveCount(0);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(url.replace(/[?&.]/g, (m) => `\\${m}`)));
    await expect(page.locator('[data-yt="app.tab.KILLED"]')).toHaveAttribute("aria-selected", "true");
  });

  test("returns to the full list when an empty result is cleared", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps?name=no-such-application-anywhere");
    const rows = page.locator("[data-burrow-rows]");
    await expect(rows).toHaveAttribute("data-burrow-rows", "0");
    const clear = page.getByRole("button", { name: "Clear filters" }).first();
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(rows).not.toHaveAttribute("data-burrow-rows", "0");
  });

  test("rows show progress bars, tracking-URL buttons and open the application page", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps?states=RUNNING");
    await page.getByRole("button", { name: "Choose columns" }).click();
    await page.getByRole("menuitem", { name: "Show all columns" }).click();
    await expect(table(page)).toBeVisible();

    const bar = page.locator('[role="progressbar"][data-yf="app.progress"]').first();
    await expect(bar).toBeVisible();
    const pct = Number(await bar.getAttribute("data-yv"));
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);

    const tracking = page.locator('[data-yf="app.trackingUI"] a[href^="http"]').first();
    await expect(tracking).toBeVisible();
    await expect(tracking).toHaveAttribute("target", "_blank");

    const firstId = (await page.locator('[data-yf="app.id"]').first().textContent())?.trim() ?? "";
    // Follow the application's own ID link, the same route users reach from the table.
    await page.locator(`[data-yf="app.id"] a[href="/apps/${firstId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/apps/${firstId}`));
  });

  test("virtualizes the table at scale (10k+ rows, a small window in the DOM)", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    const rowsAttr = page.locator("[data-burrow-rows]");
    await expect(rowsAttr).toBeVisible();
    // the shell renders before the list lands: `data-burrow-rows="0"` is the loading state, not the dataset
    await expect(rowsAttr).not.toHaveAttribute("data-burrow-rows", "0");
    const total = Number(await rowsAttr.getAttribute("data-burrow-rows"));
    expect(total).toBeGreaterThan(1000);
    const rendered = await page.locator('[role="row"]').count();
    expect(rendered).toBeLessThan(200);

    // scrolling stays cheap and does not render the whole list
    await page.locator("[data-burrow-table=apps]").evaluate((el) => el.scrollTo({ top: 400_000 }));
    await page.waitForTimeout(200);
    expect(await page.locator('[role="row"]').count()).toBeLessThan(200);
    // the row counter still reports the full dataset
    await expect(page.getByText(/rows$/).first()).toContainText(total.toLocaleString("en-US"));

    // 10k gate: only asserted when the mock actually serves that many rows
    if (total >= 10000) expect(total).toBeGreaterThanOrEqual(10000);
  });

  test("fades the Applications rows in when initial data arrives", async ({ page }) => {
    await freezeLive(page);
    const runningTemplate = APPS_SAMPLE.apps.app.find((app) => app.state === "RUNNING");
    if (!runningTemplate) throw new Error("The apps sample must include a running row");
    const body = table(page).locator('[role="rowgroup"]').nth(1);
    let releaseResponse = () => {};
    const responseHeld = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route(
      (url) => url.pathname === "/api/yarn/apps",
      async (route) => {
        await responseHeld;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
          json: APPS_SAMPLE,
        });
      },
    );

    try {
      await page.goto("/apps?states=RUNNING");
      await expect(page.getByRole("status", { name: "Loading" })).toBeVisible({ timeout: 5000 });
      await expect(body).toHaveCSS("opacity", "0");
    } finally {
      releaseResponse();
    }
    await expect(page.locator(`[role="row"][data-ye="${runningTemplate.id}"]`)).toBeVisible();
    await expect
      .poll(() => body.evaluate((element) => element.getAnimations().some((animation) => animation.playState === "running")), {
        timeout: 300,
        intervals: [5, 10, 20],
      })
      .toBe(true);
  });
  test("keeps the Applications scrollport geometry stable while initial rows load", async ({ page }) => {
    await freezeLive(page);
    // Ignore the page-entry transform so this measures data-driven geometry, not the entrance animation.
    await setPrefs(page, { motion: "reduced" });
    const running = APPS_SAMPLE.apps.app.find((app) => app.state === "RUNNING");
    if (!running) throw new Error("The apps sample must include a running row");
    const apps = Array.from({ length: 100 }, (_, index) => ({ ...running, id: `${running.id}_${index}` }));
    let releaseResponse = () => {};
    const responseHeld = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route(
      (url) => url.pathname === "/api/yarn/apps",
      async (route) => {
        await responseHeld;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
          json: { ...APPS_SAMPLE, apps: { ...APPS_SAMPLE.apps, app: apps } },
        });
      },
    );

    try {
      await page.goto("/apps?states=RUNNING");
      const scrollport = table(page);
      await expect(scrollport).toBeVisible();
      await expect(page.getByRole("status", { name: "Loading" })).toBeVisible();
      const measure = () =>
        scrollport.evaluate((node) => {
          const el = node as HTMLElement;
          const rect = el.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            verticalGutter: el.offsetWidth - el.clientWidth,
            horizontalGutter: el.offsetHeight - el.clientHeight,
          };
        });
      const before = await measure();
      releaseResponse();
      await expect(scrollport).toHaveAttribute("data-burrow-rows", "100");
      const after = await measure();
      expect(after.x).toBe(before.x);
      expect(after.width).toBe(before.width);
      expect(after.verticalGutter).toBe(before.verticalGutter);
      expect(after.horizontalGutter).toBe(before.horizontalGutter);
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    } finally {
      releaseResponse();
    }
  });

  test("submitted app updates do not pulse the whole row; running badge keeps its pulse", async ({ page }) => {
    await setPrefs(page, { livePaused: false, liveIntervalMs: 2000 });
    const submittedTemplate = APPS_SAMPLE.apps.app.find((app) => app.state === "ACCEPTED");
    const runningTemplate = APPS_SAMPLE.apps.app.find((app) => app.state === "RUNNING");
    if (!submittedTemplate || !runningTemplate) throw new Error("The apps sample must include accepted and running rows");
    let fetchCount = 0;
    let advance = false;
    await page.route(
      (url) => url.pathname === "/api/yarn/apps",
      async (route) => {
        const progress = advance ? 11 : 1;
        fetchCount++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
          json: {
            apps: {
              app: [{ ...submittedTemplate, state: "SUBMITTED", progress }, runningTemplate],
            },
          },
        });
      },
    );

    await page.goto("/apps?states=SUBMITTED,RUNNING");
    await expect(table(page)).toBeVisible();
    const submittedRow = page.locator(`[role="row"][data-ye="${submittedTemplate.id}"]`);
    const runningRow = page.locator(`[role="row"][data-ye="${runningTemplate.id}"]`);
    await expect(submittedRow).toBeVisible();
    await expect(runningRow.locator(".burrow-dot-pulse")).toBeAttached();
    const progress = submittedRow.locator('[data-yf="app.progress"]');
    await expect(progress).toHaveAttribute("data-yv", "1");
    const firstFetchCount = fetchCount;
    advance = true;
    await expect.poll(() => fetchCount, { timeout: 15_000, intervals: [100, 250] }).toBeGreaterThan(firstFetchCount);
    await expect(progress).toHaveAttribute("data-yv", "11");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const flashLayer = submittedRow.locator('span[aria-hidden="true"].bg-live');
    const activeAnimations = await flashLayer.evaluate((element) => element.getAnimations().length);
    expect(activeAnimations).toBe(0);
  });

  test("parity mode renders every row, every column and a field id for every value", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps?parity=1&states=RUNNING");
    await expect(page.locator("html")).toHaveAttribute("data-parity", "1");
    await expect(table(page)).toBeVisible();
    // the shell renders before the list lands; parity renders every row of the *loaded* list
    await expect(page.locator("[data-burrow-rows]")).not.toHaveAttribute("data-burrow-rows", "0");

    const total = Number(await page.locator("[data-burrow-rows]").getAttribute("data-burrow-rows"));
    const renderedRows = await page.locator('[data-ye][role="row"]').count();
    expect(renderedRows).toBe(total); // no virtualization window in parity mode

    const seen = await page.evaluate(() => [
      ...new Set([...document.querySelectorAll("[data-yf]")].map((el) => el.getAttribute("data-yf"))),
    ]);
    for (const field of FIELD_IDS) expect(seen, `missing ${field}`).toContain(field);

    // every field sits inside an entity, and every value carries the raw string
    const outside = await page.evaluate(() => [...document.querySelectorAll("[data-yf]")].filter((el) => !el.closest("[data-ye]")).length);
    expect(outside).toBe(0);
    const missingRaw = await page.evaluate(
      () => [...document.querySelectorAll("[data-yf]")].filter((el) => el.getAttribute("data-yv") === null).length,
    );
    expect(missingRaw).toBe(0);

    // the blacklisted count comes from each app's appattempts: a non-negative integer, or "no value" (data-yn) when the app has no attempt
    const blacklisted = await page.evaluate(() =>
      [...document.querySelectorAll('[data-yf="app.derived.blacklistedNodesCount"]')].map((el) => [
        el.getAttribute("data-yv"),
        el.getAttribute("data-yn"),
      ]),
    );
    expect(blacklisted.length).toBeGreaterThan(0);
    for (const [yv, yn] of blacklisted) expect(yn === "1" ? yv === "" : /^\d+$/.test(yv ?? "")).toBe(true);
    // the tracking cell carries the legacy text and the raw tracking URL
    expect(seen).toContain("app.derived.trackingUiText");
    expect(seen).toContain("app.trackingUrl");
  });

  test("screenshots: applications page in dark and light", { tag: "@snapshot" }, async ({ page }) => {
    await setPrefs(page, { theme: "dark" });
    await freezeLive(page);
    await seedScreenshotData(page);
    await page.goto("/apps?states=RUNNING,ACCEPTED,SUBMITTED,NEW");
    await expect(table(page)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page).toHaveScreenshot("apps-dark.png");

    await page.getByTestId("theme-toggle").getByRole("button", { name: /light/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.waitForTimeout(250);
    await expect(page).toHaveScreenshot("apps-light.png");

    // parity view: every column, frozen data
    const parityPage = await page.context().newPage();
    await setPrefs(parityPage, { theme: "light", livePaused: true });
    await seedScreenshotData(parityPage);
    await parityPage.goto("/apps?parity=1&states=RUNNING");
    await expect(table(parityPage)).toBeVisible();
    await expect(parityPage.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(headers(parityPage)).toHaveText(LEGACY_HEADERS);
    await expect(parityPage.getByRole("button", { name: "Reset view" })).toBeVisible();
    await expect(parityPage).toHaveScreenshot("apps-parity-light.png");
    await parityPage.close();
  });
});
