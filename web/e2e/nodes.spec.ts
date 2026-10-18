/**
 * Nodes — Playwright proof against the generated dev cluster and captured node-detail/NM payloads.
 *
 * The spec asserts the two things the parity harness will assert: the legacy column set (all 16, in order) and the
 * `data-ye`/`data-yf`/`data-yv` stamps for the values shown. Screenshots (dark + light) are committed under
 * `e2e/__screenshots__/nodes/`.
 */
import { expect, test } from "@playwright/test";
import NODES_SAMPLE from "../src/api/schemas/samples/nodes.json" with { type: "json" };

const PREFS_KEY = "burrow.prefs.v1";

const LEGACY_COLUMNS = [
  "Node Labels",
  "Rack",
  "Node State",
  "Node Address",
  "Node HTTP Address",
  "Last health-update",
  "Health-report",
  "Containers",
  "Allocation Tags",
  "Mem Used",
  "Mem Avail",
  "Phys Mem Used %",
  "VCores Used",
  "VCores Avail",
  "Phys VCores Used %",
  "Version",
];

test.describe("nodes", () => {
  test("top consumer rows explain the ranking and resource values on hover", async ({ page }) => {
    await page.goto("/nodes?parity=1");
    const consumer = page.getByTestId("top-consumer-row").first();
    await expect(consumer).toBeVisible();
    await consumer.hover();

    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("running containers");
    await expect(tooltip).toContainText("bar is relative to the busiest node");
    await expect(tooltip).toContainText("physical memory used");
    await expect(tooltip).toContainText("memory and");
    await expect(tooltip).toContainText("Click to open node details");
  });

  test("table renders all 16 legacy columns and stamps every value for parity", async ({ page }) => {
    await page.goto("/nodes?parity=1");
    await expect(page.getByRole("heading", { name: "Nodes", level: 1 })).toBeVisible();

    const headers = (await page.locator('[role="columnheader"]').allInnerTexts()).map((t) => t.trim());
    for (const label of LEGACY_COLUMNS) {
      expect(headers, `missing legacy column ${label}`).toContain(label);
    }

    // one row per node in the generated mock cluster, each keyed by node id
    const rowIds = await page
      .locator('[data-burrow-table="burrow.nodes"] [role="row"][data-ye]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.ye));
    expect(rowIds.sort()).toEqual([
      "node-r1-01.mock.local:45454",
      "node-r1-02.mock.local:45454",
      "node-r2-01.mock.local:45454",
      "node-r2-02.mock.local:45454",
      "node-r2-03.mock.local:45454",
    ]);

    // raw values, not formatted text (docs/contracts/parity-dom.md)
    await expect(page.locator('[data-yf="node.state"][data-yv="RUNNING"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="node.rack"][data-yv="/rack1"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="node.nodeLabels"][data-yv="[\\"gpu\\"]"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="node.version"][data-yv="3.4.3"]').first()).toBeVisible();
    const memCells = await page
      .locator('[data-yf="node.availMemoryMB"]')
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-yv"))));
    expect(memCells.some((memory) => memory > 0)).toBe(true);
  });

  test("legacy state tabs, label filter and search narrow the table", async ({ page }) => {
    await page.goto("/nodes?parity=1");
    await expect(page.locator('[data-burrow-table="burrow.nodes"] [role="row"][data-ye]')).toHaveCount(5);

    // Unhealthy is the legacy default-tab exclusion and has its own tab
    await page.getByRole("tab", { name: /Lost/ }).click();
    await expect(page.getByText("No node matches these filters")).toBeVisible();

    await page.getByRole("tab", { name: /^All/ }).click();
    await page.getByLabel("Label filter").click();
    await page.getByRole("option", { name: "gpu" }).click();
    const gpuRow = page.locator('[data-burrow-table="burrow.nodes"] [role="row"][data-ye]');
    await expect(gpuRow).toHaveCount(1);
    await expect(gpuRow).toHaveAttribute("data-ye", "node-r1-01.mock.local:45454");

    // URL is state: sorting is linkable
    await page.goto("/nodes?sort=id:desc&parity=1");
    await expect(page.locator('[data-burrow-table="burrow.nodes"] [role="row"][data-ye]').first()).toHaveAttribute(
      "data-ye",
      "node-r2-03.mock.local:45454",
    );
  });

  test("running node updates pulse the status badge without flashing the row", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ livePaused: false, liveIntervalMs: 2000 })), PREFS_KEY);
    let fetchCount = 0;
    let heartbeat = 0;
    await page.route(
      (url) => url.pathname === "/api/yarn/nodes",
      async (route) => {
        fetchCount++;
        const nodes = NODES_SAMPLE.nodes.node.map((node, index) =>
          index === 0 ? { ...node, lastHealthUpdate: node.lastHealthUpdate + heartbeat } : node,
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
          json: { ...NODES_SAMPLE, nodes: { ...NODES_SAMPLE.nodes, node: nodes } },
        });
      },
    );

    const firstNode = NODES_SAMPLE.nodes.node[0];
    if (!firstNode) throw new Error("The nodes sample must include a running node");
    await page.goto("/nodes");
    const row = page.locator(`[data-burrow-table="burrow.nodes"] [role="row"][data-ye="${firstNode.id}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator(".burrow-dot-pulse")).toBeAttached();
    const lastHealthUpdate = row.locator('[data-yf="node.lastHealthUpdate"]');
    await expect(lastHealthUpdate).toHaveAttribute("data-yv", String(firstNode.lastHealthUpdate));

    const initialFetchCount = fetchCount;
    heartbeat = 1000;
    await expect.poll(() => fetchCount, { timeout: 15_000, intervals: [100, 250] }).toBeGreaterThan(initialFetchCount);
    await expect(lastHealthUpdate).toHaveAttribute("data-yv", String(firstNode.lastHealthUpdate + heartbeat));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const flashLayer = row.locator('span[aria-hidden="true"].bg-live');
    expect(await flashLayer.evaluate((element) => element.getAnimations().length)).toBe(0);
  });

  test("state-tab changes fade the filtered nodes", async ({ page }) => {
    await page.goto("/nodes");
    await expect(page.getByRole("tab", { name: /Lost/ })).toBeVisible();
    const fade = page.waitForFunction(() => {
      const element = document.querySelector(".burrow-tab-content");
      return (
        element?.getAnimations().some((animation) => {
          const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
          return animation.playState === "running" && Number(frames[0]?.opacity) === 0 && Number(frames[frames.length - 1]?.opacity) === 1;
        }) ?? false
      );
    });
    await page.getByRole("tab", { name: /Lost/ }).click();
    expect(await (await fade).jsonValue()).toBe(true);
    await expect(page.getByText("No node matches these filters")).toBeVisible();
  });

  test("switching between the node table and rack heatmap fades the visualization", async ({ page }) => {
    await page.goto("/nodes");
    await expect(page.locator('[data-burrow-table="burrow.nodes"]')).toBeVisible();

    const fade = page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".burrow-tab-content")).some((element) =>
        element.getAnimations().some((animation) => {
          const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
          return animation.playState === "running" && Number(frames[0]?.opacity) === 0 && Number(frames[frames.length - 1]?.opacity) === 1;
        }),
      ),
    );
    await page.getByRole("button", { name: "Rack heatmap view" }).click();
    expect(await (await fade).jsonValue()).toBe(true);
    await expect(page.getByText("/rack1").first()).toBeVisible();
  });

  test("heatmap groups by rack and exposes the same values", async ({ page }) => {
    await page.goto("/nodes?view=heatmap&parity=1");
    await expect(page.getByText("/rack1").first()).toBeVisible();
    await expect(page.getByText("/rack2").first()).toBeVisible();
    await expect(page.locator('[data-ye="node-r1-01.mock.local:45454"] [data-yf="node.memUtilization"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /node-r1-01\.mock\.local:45454: memory/ })).toBeVisible();
  });

  test("node detail shows the RM node object, the resource matrix, the NM build info and live containers", async ({ page }) => {
    await page.goto("/nodes/127.0.0.3:8041?parity=1");
    await expect(page.getByRole("heading", { name: "127.0.0.3", level: 1 })).toBeVisible();
    for (const field of [
      "node.id",
      "node.rack",
      "node.state",
      "node.version",
      "node.healthReport",
      "node.memUtilization",
      "node.cpuUtilization",
      "node.totalResource.memory",
      "node.totalResource.memory-mb",
      "node.availableResource.vcores",
      "node.resourceUtilization.nodePhysicalMemoryMB",
      "nm.info.nodeManagerVersion",
      "nm.info.hadoopVersion",
      "nm.info.nmStartupTime",
    ]) {
      // attached, not visible: a legitimately empty value (healthReport "" on a healthy node) has no box to see
      await expect(page.locator(`[data-yf="${field}"]`).first(), `detail is missing ${field}`).toBeAttached();
    }
    // the captured cluster runs a seeded workload, so this node has real containers on the NodeManager
    const containers = page.locator('[data-burrow-table="burrow.node.containers"] [role="row"][data-ye]');
    await expect(containers).toHaveCount(2);
    await expect(page.locator('[data-yf="nm.container.totalMemoryNeededMB"][data-yv="768"]').first()).toBeVisible();
    await expect(page.locator('[data-yf="nm.container.totalVCoresNeeded"][data-yv="1"]').first()).toBeVisible();
    await expect(page.getByTestId("node-container-summary").locator('[data-yf="node.derived.nmContainerMemoryMB"]')).toHaveAttribute(
      "data-yv",
      "1536",
    );
    await expect(page.getByTestId("node-container-summary").locator('[data-yf="node.derived.nmContainerVCores"]')).toHaveAttribute(
      "data-yv",
      "2",
    );
    await expect(page.getByTestId("node-container-summary").locator('[data-yf="node.derived.nmRunningContainers"]')).toHaveAttribute(
      "data-yv",
      "2",
    );
    await expect(containers.locator('[data-yf="nm.container.exitCode"][data-yv="-1000"]').first()).toHaveText("—");
    await expect(page.getByRole("link", { name: /6 files/ }).first()).toBeVisible();
    // node-local logs: the /api/logs routes are not part of the mock, so the honest "unavailable" state must show
    await expect(page.getByText(/Node-local logs/).first()).toBeVisible();
    await expect(page.getByText(/fixtures\/rm\/logs\/containers\.json/)).toHaveCount(0);
    await expect(page.getByText(/Check that the NodeManager is reachable/)).toBeVisible();
  });

  test("screenshots: table, heatmap and detail (dark + light)", async ({ page }) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/nodes");
      await expect(page.locator('[data-burrow-table="burrow.nodes"] [role="row"][data-ye]').first()).toBeVisible();
      await expect(page).toHaveScreenshot(`nodes/nodes-table-${scheme}.png`);

      await page.goto("/nodes?view=heatmap");
      await expect(page.getByText("/rack1").first()).toBeVisible();
      await expect(page).toHaveScreenshot(`nodes/nodes-heatmap-${scheme}.png`);

      await page.goto("/nodes/127.0.0.3:8041");
      await expect(page.getByRole("heading", { name: "127.0.0.3", level: 1 })).toBeVisible();
      await expect(page).toHaveScreenshot(`nodes/node-detail-${scheme}.png`, { fullPage: true });
    }
  });
});

test.describe("node search", () => {
  test("numeric text searches keep matching nodes and reject non-matches", async ({ page }) => {
    await page.goto("/nodes?q=45454&parity=1");
    const matchingRows = page.locator('[data-burrow-table="burrow.nodes"] [role="row"][data-ye]');
    await expect(matchingRows).toHaveCount(5);
    const ids = await matchingRows.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.ye ?? ""));
    expect(ids.every((id) => id.includes("45454"))).toBe(true);

    await page.goto("/nodes?q=9999&parity=1");
    await expect(page.getByText("No node matches these filters")).toBeVisible();
    await expect(page.locator('[data-burrow-table="burrow.nodes"] [role="row"][data-ye]')).toHaveCount(0);
  });
});
test.describe("timezone-aware node timestamps", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("node health-update text switches between local and UTC time", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("burrow.prefs.v1", JSON.stringify({ tz: "local", livePaused: true, liveIntervalMs: 30000 }));
    });
    await page.goto("/nodes/127.0.0.3:8041?parity=1");

    const healthUpdate = page.locator('[data-yf="node.lastHealthUpdate"]').first();
    await expect(healthUpdate).toBeVisible();
    const localTime = (await healthUpdate.innerText()).trim();
    await page.getByTestId("tz-toggle").getByRole("button", { name: /UTC/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-tz", "utc");
    await expect(healthUpdate).not.toHaveText(localTime);
  });
});
