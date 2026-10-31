import { expect, test, type Locator } from "@playwright/test";

const APP = "application_1791010984040_0001";
const SPARK = "application_1791010000001_0001";
const SPARK_DAG = "application_1791010000001_0002";
const attempt = "appattempt_1791010984040_0001_000001";
const appContainer = "container_1791010984040_0001_01_000001";
const logContainer = "container_1791015583684_0002_01_000001";
const routes = [
  ["overview", "/", '[data-testid="cluster-metrics"]'],
  ["applications", "/apps", '[data-burrow-table="apps"]'],
  ["application", `/apps/${APP}`, '[data-burrow="app-diagnostics"]'],
  ["attempts", `/apps/${APP}/attempts`, '[data-burrow-table="app-attempts"]'],
  ["attempt", `/apps/${APP}/attempts/${attempt}`, '[data-burrow-table="attempt-containers"]'],
  ["container", `/apps/${APP}/containers/${appContainer}`, '[data-yf="container.containerId"]'],
  ["container-logs", `/apps/${APP}/logs?container=${logContainer}&file=stderr`, '[role="log"]'],
  ["spark-entry", `/apps/${SPARK}/spark`, '[data-yf="spark.job.jobId"]'],
  ["spark-jobs", `/apps/${SPARK}/spark/jobs`, '[data-yf="spark.job.jobId"]'],
  ["spark-job", `/apps/${SPARK}/spark/jobs/0`, '[data-yf="spark.job.status"]'],
  ["spark-stages", `/apps/${SPARK}/spark/stages`, '[data-yf="spark.stage.stageId"]'],
  ["spark-stage", `/apps/${SPARK}/spark/stages/0/0`, '[data-yf="spark.task.taskId"]'],
  ["spark-executors", `/apps/${SPARK}/spark/executors`, '[data-yf="spark.executor.totalTasks"]'],
  ["spark-storage", `/apps/${SPARK}/spark/storage`, '[data-yf="spark.rdd.numCachedPartitions"]'],
  ["spark-rdd", `/apps/${SPARK}/spark/storage/6`, '[data-yf="spark.rdd.id"]'],
  ["spark-environment", `/apps/${SPARK}/spark/environment`, '[data-yf="spark.env.sparkProperties"]'],
  ["spark-sql", "/apps/application_1791010000001_0009/spark/sql", '[data-yf="spark.sql.status"]'],
  ["spark-sql-execution", "/apps/application_1791010000001_0009/spark/sql/0", '[data-yf="spark.sql.status"]'],
  ["spark-streaming", "/apps/application_1791010000001_0007/spark/streaming", '[data-yf="spark.streaming.numProcessedRecords"]'],
  ["spark-timeline", `/apps/${SPARK}/spark/timeline`, '[aria-label="Timeline legend"]'],
  ["nodes", "/nodes", '[data-burrow-table="burrow.nodes"]'],
  ["node", "/nodes/127.0.0.3:8041", '[data-yf="node.id"]'],
  ["node-labels", "/node-labels", '[data-burrow-table="burrow.node-labels"]'],
  ["scheduler", "/scheduler", '[data-burrow-table="scheduler-capacity-tree"]'],
  ["queue", "/scheduler/root.default", '[data-yf="queue.state"]'],
  ["configuration", "/tools/conf", '[data-burrow-table="burrow.tools.conf"]'],
  ["jmx", "/tools/jmx", '[data-burrow-jmx-root="1"]'],
  ["stacks", "/tools/stacks", '[data-burrow-stacks-root="1"]'],
  ["daemon-logs", "/tools/logs", 'tr[data-ye="resourcemanager.log"]'],
] as const;

async function checkMobileHelpControls(page: import("@playwright/test").Page) {
  const controls = page.locator("[data-burrow-help]");
  for (let i = 0; i < (await controls.count()); i++) {
    const help = controls.nth(i);
    if (!(await help.isVisible())) continue;
    const label = await help.getAttribute("data-burrow-help");
    await expect(help).toHaveAttribute("type", "button");
    await expect(help).toHaveAttribute("aria-label", `About ${label}`);
  }
}

async function expectTouchHitArea(target: Locator, label: string) {
  await expect(target, `${label} should be visible`).toBeVisible();
  const box = await target.boundingBox();
  expect(box, `${label} should have a hit area`).not.toBeNull();
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(44);
}

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("burrow.prefs.v1", JSON.stringify({ livePaused: true, motion: "reduced", tz: "utc" })),
  );
});

for (const [name, path, marker] of routes) {
  const capturesScreenshot = ["overview", "applications", "container-logs", "spark-job"].includes(name);
  test(`phone route ${name} renders upstream content within the document width`, {
    tag: capturesScreenshot ? "@snapshot" : undefined,
  }, async ({ page }) => {
    const exceptions: string[] = [];
    const failedApiResponses: string[] = [];
    page.on("pageerror", (error) => exceptions.push(error.message));
    page.on("response", (response) => {
      if (response.url().includes("/api/") && response.status() >= 400) {
        // The node fixture includes a live container but no captured log bytes for it. The page must surface that
        // known unavailable state instead of treating the fixture's explicit 404 as a broken route.
        if (name === "node" && response.status() === 404 && response.url().includes("/api/logs/containers/")) return;
        failedApiResponses.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.goto(path);
    await expect(page.locator(marker).first()).toBeVisible();
    if (name === "application") {
      await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", "28px");
    }
    if (name === "spark-job") {
      const jobHeading = page.getByRole("heading", { level: 2 }).first();
      await expect(jobHeading).toHaveText(/^Job \d+/);
      await expect(jobHeading).toHaveCSS("font-size", "22px");
    }
    if (name === "node") await expect(page.getByRole("heading", { name: "Could not check NodeManager logs" })).toBeVisible();
    const nativeTitles = await page
      .locator("[title]")
      .evaluateAll((els) => els.map((e) => ({ tag: e.tagName, text: e.textContent?.trim().slice(0, 40), title: e.getAttribute("title") })));
    expect(nativeTitles, `${name} should not use browser-native title popups`).toEqual([]);
    await checkMobileHelpControls(page);
    if (name === "spark-timeline") {
      await expect(page.getByRole("table", { name: /Timeline of application/ })).toHaveCount(1);
      await expectTouchHitArea(page.getByRole("button", { name: "Zoom out" }), "Timeline zoom out");
      await expectTouchHitArea(page.getByRole("button", { name: "Zoom in" }), "Timeline zoom in");
    }
    await expect(page.getByTestId("rail-toggle")).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
    const overflow = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(overflow.document).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    expect(exceptions).toEqual([]);
    expect(failedApiResponses, `${name} API responses`).toEqual([]);
    if (name.startsWith("spark-")) {
      const nav = page.getByRole("navigation", { name: "Spark pages" });
      const { client, scroll } = await nav.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      expect(scroll).toBeGreaterThan(client);
      const activeTab = nav.locator('[aria-current="page"]');
      const activeTabBox = await activeTab.boundingBox();
      const navBox = await nav.boundingBox();
      expect(activeTabBox, `${name} active Spark tab should be rendered`).not.toBeNull();
      expect(navBox).not.toBeNull();
      expect(activeTabBox!.x).toBeGreaterThanOrEqual(navBox!.x - 1);
      expect(activeTabBox!.x + activeTabBox!.width).toBeLessThanOrEqual(navBox!.x + navBox!.width + 1);
      const cues = nav.locator("..");
      const initialEdges = await nav.evaluate((element) => ({
        left: element.scrollLeft > 1,
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      }));
      await expect(cues.locator('[data-scroll-cue="left"]')).toHaveCSS("opacity", initialEdges.left ? "1" : "0");
      await expect(cues.locator('[data-scroll-cue="right"]')).toHaveCSS("opacity", initialEdges.right ? "1" : "0");
      await nav.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect(cues.locator('[data-scroll-cue="left"]')).toHaveCSS("opacity", "1");
      await expect(cues.locator('[data-scroll-cue="right"]')).toHaveCSS("opacity", "0");
      await nav.evaluate((element) => {
        element.scrollLeft = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect(cues.locator('[data-scroll-cue="left"]')).toHaveCSS("opacity", "0");
      await expect(cues.locator('[data-scroll-cue="right"]')).toHaveCSS("opacity", "1");
    }
    if (capturesScreenshot) {
      await expect(page).toHaveScreenshot(`mobile/${name}.png`);
    }
  });
}

test("375px Timeline zoom controls meet the 44px hit-area minimum", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/apps/${SPARK}/spark/timeline`);
  await expect(page.getByRole("table", { name: /Timeline of application/ })).toHaveCount(1);
  await expectTouchHitArea(page.getByRole("button", { name: "Zoom out" }), "Timeline zoom out");
  await expectTouchHitArea(page.getByRole("button", { name: "Zoom in" }), "Timeline zoom in");
  await expectTouchHitArea(page.getByRole("button", { name: "Fit" }), "Timeline Fit");
});

test("phone Spark Environment disclosure can be tapped reliably", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/apps/${SPARK}/spark/environment`);

  const disclosure = page.getByRole("button", { name: "Spark Properties" });
  await expectTouchHitArea(disclosure, "Spark Properties disclosure");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
});

test("phone SQL plan disclosures have usable hit areas", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/apps/application_1791010000001_0009/spark/sql/0");

  await page.getByText("Raw plan tree", { exact: true }).click();
  const disclosure = page.locator('[data-yf="spark.sql.planDescription"] button').first();
  await expectTouchHitArea(disclosure, "SQL plan disclosure");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
});

test("phone topbar and overview help buttons meet the 44px hit-area minimum", async ({ page }) => {
  await page.setViewportSize({ width: 354, height: 784 });
  await page.goto("/");

  const topbarTargets = ["rail-toggle", "live-pause", "palette-trigger", "connection"];
  for (const testId of topbarTargets) {
    const target = page.getByTestId(testId);
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    expect(box, `${testId} should have a hit area`).not.toBeNull();
    expect(box!.width, `${testId} width`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(44);
  }

  const helpButtons = page.locator(".burrow-help");
  expect(await helpButtons.count()).toBeGreaterThan(0);
  for (let index = 0; index < (await helpButtons.count()); index++) {
    const help = helpButtons.nth(index);
    if (!(await help.isVisible())) continue;
    const box = await help.boundingBox();
    expect(box, `help button ${index} should have a hit area`).not.toBeNull();
    expect(box!.width, `help button ${index} width`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `help button ${index} height`).toBeGreaterThanOrEqual(44);
  }

  await page.getByTestId("rail-toggle").click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  const primaryLink = drawer.locator(".burrow-nav-link").first();
  await expect(primaryLink).toBeVisible();
  expect((await primaryLink.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

  await page.goto(`/apps/${SPARK}/spark/jobs`);
  for (const label of ["Application sections", "Spark pages"]) {
    const firstLink = page.getByRole("navigation", { name: label }).getByRole("link").first();
    await expect(firstLink).toBeVisible();
    expect((await firstLink.boundingBox())?.height ?? 0, `${label} link height`).toBeGreaterThanOrEqual(44);
  }
});

test("phone and tablet content controls meet the 44px hit-area minimum", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/apps");
  await expect(page.locator('[data-burrow-table="apps"]')).toBeVisible();
  const appIdLink = page.locator('[data-burrow-table="apps"] [data-yf="app.id"] a').first();
  await expectTouchHitArea(appIdLink, "Application ID list link");
  const appRow = appIdLink.locator('xpath=ancestor::*[@role="row"]');
  expect((await appRow.boundingBox())?.height ?? 0, "Application row should make room for its link target").toBeGreaterThanOrEqual(44);
  await expectTouchHitArea(page.getByRole("combobox", { name: "Lifecycle state" }), "Application lifecycle selector");
  await expectTouchHitArea(page.getByTestId("apps-name-filter"), "Application name filter");
  await expectTouchHitArea(page.getByRole("button", { name: /Filter by final status/ }).first(), "Final status filter");
  await expectTouchHitArea(page.getByRole("button", { name: /Sort order:/ }), "Table sort control");
  await expectTouchHitArea(page.getByRole("button", { name: "Choose columns" }), "Choose columns control");
  await expectTouchHitArea(page.getByRole("button", { name: "Export" }), "Export control");
  await expectTouchHitArea(page.locator('[data-burrow-table="apps"] [role="columnheader"] button').first(), "Table heading control");

  await page.goto(`/apps/${APP}`);
  await expect(page.locator('[data-burrow="app-diagnostics"]')).toBeVisible();
  await expectTouchHitArea(page.getByRole("button", { name: "Copy application ID to clipboard" }), "Copy application ID");
  await expectTouchHitArea(page.getByRole("button", { name: "About application diagnostics" }), "Diagnostics help");
  await expectTouchHitArea(page.getByRole("button", { name: "About resource usage" }), "Resource usage help");
  await expectTouchHitArea(page.getByRole("button", { name: "Copy diagnostics to clipboard" }), "Copy diagnostics");
  await expectTouchHitArea(page.locator(".burrow-touch-link").first(), "Application detail navigation link");

  await page.goto("/");
  const historyControls = page.getByRole("group", { name: "Utilisation history window" }).getByRole("button");
  for (let index = 0; index < (await historyControls.count()); index++) {
    await expectTouchHitArea(historyControls.nth(index), `Overview history window ${index + 1}`);
  }
  const linkedMetric = page
    .locator(".burrow-overview-card-grid > div")
    .filter({ has: page.locator(".burrow-touch-link") })
    .first();
  const metricCard = linkedMetric.locator("article");
  const metricCardBox = await metricCard.boundingBox();
  const metricLink = linkedMetric.locator(".burrow-touch-link");
  await expectTouchHitArea(metricLink, "Overview metric link");
  const metricLinkBox = await metricLink.boundingBox();
  expect(metricCardBox).not.toBeNull();
  expect(metricLinkBox!.x).toBeGreaterThanOrEqual(metricCardBox!.x);
  expect(metricLinkBox!.x + metricLinkBox!.width).toBeLessThanOrEqual(metricCardBox!.x + metricCardBox!.width + 0.5);
  expect(metricLinkBox!.y).toBeGreaterThanOrEqual(metricCardBox!.y);
  expect(metricLinkBox!.y + metricLinkBox!.height).toBeLessThanOrEqual(metricCardBox!.y + metricCardBox!.height + 0.5);

  await page.goto(`/apps/${APP}/logs?container=${logContainer}&file=stderr`);
  const logButtons = page.locator(".burrow-log-toolbar button:not([role='switch'])");
  await expect(logButtons.first()).toBeVisible();
  for (let index = 0; index < (await logButtons.count()); index++) {
    await expectTouchHitArea(logButtons.nth(index), `Log toolbar control ${index + 1}`);
  }
  await expectTouchHitArea(page.getByRole("switch", { name: "Follow new log output" }), "Log follow switch");

  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/apps");
  const tabletAppIdLink = page.locator('[data-burrow-table="apps"] [data-yf="app.id"] a').first();
  await expectTouchHitArea(tabletAppIdLink, "Tablet application ID list link");
  const tabletAppRow = tabletAppIdLink.locator('xpath=ancestor::*[@role="row"]');
  expect(
    (await tabletAppRow.boundingBox())?.height ?? 0,
    "Tablet application row should make room for its link target",
  ).toBeGreaterThanOrEqual(44);
  await expectTouchHitArea(page.getByRole("combobox", { name: "Lifecycle state" }), "Tablet application lifecycle selector");
  await expectTouchHitArea(page.locator('[data-burrow-table="apps"] [role="columnheader"] button').first(), "Tablet table heading control");

  await page.goto(`/apps/${APP}`);
  await expectTouchHitArea(page.getByRole("button", { name: "Copy application ID to clipboard" }), "Tablet copy application ID");
  await expectTouchHitArea(page.locator(".burrow-touch-link").first(), "Tablet application detail link");
  await expectTouchHitArea(
    page.getByRole("navigation", { name: "Application sections" }).getByRole("link").first(),
    "Tablet application section link",
  );

  await page.goto(`/apps/${SPARK}/spark/jobs`);
  await expectTouchHitArea(page.getByRole("navigation", { name: "Spark pages" }).getByRole("link").first(), "Tablet Spark section link");

  await page.goto("/");
  const tabletHistoryControls = page.getByRole("group", { name: "Utilisation history window" }).getByRole("button");
  for (let index = 0; index < (await tabletHistoryControls.count()); index++) {
    await expectTouchHitArea(tabletHistoryControls.nth(index), `Tablet history window ${index + 1}`);
  }

  await page.goto(`/apps/${APP}/logs?container=${logContainer}&file=stderr`);
  const tabletLogButtons = page.locator(".burrow-log-toolbar button:not([role='switch'])");
  await expect(tabletLogButtons.first()).toBeVisible();
  for (let index = 0; index < (await tabletLogButtons.count()); index++) {
    await expectTouchHitArea(tabletLogButtons.nth(index), `Tablet log toolbar control ${index + 1}`);
  }
  await expectTouchHitArea(page.getByRole("switch", { name: "Follow new log output" }), "Tablet log follow switch");
});

test("Spark navigation brings the selected tab into view after route changes", async ({ page }) => {
  await page.setViewportSize({ width: 354, height: 784 });
  await page.goto(`/apps/${SPARK}/spark/jobs`);

  const nav = page.getByRole("navigation", { name: "Spark pages" });
  for (const label of ["Timeline", "Jobs"]) {
    await nav.getByRole("link", { name: label, exact: true }).click();
    const activeTab = nav.locator('[aria-current="page"]');
    await expect(activeTab).toHaveText(label);
    const visibility = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('nav[aria-label="Spark pages"]');
      const active = frame?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!frame || !active) return null;
      const frameBox = frame.getBoundingClientRect();
      const activeBox = active.getBoundingClientRect();
      return {
        path: location.pathname,
        scrollLeft: frame.scrollLeft,
        clientWidth: frame.clientWidth,
        scrollWidth: frame.scrollWidth,
        frameLeft: frameBox.left,
        frameRight: frameBox.right,
        activeLeft: activeBox.left,
        activeRight: activeBox.right,
        text: active.textContent,
      };
    });
    const visible =
      visibility !== null && visibility.activeLeft >= visibility.frameLeft - 1 && visibility.activeRight <= visibility.frameRight + 1;
    expect(visible, `${label} tab visibility: ${JSON.stringify(visibility)}`).toBe(true);
  }
});

test("phone Spark job detail opens with a readable stage summary and graph on demand", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/apps/${SPARK_DAG}/spark/jobs/2`);

  await expect(page).not.toHaveURL(/(?:\?|&)expand=/);
  const summary = page.getByTestId("mobile-dag-stage-summary");
  await expect(summary).toBeVisible();
  await expect(summary.getByRole("listitem")).toHaveCount(3);
  await expectTouchHitArea(summary.getByRole("button").first(), "Mobile stage summary row");
  await expect(summary.locator('[data-yf="spark.stage.stageId"]').first()).toHaveAttribute("data-yv", "2");
  await expect(summary.locator('[data-yf="spark.stage.name"]').first()).toBeVisible();
  await expect(page.getByTestId("dag-canvas")).toHaveCount(0);
  await expect(summary).toContainText("Stage 2");
  await expect(summary).toContainText("tasks");

  const openGraph = page.getByRole("button", { name: "Show full graph" });
  await expectTouchHitArea(openGraph, "Mobile DAG graph toggle");
  await openGraph.click();
  await expect(page).toHaveURL(/(?:\?|&)expand=%221%22(?:&|$)/);
  const canvas = page.getByTestId("dag-canvas");
  await expect(canvas).toHaveAttribute("data-dag-layout", "ready", { timeout: 20_000 });
  await expect(canvas.locator("[role='treeitem']")).toHaveCount(15);
  await expect(page.getByTestId("mobile-dag-expanded-hint")).toContainText("Show the stage list to review every stage.");
  await page.reload();
  await expect(canvas).toHaveAttribute("data-dag-layout", "ready", { timeout: 20_000 });
  await expect(canvas.locator("[role='treeitem']")).toHaveCount(15);

  await page.getByRole("button", { name: "Show stage list" }).click();
  await expect(page).toHaveURL(/(?:\?|&)expand=%220%22(?:&|$)/);
  await expect(summary).toBeVisible();
  await expect(summary.getByRole("listitem")).toHaveCount(3);
  await expect(canvas).toHaveCount(0);
});

test("phone Nodes and Node labels clear actions meet the 44px hit-area minimum", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });

  for (const { path, label } of [
    { path: "/nodes", label: "Search nodes" },
    { path: "/node-labels?view=mapping", label: "Search nodes" },
  ]) {
    await page.goto(path);
    const search = page.getByRole("searchbox", { name: label });
    await expect(search).toBeVisible();
    await search.fill("no-such-node");

    const clearSearch = page.getByRole("button", { name: "Clear search" });
    await expectTouchHitArea(clearSearch, `${path} clear-search control`);

    if (path === "/nodes") {
      const clearFilters = page.getByRole("button", { name: "Clear filters" });
      await expectTouchHitArea(clearFilters, "Nodes clear-filters control");
      await clearFilters.click();
      await expect(search).toHaveValue("");
    } else {
      await clearSearch.click();
      await expect(search).toHaveValue("");
    }
  }
});

test("clearing Nodes filters cancels an uncommitted search draft", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/nodes?label=__missing__");
  const search = page.getByRole("searchbox", { name: "Search nodes" });
  await expect(search).toBeVisible();
  await page.clock.install();
  await search.fill("draft-node");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.clock.fastForward(200);
  await expect(search).toHaveValue("");
  await expect(page).not.toHaveURL(/(?:\?|&)q=/);
});

test("phone Spark jobs show the first job row without scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/apps/${SPARK_DAG}/spark/jobs`);
  await expect(page.locator('[data-burrow-app-header="spark"] [data-burrow-app-header-secondary]').first()).toBeHidden();
  await expect(page.locator("[data-burrow-app-header-id]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy application ID to clipboard" })).toBeVisible();

  const firstJob = page.getByRole("table", { name: "Spark jobs" }).getByRole("row").nth(1);
  await expect(firstJob).toBeVisible();
  const box = await firstJob.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(812);
});

test("phone scheduler, node, and Spark row controls expose touch-sized targets", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/scheduler");
  await expectTouchHitArea(page.getByRole("button", { name: /Collapse root/ }).first(), "Queue tree expander");
  await expectTouchHitArea(page.getByRole("button", { name: "Why are only leaf queues shown?" }), "Queue resource map help");

  await page.goto("/nodes");
  await expectTouchHitArea(page.getByRole("link", { name: /Open the NodeManager UI/ }).first(), "NodeManager link");

  await page.goto(`/apps/${SPARK_DAG}/spark/jobs/2`);
  const stages = page.getByRole("table", { name: "Stages of job 2" });
  await expectTouchHitArea(stages.getByRole("link").first(), "Spark stage ID link");
});

test("phone Spark failures keep raw diagnostics wrapped and collapsed", async ({ page }) => {
  await page.goto("/apps/application_1791010000001_0099/spark/jobs");
  await expect(page.getByRole("heading", { name: "No Spark data source for this application" })).toBeVisible();
  await expect(page.locator('[data-burrow="spark-affordance"]')).toHaveCount(0);
  const details = page.locator('[role="alert"] details');
  await expect(details.locator("summary")).toHaveText("Technical details");
  const messageWidths = await page
    .locator('[role="alert"] p')
    .evaluateAll((elements) => elements.map((element) => ({ client: element.clientWidth, scroll: element.scrollWidth })));
  expect(messageWidths.every(({ client, scroll }) => scroll <= client + 1)).toBe(true);
  await details.locator("summary").click();
  const detailBox = await details.locator("pre").evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, whiteSpace: style.whiteSpace, wordBreak: style.wordBreak };
  });
  expect(detailBox.left).toBeGreaterThanOrEqual(0);
  expect(detailBox.right).toBeLessThanOrEqual(390);
  expect(detailBox.whiteSpace).toBe("pre-wrap");
  expect(detailBox.wordBreak).toBe("break-all");
});

test("354px phone viewport keeps every route inside the document bounds", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 354, height: 784 });
  const exceptions: string[] = [];
  page.on("pageerror", (error) => exceptions.push(error.message));

  for (const [name, path, marker] of routes) {
    await page.goto(path);
    await expect(page.locator(marker).first(), `${name} should render at 354px`).toBeVisible();
    const nativeTitles = await page
      .locator("[title]")
      .evaluateAll((els) => els.map((e) => ({ tag: e.tagName, text: e.textContent?.trim().slice(0, 40), title: e.getAttribute("title") })));
    expect(nativeTitles, `${name} should not use browser-native title popups at 354px`).toEqual([]);
    await checkMobileHelpControls(page);
    const overflow = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(overflow.document, `${name} document overflow`).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.body, `${name} body overflow`).toBeLessThanOrEqual(overflow.viewport);
    const missingCues = await page.evaluate(() => {
      const missing: string[] = [];
      const tabStrips = Array.from(document.querySelectorAll<HTMLElement>('nav, nav > ul, [role="tablist"]')).filter(
        (element) => element.scrollWidth > element.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(element).overflowX),
      );
      for (const strip of tabStrips) {
        const leftCue = strip.parentElement?.querySelector<HTMLElement>('[data-scroll-cue="left"]');
        const rightCue = strip.parentElement?.querySelector<HTMLElement>('[data-scroll-cue="right"]');
        const canScrollLeft = strip.scrollLeft > 1;
        const canScrollRight = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
        const label = strip.getAttribute("aria-label") ?? strip.tagName.toLowerCase();
        if (canScrollLeft !== !!leftCue?.classList.contains("opacity-100")) missing.push(`${label}:left edge`);
        if (canScrollRight !== !!rightCue?.classList.contains("opacity-100")) missing.push(`${label}:right edge`);
      }
      for (const table of Array.from(document.querySelectorAll<HTMLElement>("[data-burrow-table]"))) {
        if (
          !table.closest("details:not([open])") &&
          table.scrollWidth > table.clientWidth + 1 &&
          !table.closest("[data-burrow-table-root]")?.textContent?.includes("Swipe ↔")
        ) {
          missing.push(`table:${table.dataset.ysTable ?? "unnamed"}`);
        }
      }
      return missing;
    });
    expect(missingCues, `${name} horizontal scroll cues`).toEqual([]);
  }

  expect(exceptions).toEqual([]);
});

test("narrow application and Spark tabs show cues at both scroll edges", async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 740 });
  await page.goto(`/apps/${SPARK}/spark/jobs`);

  for (const label of ["Application sections", "Spark pages"]) {
    const navigation = page.getByRole("navigation", { name: label });
    const strip = label === "Application sections" ? navigation.locator("ul") : navigation;
    const { client, scroll } = await strip.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(scroll, `${label} should overflow at 280px`).toBeGreaterThan(client);

    const cues = label === "Application sections" ? navigation : navigation.locator("..");
    const leftCue = cues.locator('[data-scroll-cue="left"]');
    const rightCue = cues.locator('[data-scroll-cue="right"]');
    await expect(rightCue).toHaveClass(/opacity-100/);
    await strip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(leftCue).toHaveClass(/opacity-100/);
    await expect(rightCue).toHaveClass(/opacity-0/);
  }
});
