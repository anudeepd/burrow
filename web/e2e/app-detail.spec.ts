/**
 * App-detail end-to-end spec (Playwright, dev mock).
 *
 * Drives the three captured scenarios — RUNNING, FAILED/multi-attempt, finished — and asserts that every legacy
 * label's datum is present in the DOM with a `data-yv` (docs/contracts/parity-dom.md), then writes dark+light
 * screenshots into `e2e/__screenshots__/app-detail/`.
 *
 * Everything runs in `?parity=1` mode: all sections expanded, no virtualization windows, no auto-refresh — so the
 * assertions see the complete datum set and the screenshots are stable.
 *
 * The fixture files under `fixtures/rm/app/**` are the same bytes the mock replays, so expected `data-yv` values are
 * read from disk rather than hand-copied.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const FIXTURES = new URL("../../fixtures/rm/app/", import.meta.url);

const RUNNING_APP = "application_1791010984040_0001";
const FINISHED_APP = "application_1791010984040_0002";
const MULTI_ATTEMPT_APP = "application_1791010984040_0004";

function fixture<T>(scenario: string, file: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`${scenario}/${file}`, FIXTURES)), "utf8")) as T;
}

interface AppFixture {
  app: Record<string, unknown>;
}
interface AttemptsFixture {
  appAttempts: { appAttempt: { appAttemptId: string }[] };
}
interface ContainersFixture {
  container?: { containerId: string } | { containerId: string }[];
}

const containerIds = (scenario: string, attemptId: string): string[] => {
  const doc = fixture<ContainersFixture>(scenario, `containers-${attemptId}.json`);
  const c = doc.container;
  if (!c) return [];
  return (Array.isArray(c) ? c : [c]).map((x) => x.containerId);
};

/** field id -> first `data-yv` seen for it (the contract guarantees every occurrence agrees). */
async function fields(page: Page): Promise<Record<string, string>> {
  return await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const el of Array.from(document.querySelectorAll("[data-yf]"))) {
      const f = el.getAttribute("data-yf");
      if (f && !(f in out)) out[f] = el.getAttribute("data-yv") ?? "";
    }
    return out;
  });
}

/**
 * Read the parity datum map once the surface has actually painted. Data arrives after hydration, so reading
 * `[data-yf]` immediately after `goto` races the first fetch (a real flake, not a mock quirk).
 */
async function fieldsReady(page: Page, selector: string): Promise<Record<string, string>> {
  await page.locator(selector).first().waitFor({ state: "attached" });
  return await fields(page);
}

function expectFields(seen: Record<string, string>, required: string[]) {
  const missing = required.filter((f) => !(f in seen));
  expect(missing, `missing parity field ids: ${missing.join(", ")}`).toEqual([]);
}

const APP_FIELDS = [
  "app.id",
  "app.user",
  "app.name",
  "app.applicationType",
  "app.applicationTags",
  "app.priority",
  "app.state",
  "app.queue",
  "app.finalStatus",
  "app.startedTime",
  "app.launchTime",
  "app.finishedTime",
  "app.elapsedTime",
  "app.trackingUrl",
  "app.logAggregationStatus",
  "app.timeouts.timeout.remainingTimeInSeconds",
  "app.unmanagedApplication",
  "app.appNodeLabelExpression",
  "app.amNodeLabelExpression",
  "app.diagnostics",
  "app.preemptedResourceMB",
  "app.preemptedResourceVCores",
  "app.numNonAMContainerPreempted",
  "app.numAMContainerPreempted",
  "app.derived.resourceSecondsText",
];

const ATTEMPT_FIELDS = [
  "attempt.appAttemptId",
  "attempt.appAttemptState",
  "attempt.startTime",
  "attempt.finishedTime",
  "attempt.containerId",
  "attempt.nodeHttpAddress",
  "attempt.logsLink",
  "attempt.blacklistedNodes",
  "attempt.nodesBlacklistedBySystem",
];

/** Columns of the attempt page's container table — the legacy 4 (ID, Node, Exit Status, Logs). */
const CONTAINER_TABLE_FIELDS = ["container.containerId", "container.nodeHttpAddress", "container.containerExitStatus", "container.logUrl"];

/** Every field the legacy *container* page shows; asserted on the container detail route. */
const CONTAINER_FIELDS = [
  "container.containerId",
  "container.containerState",
  "container.containerExitStatus",
  "container.nodeHttpAddress",
  "container.nodeId",
  "container.assignedNodeId",
  "container.priority",
  "container.startedTime",
  "container.elapsedTime",
  "container.allocatedMB",
  "container.allocatedVCores",
  "container.logUrl",
];

async function shoot(page: Page, name: string) {
  await expect(page).toHaveScreenshot(`app-detail/${name}.png`, { fullPage: true });
}

/**
 * Set the OS color scheme; the pre-paint bootstrap resolves the stored `system` preference on reload.
 */
async function setTheme(page: Page, theme: "dark" | "light") {
  await page.emulateMedia({ colorScheme: theme });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`app detail · ${theme}`, () => {
    test("RUNNING app: overview fields, attempt + container routes", async ({ page }) => {
      const app = fixture<AppFixture>("running", "app.json").app;
      const attempts = fixture<AttemptsFixture>("running", "appattempts.json").appAttempts.appAttempt;
      const attemptId = attempts[0]!.appAttemptId;
      const [cid] = containerIds("running", attemptId);
      expect(cid, "the running fixture captured container detail payloads").toBeTruthy();

      await page.goto(`/apps/${RUNNING_APP}?parity=1`);
      await setTheme(page, theme);

      await expect(page.getByRole("heading", { name: String(app.name) })).toBeVisible();
      const seen = await fieldsReady(page, '[data-burrow="app-diagnostics"]');
      expectFields(seen, APP_FIELDS);
      expect(seen["app.state"]).toBe("RUNNING");
      expect(seen["app.id"]).toBe(RUNNING_APP);
      expect(seen["app.user"]).toBe(String(app.user));
      expect(seen["app.applicationTags"]).toBe(String(app.applicationTags ?? ""));
      expect(seen["app.unmanagedApplication"]).toBe("false");
      expect(seen["app.trackingUrl"]).toBe(String(app.trackingUrl));
      expect(seen["app.allocatedMB"]).toBe(String(app.allocatedMB));
      await expect(page.locator("#app-timeline")).toContainText("Running");
      await expect(page.locator("#app-timeline")).not.toContainText("Still running");
      await expect(page.getByText("Not finished yet").first()).toBeVisible();
      await expect(page.getByText("UNDEFINED", { exact: true })).toHaveCount(0);
      await shoot(page, `running-overview-${theme}`);

      await page.goto(`/apps/${RUNNING_APP}/attempts?parity=1`);
      const attemptSeen = await fieldsReady(page, '[data-burrow-table="app-attempts"]');
      expectFields(attemptSeen, ATTEMPT_FIELDS);
      expect(attemptSeen["attempt.appAttemptId"]).toBe(attemptId);
      await shoot(page, `running-attempts-${theme}`);

      await page.goto(`/apps/${RUNNING_APP}/attempts/${attemptId}?parity=1`);
      const detailSeen = await fieldsReady(page, '[data-burrow-table="attempt-containers"], [data-burrow="containers-unavailable"]');
      expectFields(detailSeen, [...ATTEMPT_FIELDS, ...CONTAINER_TABLE_FIELDS]);
      await shoot(page, `running-attempt-detail-${theme}`);

      await page.goto(`/apps/${RUNNING_APP}/containers/${cid}?parity=1`);
      const cSeen = await fieldsReady(page, '[data-yf="container.containerId"]');
      expectFields(cSeen, CONTAINER_FIELDS);
      expect(cSeen["container.containerId"]).toBe(cid);
      await shoot(page, `running-container-${theme}`);
    });

    test("FAILED multi-attempt app: three attempts, per-attempt containers, diagnostics", async ({ page }) => {
      const attempts = fixture<AttemptsFixture>("multi-attempt", "appattempts.json").appAttempts.appAttempt;
      const last = attempts[attempts.length - 1]!;
      const lastContainers = containerIds("multi-attempt", last.appAttemptId);
      expect(lastContainers.length).toBeGreaterThan(0);

      await page.goto(`/apps/${MULTI_ATTEMPT_APP}?parity=1`);
      await setTheme(page, theme);
      const seen = await fieldsReady(page, '[data-yf="app.diagnostics"]');
      expectFields(seen, APP_FIELDS);
      // YARN reports an application whose attempts failed as state FINISHED with finalStatus FAILED
      // (RMAppState.FAILED is only for apps that died before a final status could be reported) — assert
      // what the RM actually answered, from the same fixture the mock replays.
      const appFixture = fixture<AppFixture>("multi-attempt", "app.json").app as { state: string; finalStatus: string };
      expect(seen["app.state"]).toBe(appFixture.state);
      expect(seen["app.finalStatus"]).toBe(appFixture.finalStatus);
      // the whole diagnostics blob is the datum (no truncation in parity mode)
      const diag = fixture<AppFixture>("multi-attempt", "app.json").app.diagnostics as string;
      const diagText = await page.locator('[data-yf="app.diagnostics"]').first().textContent();
      expect(diagText?.length).toBe(diag.length);
      await shoot(page, `multi-attempt-overview-${theme}`);

      await page.goto(`/apps/${MULTI_ATTEMPT_APP}/attempts?parity=1`);
      const attemptSeen = await fieldsReady(page, '[data-burrow-table="app-attempts"]');
      expectFields(attemptSeen, ATTEMPT_FIELDS);
      for (const a of attempts) {
        await expect(page.locator(`[data-ye="${a.appAttemptId}"]`).first()).toBeAttached();
      }
      await shoot(page, `multi-attempt-attempts-${theme}`);

      await page.goto(`/apps/${MULTI_ATTEMPT_APP}/attempts/${last.appAttemptId}?parity=1`);
      const detailSeen = await fieldsReady(page, '[data-burrow-table="attempt-containers"], [data-burrow="containers-unavailable"]');
      expectFields(detailSeen, [...ATTEMPT_FIELDS, ...CONTAINER_TABLE_FIELDS]);
      await shoot(page, `multi-attempt-attempt-detail-${theme}`);
    });

    test("finished app: containers dropped by the RM render the honest empty state", async ({ page }) => {
      const attempts = fixture<AttemptsFixture>("finished", "appattempts.json").appAttempts.appAttempt;
      const attemptId = attempts[0]!.appAttemptId;

      await page.goto(`/apps/${FINISHED_APP}?parity=1`);
      await setTheme(page, theme);
      const seen = await fieldsReady(page, '[data-burrow="app-diagnostics"]');
      expectFields(seen, APP_FIELDS);
      expect(seen["app.finalStatus"]).toBe("SUCCEEDED");
      expect(seen["app.logAggregationStatus"]).toBe("SUCCEEDED");
      await shoot(page, `finished-overview-${theme}`);

      await page.goto(`/apps/${FINISHED_APP}/attempts/${attemptId}?parity=1`);
      await expect(page.locator('[data-burrow="containers-unavailable"]')).toBeAttached();
      await shoot(page, `finished-attempt-detail-${theme}`);
    });
  });
}

test.describe("honest states", () => {
  test("the section tab strip never grows a vertical scroll range, and the page below still scrolls", async ({ page }) => {
    await page.goto(`/apps/${RUNNING_APP}?parity=1`);
    const strip = page.locator('nav[aria-label="Application sections"] ul');
    await expect(strip).toBeVisible();

    /* `overflow-x-auto` makes the strip a scroll container on *both* axes, so anything painted past its box (the
       active tab's underline at `-bottom-px` used to) adds a one-pixel vertical scroll range: a real vertical
       scrollbar on classic-scrollbar platforms, and wheel scrolling over the tabs goes to the strip, not the page. */
    const geom = await strip.evaluate((el) => ({
      verticalRange: el.scrollHeight - el.clientHeight,
      horizontal: el.scrollWidth > el.clientWidth,
    }));
    expect(geom.verticalRange).toBe(0);
    expect(geom.horizontal).toBe(false);

    // the wheel over the page content scrolls the app-detail scroller — a nested, range-less scroller (`.burrow-scroll`'s
    // `overscroll-behavior: contain`) used to swallow it, leaving the page unscrollable
    const pageScroller = page.locator("main .burrow-page-scroll").first();
    const before = await pageScroller.evaluate((el) => el.scrollTop);
    await page.locator("main section").first().hover();
    await page.mouse.wheel(0, 240);
    await expect.poll(async () => pageScroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  });

  test("log source and Spark source render 'unavailable' when the backend says so", async ({ page }) => {
    await page.route("**/api/meta", async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as { features?: Record<string, boolean> };
      json.features = { ...json.features, nodeLogs: false, aggregatedLogs: false };
      await route.fulfill({ response: res, json });
    });
    await page.route("**/api/spark/*/source", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found", message: "no Spark source for this application" } }),
      });
    });

    await page.goto(`/apps/${RUNNING_APP}/attempts?parity=1`);
    await expect(page.locator('[data-burrow="log-source-unavailable"]').first()).toBeAttached();

    await page.goto(`/apps/${RUNNING_APP}?parity=1`);
    await expect(page.locator('[data-burrow="spark-source-unavailable"]')).toBeAttached();
    await shoot(page, "running-overview-unavailable-sources");
  });

  test("unknown application id surfaces the RM error with a retry affordance", async ({ page }) => {
    await page.route("**/api/yarn/apps/application_1_999", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found", message: "app with id: application_1_999 not found" } }),
      });
    });
    await page.goto("/apps/application_1_999?parity=1");
    await expect(page.getByRole("alert")).toContainText("application_1_999");
    await expect(page.getByRole("button", { name: "Retry now" })).toBeAttached();
  });
});
test.describe("timezone-aware application timestamps", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("the attempt summary switches between local and UTC time", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("burrow.prefs.v1", JSON.stringify({ tz: "local", livePaused: true, liveIntervalMs: 30000 }));
    });
    await page.goto(`/apps/${MULTI_ATTEMPT_APP}?parity=1`);

    const summary = page
      .locator("#app-timeline")
      .getByText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} →/)
      .first();
    await expect(summary).toBeVisible();
    const localTime = (await summary.innerText()).trim();
    await page.getByTestId("tz-toggle").getByRole("button", { name: /UTC/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-tz", "utc");
    await expect(summary).not.toHaveText(localTime);
  });
});
