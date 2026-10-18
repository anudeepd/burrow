/**
 * Spark tracking-UI end-to-end coverage.
 *
 * Runs against the recorded-fixture mock: `web/dev/mock-spark.ts` replays `fixtures/spark/**` per YARN app id, and the
 * spec drives the REAL built SPA (`BURROW_WEB_TARGET=dist`) over that API — nothing here is stubbed.
 *
 *   bun run build && bun run e2e                    # what CI/the owner runs
 *   bun run e2e -- --update-snapshots               # first run: mint the screenshot baselines
 *   PW_BASE_URL=http://127.0.0.1:5273 bun run e2e   # reuse an already-running dev:mock
 *
 * Scenario → appId (mock table):
 *   0001 rdd-wordcount · 0002 df-join-aqe · 0003 job-failed · 0004 task-retries · 0005 stage-retry (RUNNING)
 *   0006 big-dag · 0007 dstream · 0008 structured-streaming · 0009 sql-cache-union · 0010 window-sql
 *   0015 long-running · 0016 3.5.9 rdd-wordcount · 0099 unavailable source
 *
 * Assertions are contract-shaped: data-yf field ids and data-ye entity keys from docs/contracts/parity-dom.md. Runtime
 * motion is frozen through prefs (theme + `motion:"reduced"` + paused live polling) so dark/light screenshots are stable.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const SPARK24_SQL_FIXTURE = new URL("../../fixtures/spark/2.4.0/sql-demo/", import.meta.url);
const SPARK24_SQL_LIST = JSON.parse(readFileSync(new URL("api-sql.json", SPARK24_SQL_FIXTURE), "utf8")) as unknown;
const SPARK24_SQL_DETAIL = JSON.parse(readFileSync(new URL("api-execution-2.json", SPARK24_SQL_FIXTURE), "utf8")) as unknown;

const APPS = {
  rddWordcount: "application_1791010000001_0001",
  dfJoinAqe: "application_1791010000001_0002",
  jobFailed: "application_1791010000001_0003",
  taskRetries: "application_1791010000001_0004",
  stageRetry: "application_1791010000001_0005",
  bigDag: "application_1791010000001_0006",
  dstream: "application_1791010000001_0007",
  structuredStreaming: "application_1791010000001_0008",
  sqlCacheUnion: "application_1791010000001_0009",
  windowSql: "application_1791010000001_0010",
  longRunning: "application_1791010000001_0015",
  v359: "application_1791010000001_0016",
  unavailable: "application_1791010000001_0099",
} as const;

const sparkPath = (appId: string, page: string) => `/apps/${appId}/spark/${page}`;

type Theme = "dark" | "light";

/** Navigate with a fixed theme + frozen motion, then assert the DOM actually applied it (so a screenshot can't lie). */
async function open(page: Page, url: string, theme: Theme) {
  await page.addInitScript((t: Theme) => {
    localStorage.setItem("burrow.prefs.v1", JSON.stringify({ theme: t, motion: "reduced", tz: "utc", livePaused: true }));
  }, theme);
  await page.goto(url);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
}

interface PageCase {
  /** Screenshot basename: e2e/__screenshots__/spark/<name>-<theme>.png */
  name: string;
  url: string;
  /** data-yf ids that prove the page rendered real upstream values. */
  fields: string[];
  /** Optional entity key that must exist as a row/section. */
  entity?: string;
}

const PAGES: PageCase[] = [
  {
    name: "jobs",
    url: sparkPath(APPS.rddWordcount, "jobs"),
    fields: ["spark.job.jobId", "spark.job.status", "spark.job.numCompletedTasks"],
  },
  {
    name: "job-detail",
    url: sparkPath(APPS.rddWordcount, "jobs/0"),
    fields: ["spark.job.status", "spark.job.derived.durationMs"],
    entity: "0",
  },
  {
    name: "stages",
    url: sparkPath(APPS.rddWordcount, "stages"),
    fields: ["spark.stage.stageId", "spark.stage.status", "spark.stage.shuffleReadBytes"],
  },
  {
    name: "stage-detail",
    url: sparkPath(APPS.rddWordcount, "stages/0/0"),
    fields: ["spark.stage.status", "spark.stage.derived.durationMs", "spark.task.taskId"],
    entity: "0/0",
  },
  {
    name: "executors",
    url: sparkPath(APPS.rddWordcount, "executors"),
    // The executor's identity IS the entity key (there is no spark.executor.id field).
    fields: ["spark.executor.totalTasks"],
    entity: "driver",
  },
  {
    name: "storage",
    url: sparkPath(APPS.rddWordcount, "storage"),
    fields: ["spark.rdd.numCachedPartitions", "spark.rdd.memoryUsed"],
    entity: "6",
  },
  {
    name: "environment",
    url: sparkPath(APPS.rddWordcount, "environment"),
    fields: ["spark.env.sparkProperties"],
    entity: "_",
  },
  {
    name: "sql",
    url: sparkPath(APPS.sqlCacheUnion, "sql"),
    fields: ["spark.sql.status", "spark.sql.derived.durationMs"],
  },
  {
    name: "sql-detail",
    url: sparkPath(APPS.sqlCacheUnion, "sql/0"),
    fields: ["spark.sql.status"],
  },
  {
    name: "streaming",
    url: sparkPath(APPS.dstream, "streaming"),
    fields: ["spark.streaming.numProcessedRecords"],
  },
  {
    name: "timeline",
    url: sparkPath(APPS.rddWordcount, "timeline"),
    fields: [],
  },
];

for (const pageCase of PAGES) {
  test.describe(`spark ${pageCase.name}`, () => {
    test("renders headings, field ids, entity keys and both theme snapshots", async ({ page }) => {
      await open(page, pageCase.url, "dark");
      // Every Spark page opens with a PageHeader <h2> (the shell's h1 is the application name).
      await expect(page.locator("h2").first()).toBeVisible();
      await expect(page.locator("[data-ye]").first()).toBeVisible();
      for (const field of pageCase.fields) {
        await expect(page.locator(`[data-yf="${field}"]`).first(), `missing ${field}`).toBeVisible();
      }
      if (pageCase.entity) {
        await expect(page.locator(`[data-ye="${pageCase.entity}"]`).first(), `missing entity ${pageCase.entity}`).toBeVisible();
      }
      if (pageCase.name === "sql-detail") {
        // The SQL plan DAG mounts only when nodes exist; otherwise the page states that honestly.
        await expect(page.locator('[data-burrow-dag^="sql-"], :text("No plan graph for SQL execution")').first()).toBeVisible();
      }
      if (pageCase.name === "timeline") {
        // Timeline is a chart or, when it cannot draw one, an accessible table fallback.
        await expect(page.locator('[data-burrow-timeline], [role="grid"], table, [role="table"]').first()).toBeVisible();
      }
      await expect(page).toHaveScreenshot(`spark/${pageCase.name}-dark.png`);

      await open(page, pageCase.url, "light");
      await expect(page.locator("h2").first()).toBeVisible();
      for (const field of pageCase.fields) {
        await expect(page.locator(`[data-yf="${field}"]`).first()).toBeVisible();
      }
      await expect(page).toHaveScreenshot(`spark/${pageCase.name}-light.png`);
    });
  });
}

test.describe("spark version + retry deltas", () => {
  test("job detail renders when Spark omits the optional jobTags collection", async ({ page }) => {
    await page.route(`**/api/spark/${APPS.rddWordcount}/jobs/0`, async (route) => {
      const response = await route.fetch();
      const job = (await response.json()) as Record<string, unknown>;
      delete job.jobTags;
      await route.fulfill({ response, json: job });
    });

    await open(page, sparkPath(APPS.rddWordcount, "jobs/0"), "dark");
    await expect(page.locator("h2").first()).toContainText("Job 0");
    await expect(page.locator('[data-yf="spark.job.status"]').first()).toHaveAttribute("data-yv", "SUCCEEDED");
  });

  test("3.5.9 rdd-wordcount jobs page renders", async ({ page }) => {
    await open(page, sparkPath(APPS.v359, "jobs"), "dark");
    await expect(page.locator('[data-yf="spark.job.jobId"]').first()).toBeVisible();
  });

  test("Spark 2.4 SQL list and execution render the captured compatibility response", async ({ page }) => {
    const appId = APPS.sqlCacheUnion;
    await page.route(`**/api/spark/${appId}/application`, async (route) => {
      const response = await route.fetch();
      const application = (await response.json()) as { attempts: { appSparkVersion?: string }[] };
      for (const attempt of application.attempts ?? []) attempt.appSparkVersion = "2.4.0";
      await route.fulfill({ response, json: application });
    });
    await page.route(`**/api/spark/${appId}/sql**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname.endsWith("/sql/2") ? SPARK24_SQL_DETAIL : SPARK24_SQL_LIST;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    await open(page, sparkPath(appId, "sql"), "dark");
    const table = page.locator('[data-burrow-table="spark-sql"]');
    await expect(table).toBeVisible();
    await expect(page.locator('[data-yf="spark.sql.id"]')).toHaveText(["2", "1", "0"]);
    await expect(page.getByText("collect at BurrowSqlDemo.scala:21")).toBeVisible();

    await page
      .locator('[data-burrow-table="spark-sql"] [role="row"]')
      .filter({ hasText: "collect at BurrowSqlDemo.scala:21" })
      .locator('a[href$="/spark/sql/2"]')
      .click();
    await expect(page).toHaveURL(/\/spark\/sql\/2$/);
    await expect(page.locator('[data-yf="spark.sql.status"]').first()).toHaveAttribute("data-yv", "COMPLETED");
    await expect(page.locator('[data-burrow-dag^="sql-"]').first()).toBeVisible();
    await expect(page.getByText("collect at BurrowSqlDemo.scala:21").first()).toBeVisible();
    await expect(page.getByText("SQL execution data unavailable for Spark 2.4.0")).toHaveCount(0);
  });

  test("stage-retry second attempt is addressable", async ({ page }) => {
    await open(page, sparkPath(APPS.stageRetry, "stages/0/1"), "dark");
    await expect(page.locator('[data-yf="spark.stage.derived.durationMs"]').first()).toBeVisible();
    await expect(page.locator('[data-ye="0/1"]').first()).toBeVisible();
  });

  test("parity snapshot exposes every column and stops virtualizing", async ({ page }) => {
    await open(page, `${sparkPath(APPS.dfJoinAqe, "stages")}?parity=1`, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-parity", "1");
    const grid = page.locator("[data-burrow-table]");
    await expect(grid).toBeVisible();
    const total = Number(await grid.getAttribute("data-burrow-rows"));
    const rendered = await grid.locator('[role="row"][aria-rowindex]').count();
    expect(total).toBeGreaterThan(0);
    expect(rendered).toBe(total);
  });

  test("the SQL tab opens newest-first like the legacy UI, and the sort panel clears back to it", async ({ page }) => {
    await open(page, sparkPath(APPS.sqlCacheUnion, "sql"), "dark");
    const table = page.locator('[data-burrow-table="spark-sql"]');
    await expect(table).toBeVisible();
    const cells = page.locator('[data-yf="spark.sql.id"]');
    const idHeader = page.locator('[role="columnheader"][data-col="id"]');
    const descending = ["7", "6", "5", "4", "3", "2", "1", "0"];
    const ascending = ["0", "1", "2", "3", "4", "5", "6", "7"];

    // Spark's REST `sql` list is ascending; the legacy tab (DataTables `ID ▾`) renders it newest-first, and that order
    // is the table's default, so the URL carries no sort.
    await expect(cells).toHaveText(descending);
    await expect(idHeader).toHaveAttribute("aria-sort", "descending");
    expect(new URL(page.url()).search).toBe("");

    // one click asks for ascending; the panel's Clear then drops the params instead of pinning the explicit order
    await idHeader.locator("button").first().click();
    await expect(page).toHaveURL(/sort=id&dir=asc/);
    await expect(cells).toHaveText(ascending);
    await page.getByRole("button", { name: /^Sort order/ }).click();
    await page.getByRole("button", { name: "Clear sort" }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page).not.toHaveURL(/sort=/);
    await expect(cells).toHaveText(descending);

    // the legacy cycle has no "unsorted" step: a click flips to ascending, the next back to the default order
    await idHeader.locator("button").first().click();
    await expect(page).toHaveURL(/sort=id&dir=asc/);
    await idHeader.locator("button").first().click();
    await expect(page).toHaveURL(/sort=id&dir=desc/);
    await expect(cells).toHaveText(descending);
  });

  test("sort headers and the table scrollport are keyboard accessible", async ({ page }) => {
    await open(page, sparkPath(APPS.rddWordcount, "stages"), "dark");
    const header = page.locator('[role="columnheader"][data-col="duration"]');
    const sortButton = header.getByRole("button").first();
    await sortButton.focus();
    await page.keyboard.press("Enter");
    await expect(header).toHaveAttribute("aria-sort", /ascending|descending/);
    await expect(page.locator('[role="columnheader"][aria-sort]').first()).toBeVisible();

    const grid = page.locator('[data-burrow-table="spark-stages"]');
    await expect(grid).toHaveAttribute("aria-label", "Spark stages");
    await expect(grid).toHaveAttribute("tabindex", "0");
    await grid.focus();
    await expect(grid).toBeFocused();
  });
});

test.describe("honest failure + empty states", () => {
  test("unavailable source app shows the source banner, not invented data", async ({ page }) => {
    await open(page, sparkPath(APPS.unavailable, "jobs"), "dark");
    await expect(page.locator('[data-burrow-source="unavailable"], [data-burrow-source="none"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="spark.job.status"]')).toHaveCount(0);
  });

  test("a non-streaming app's streaming page reports no stream, not fake numbers", async ({ page }) => {
    await open(page, sparkPath(APPS.rddWordcount, "streaming"), "dark");
    await expect(page.locator("h2").first()).toBeVisible();
    await expect(page.locator('[data-yf="spark.streaming.numProcessedRecords"]')).toHaveCount(0);
  });
});

test.describe("every recorded scenario resolves", () => {
  for (const [scenario, appId] of Object.entries(APPS)) {
    test(`${scenario} (${appId}) loads the jobs page`, async ({ page }) => {
      await open(page, sparkPath(appId, "jobs"), "dark");
      await expect(page.locator("h2").first()).toBeVisible();
      // Either a job table row (data-ye) or an explicit empty/failure panel — never a blank page.
      await expect(page.locator("[data-ye], [role=status], [data-burrow-source]").first()).toBeVisible();
    });
  }
});
test.describe("progress motion", () => {
  test("animates segmented task widths with the shared progress duration", async ({ page }) => {
    await page.goto(sparkPath(APPS.rddWordcount, "stages"));
    const segment = page.locator('.burrow-thread[data-segments="true"] > span').first();
    await expect(segment).toBeAttached();
    await expect(segment).toHaveCSS("transition-duration", "0.24s");
  });
});
