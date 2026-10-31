/**
 * DAG engine e2e: pan/zoom/select/keyboard/drawer, both themes, reduced motion, a fixture-corpus sweep and the
 * frame-timing measurement for a 300-node DAG with a live progress stream.
 *
 * Runs against `bun run dev:mock` (`BURROW_WEB_TARGET=dist`), i.e. the real production build + the mock API that serves
 * the captured goldens. Screenshots live under `e2e/__screenshots__/dag/`.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { gotoFixture } from "./fixtures";

const GOLDEN = {
  job: "v=4.2.0&w=big-dag&f=dag-job-2.json",
  medium: "v=4.2.0&w=df-join-aqe&f=dag-job-2.json",
  stage: "v=4.2.0&w=sql-cache-union&f=dag-stage-11-0.json",
  skipped: "v=4.2.0&w=sql-cache-union&f=dag-job-2.json",
  failed: "v=4.2.0&w=job-failed&f=dag-job-1.json",
  big: "v=4.2.0&w=big-dag&f=dag-job-2.json&expand=1",
  fallback: "v=4.2.0&w=big-dag&f=dag-fallback-job-2.json",
  nested: "v=4.2.0&w=barrier-scopes&f=dag-stage-1-0.json",
  spark359: "v=3.5.9&w=big-dag&f=dag-job-2.json",
  sql: "kind=sql&v=4.2.0&w=df-join-aqe&f=rest%2Ffinal.sql-1.json",
  synthetic300: "kind=synthetic300",
} as const;

async function setTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  const current = await page.locator("html").getAttribute("data-theme");
  if (current !== theme)
    await page
      .getByTestId("theme-toggle")
      .getByRole("button", { name: theme === "light" ? "Theme: light" : "Theme: dark" })
      .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function expectNodesWithinCanvas(canvas: Locator, nodes: Locator): Promise<void> {
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();

  for (let index = 0; index < (await nodes.count()); index++) {
    const nodeBox = await nodes.nth(index).boundingBox();
    expect(nodeBox, `node ${index} should be framed on open`).not.toBeNull();
    expect(nodeBox!.x, `node ${index} left edge`).toBeGreaterThanOrEqual(canvasBox!.x - 1);
    expect(nodeBox!.x + nodeBox!.width, `node ${index} right edge`).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width + 1);
    expect(nodeBox!.y, `node ${index} top edge`).toBeGreaterThanOrEqual(canvasBox!.y - 1);
    expect(nodeBox!.y + nodeBox!.height, `node ${index} bottom edge`).toBeLessThanOrEqual(canvasBox!.y + canvasBox!.height + 1);
  }
}

test.describe("DAG rendering", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`screenshots every fixture category in ${theme}`, { tag: "@snapshot" }, async ({ page }) => {
      test.setTimeout(180_000);
      for (const [name, query] of Object.entries(GOLDEN)) {
        await gotoFixture(page, query, name === "synthetic300" ? "simulated" : "captured");
        await setTheme(page, theme);
        // freeze the simulated stream for a reproducible frame
        await page.evaluate(() => document.querySelector("main")?.setAttribute("data-settle", "1"));
        await expect(page.getByTestId("dag-canvas")).toHaveScreenshot(`dag/${name}-${theme}.png`, {
          animations: "disabled",
          caret: "hide",
          maxDiffPixelRatio: 0.02,
        });
      }
    });
  }

  test("runs ELK layout in the dedicated worker", async ({ page }) => {
    await gotoFixture(page, GOLDEN.medium);
    await expect(page.getByTestId("dag-canvas")).toContainText(/worker · \d+ ms/);
  });
});

test.describe("interaction", () => {
  test.describe("phone framing", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test("keeps DAG camera controls at 44px touch targets", async ({ page }) => {
      await gotoFixture(page, GOLDEN.big, "captured", { expandGraph: true });

      const controls = page.getByRole("toolbar", { name: "DAG view controls" });
      for (const label of ["Fit graph to view", "Zoom out", "Zoom in"]) {
        const button = controls.getByRole("button", { name: label });
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box?.width ?? 0, `${label} width`).toBeGreaterThanOrEqual(44);
        expect(box?.height ?? 0, `${label} height`).toBeGreaterThanOrEqual(44);
      }
    });

    test("opens a readable mobile stage list before the optional graph", async ({ page }) => {
      await gotoFixture(page, GOLDEN.medium, "captured", { stageList: true });

      const stageList = page.getByTestId("mobile-dag-stage-summary");
      const stages = stageList.getByRole("listitem");
      await expect(stages).toHaveCount(3);
      for (let index = 0; index < (await stages.count()); index++) {
        const stageButton = stages.nth(index).getByRole("button");
        await expect(stageButton).toBeVisible();
        expect((await stageButton.boundingBox())?.height ?? 0, "mobile stage rows should have a 44px hit area").toBeGreaterThanOrEqual(44);
      }

      await page.getByRole("button", { name: "Show full graph" }).click();
      const canvas = page.getByTestId("dag-canvas");
      await expect(canvas).toHaveAttribute("data-dag-layout", "ready", { timeout: 20_000 });
      await expect(canvas.locator("[role='treeitem']")).toHaveCount(15);
      await page.reload();
      await expect(canvas).toHaveAttribute("data-dag-layout", "ready", { timeout: 20_000 });
      await expect(canvas.locator("[role='treeitem']")).toHaveCount(15);
    });

    test("opens an explicitly expanded wide graph at a phone-friendly focus scale", async ({ page }) => {
      await gotoFixture(page, GOLDEN.big, "captured", { expandGraph: true });
      const canvas = page.getByTestId("dag-canvas");
      await expect(canvas).toHaveAttribute("data-dag-layout", "ready", { timeout: 20_000 });
      const zoom = Number.parseInt((await page.getByTestId("dag-zoom").textContent()) ?? "0", 10);
      expect(zoom, "expanded RDD detail should not open at full desktop zoom on a phone").toBeLessThanOrEqual(75);
    });

    test("can focus a stage at readable scale after fitting a wide graph", async ({ page }) => {
      await gotoFixture(page, GOLDEN.big, "captured", { expandGraph: true });
      const canvas = page.getByTestId("dag-canvas");
      await expect(canvas).toHaveAttribute("data-dag-layout", "ready", { timeout: 20_000 });

      await page.getByRole("button", { name: "Fit graph to view" }).click();
      await expectNodesWithinCanvas(canvas, canvas.locator("[role='treeitem']"));

      const focusButton = page.getByRole("button", { name: /^Focus stage \d+$/ });
      await expect(focusButton).toBeVisible();
      await expect(focusButton).toContainText(/^Focus stage \d+$/);
      const focusBox = await focusButton.boundingBox();
      expect(focusBox?.width ?? 0, "the stage-focus action should have a 44px touch target").toBeGreaterThanOrEqual(44);
      expect(focusBox?.height ?? 0, "the stage-focus action should have a 44px touch target").toBeGreaterThanOrEqual(44);
      const toolbarBox = await page.locator(".burrow-dag-toolbar").boundingBox();
      const edgesBox = await page.getByRole("button", { name: /^Edges \(\d+\)$/ }).boundingBox();
      expect(toolbarBox).not.toBeNull();
      expect(edgesBox).not.toBeNull();
      expect(edgesBox!.y, "the Edges control should share the toolbar row").toBeGreaterThanOrEqual(toolbarBox!.y);
      expect(edgesBox!.y + edgesBox!.height, "the Edges control should fit inside the toolbar row").toBeLessThanOrEqual(
        toolbarBox!.y + toolbarBox!.height,
      );
      await focusButton.click();

      await expect
        .poll(async () => Number.parseInt((await page.getByTestId("dag-zoom").textContent()) ?? "0", 10))
        .toBeGreaterThanOrEqual(55);
      await expect(page.locator("[role='treeitem']").first()).toBeVisible();
    });
  });

  test("opens a modest DAG with every stage in view", async ({ page }) => {
    await gotoFixture(page, GOLDEN.failed);

    const canvas = page.getByTestId("dag-canvas");
    const nodes = canvas.locator("[role='treeitem']");
    await expect(nodes).toHaveCount(6);
    await expectNodesWithinCanvas(canvas, nodes);
  });
  test("wheel over the right shell gutter scrolls the Spark page", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await gotoFixture(page, GOLDEN.medium, "running");

    const appScroller = page.locator(".burrow-app-scroll");
    await expect.poll(() => appScroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
    await appScroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.mouse.move(1910, 900);
    await page.mouse.wheel(0, 240);
    await expect.poll(() => appScroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test("opens a medium-wide DAG at readable running-stage focus", async ({ page }) => {
    await gotoFixture(page, GOLDEN.medium, "running");

    const canvas = page.getByTestId("dag-canvas");
    const nodes = canvas.locator("[role='treeitem']");
    await expect(nodes).toHaveCount(15);
    await expect.poll(() => canvas.locator('[data-running="true"]').count()).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: /^Focus stage \d+$/ })).toBeVisible();
    await expect
      .poll(async () => Number.parseInt((await page.getByTestId("dag-zoom").textContent()) ?? "0", 10))
      .toBeGreaterThanOrEqual(55);
  });

  test("loads its stylesheet: chrome is positioned inside the canvas and nodes are painted", async ({ page }) => {
    await gotoFixture(page, GOLDEN.big);
    const canvas = (await page.getByTestId("dag-canvas").boundingBox())!;
    const toolbar = (await page.locator(".burrow-dag-toolbar").boundingBox())!;
    const stage = (await page.getByTestId("dag-stage").boundingBox())!;
    const legend = (await page.locator(".burrow-dag-legend").boundingBox())!;
    const minimap = (await page.getByTestId("dag-minimap").boundingBox())!;
    // The toolbar and legend occupy their own rows so controls never cover the graph.
    expect(toolbar.y).toBeGreaterThanOrEqual(canvas.y - 1);
    expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(stage.y + 1);
    expect(legend.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1);
    expect(minimap.x + minimap.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
    expect(minimap.y + minimap.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
    // nodes actually painted (tone spine + body fill come from the stylesheet)
    const body = page.locator("[role='treeitem'] .burrow-dag-node-body").first();
    const fill = await body.evaluate((el) => getComputedStyle(el).fill);
    expect(fill).not.toBe("none");
    expect(fill).not.toBe("");
    await expect(page.locator("[role='treeitem'] [data-glyph]").first()).toBeAttached();
    // the wheel listener is non-passive: a gesture on the graph is the zoom gesture, so it must be prevented. Chrome
    // with its own scroller (the drawer, the edge list) is exempt and keeps the wheel — see the drawer test.
    const wheel = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='dag-stage']")!;
      const plain = new WheelEvent("wheel", { deltaY: -120, cancelable: true, bubbles: true });
      el.dispatchEvent(plain);
      return { plain: plain.defaultPrevented };
    });
    expect(wheel.plain).toBe(true);
  });

  test("pans by dragging and zooms with the wheel, keeping the anchor pinned", async ({ page }) => {
    await gotoFixture(page, GOLDEN.big);
    const canvas = page.getByTestId("dag-canvas");
    const box = (await canvas.boundingBox())!;
    const first = await page.locator("[role='treeitem']").first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 160, box.y + box.height / 2 - 60, { steps: 8 });
    await page.mouse.up();
    const afterPan = await page.locator("[role='treeitem']").first().boundingBox();
    expect(afterPan).not.toBeNull();
    // the content follows the pointer: dragged -160/-60 on screen, so the node moves by the same amount (drag started
    // over a node on purpose — panning must not require finding empty canvas)
    expect((first?.x ?? 0) - (afterPan?.x ?? 0)).toBeGreaterThan(100);
    expect((first?.y ?? 0) - (afterPan?.y ?? 0)).toBeGreaterThan(30);
    // and the drag must not have selected the node it started on
    await expect(page.getByTestId("dag-drawer")).toHaveAttribute("data-open", "false");

    const before = await page.getByTestId("dag-zoom").textContent();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);
    await expect(page.getByTestId("dag-zoom")).not.toHaveText(before ?? "");
  });

  test("keeps the graph point under the pointer fixed while zooming in", async ({ page }) => {
    await gotoFixture(page, GOLDEN.big);
    const canvas = page.getByTestId("dag-canvas");
    const box = (await canvas.boundingBox())!;
    const anchor = { x: box.x + box.width * 0.67, y: box.y + box.height * 0.38 };
    const worldPoint = () =>
      page.locator("[data-testid='dag-canvas'] svg > g").evaluate((group, point) => {
        const match = group.getAttribute("transform")!.match(/translate\(([-.\d]+) ([-.\d]+)\) scale\(([-.\d]+)\)/)!;
        const [, tx, ty, scale] = match.map(Number);
        const rect = (group as SVGGElement).ownerSVGElement!.getBoundingClientRect();
        return {
          x: (point.x - rect.left - tx!) / scale!,
          y: (point.y - rect.top - ty!) / scale!,
        };
      }, anchor);

    const before = await worldPoint();
    await page.mouse.move(anchor.x, anchor.y);
    await page.mouse.wheel(0, -120);
    await expect(page.getByTestId("dag-zoom")).not.toHaveText("100%");
    const after = await worldPoint();
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  });

  test("does not recenter on the first live metric after the user zooms", async ({ page }) => {
    const fixture = await gotoFixture(page, GOLDEN.synthetic300, "delayed");
    const canvas = page.getByTestId("dag-canvas");
    const world = page.locator("[data-testid='dag-canvas'] svg > g");
    await expect(canvas.locator('[data-running="true"]')).toHaveCount(0);
    const beforeZoom = await page.getByTestId("dag-zoom").textContent();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(page.getByTestId("dag-zoom")).not.toHaveText(beforeZoom ?? "");
    const afterZoom = await world.getAttribute("transform");
    fixture.releaseMetrics();
    await expect(canvas.locator('[data-running="true"]')).not.toHaveCount(0, { timeout: 15_000 });
    await expect(world).toHaveAttribute("transform", afterZoom!);
  });

  test("keeps the wheel for chrome that scrolls on its own", async ({ page }) => {
    await gotoFixture(page, GOLDEN.big);
    await page.locator("[role='treeitem']").nth(2).click();
    const drawer = page.getByTestId("dag-drawer");
    await expect(drawer).toHaveAttribute("data-open", "true");
    // The drawer is taller than the pane: its metrics scroll, so the canvas listener must not claim its wheel events.
    const prevented = await page.evaluate(() => {
      const inner = document.querySelector("[data-testid='dag-drawer']")!.firstElementChild ?? document.body;
      const ev = new WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true });
      inner.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(false);
  });

  test("selects a node, opens the drawer with real metrics, animates task progress, and closes on Escape", async ({ page }) => {
    await gotoFixture(page, GOLDEN.big);
    const node = page.locator("[role='treeitem']").nth(2);
    await node.click();
    const drawer = page.getByTestId("dag-drawer");
    await expect(drawer).toHaveAttribute("data-open", "true");
    await expect(drawer.locator("[data-yf]").first()).toBeVisible();
    const fieldCount = await drawer.locator("[data-yf]").count();
    expect(fieldCount).toBeGreaterThan(5);
    const taskProgress = drawer.getByRole("progressbar", { name: /task progress/ });
    await expect(taskProgress).toBeVisible();
    const segment = taskProgress.locator(":scope > span").first();
    const baseDuration = await page.locator("html").evaluate((element) => {
      const duration = getComputedStyle(element).getPropertyValue("--dur-base").trim();
      const value = Number.parseFloat(duration);
      const seconds = duration.endsWith("ms") ? value / 1000 : value;
      return `${Number(seconds.toFixed(2))}s`;
    });
    await expect(segment).toHaveCSS("transition-duration", baseDuration);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveAttribute("data-open", "false");
  });

  test("selects a shuffle edge and shows its metrics", async ({ page }) => {
    await gotoFixture(page, GOLDEN.big);
    const edgesButton = page.getByRole("button", { name: /^Edges \(\d+\)$/ });
    const gestureHint = page.getByRole("tooltip").filter({ hasText: /^Scroll to zoom/ });
    await edgesButton.hover();
    await expect(gestureHint).toBeHidden();
    await expect(edgesButton.locator("svg")).toBeVisible();
    await edgesButton.click();
    await expect(edgesButton).toHaveAttribute("aria-expanded", "true");
    const edgeList = page.getByTestId("dag-edge-list");
    await expect(edgeList).toBeVisible();
    const entry = edgeList.getByRole("menuitem", { name: /shuffle read/i }).first();
    await expect(entry).toHaveAttribute("aria-label", / to /);
    await entry.click();
    const drawer = page.getByTestId("dag-edge-drawer");
    await expect(drawer).toHaveAttribute("data-open", "true");
    await expect(drawer.getByRole("heading", { name: "Shuffle edge" })).toBeVisible();
    await expect(drawer.locator('[data-yf="spark.stage.shuffleReadBytes"]')).toBeVisible();
  });

  test("navigates with the keyboard and opens the drawer with Enter", async ({ page }) => {
    await gotoFixture(page, GOLDEN.job);
    // The roving tabindex lives on graph nodes; `[tabindex='0']` alone also matches shell controls.
    await page.locator("[data-node-id][tabindex='0']").first().focus();
    const startId = await page.evaluate(() => document.activeElement?.getAttribute("data-node-id"));
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-node-id"))).not.toBe(startId);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("dag-drawer")).toHaveAttribute("data-open", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("dag-drawer")).toHaveAttribute("data-open", "false");
    await page.keyboard.press("Home");
    // Home returns to the first keyboard-order node (the graph's DOM order may differ from the visual navigation order).
    await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-node-id"))).toBe(startId);
  });

  test("minimap moves the viewport and fit shows the whole graph", async ({ page }) => {
    await gotoFixture(page, GOLDEN.synthetic300, "simulated");
    const minimap = page.getByTestId("dag-minimap");
    const view = page.locator(".burrow-dag-minimap-view");
    await expect(minimap).toBeVisible();
    await expect(view).toBeVisible();
    const viewBefore = await view.boundingBox();
    expect(viewBefore).not.toBeNull();
    const box = (await minimap.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
    await expect
      .poll(async () => {
        const current = await view.boundingBox();
        return current ? Math.abs(current.x - viewBefore!.x) : 0;
      })
      .toBeGreaterThan(1);
    const viewAfter = await view.boundingBox();
    expect(viewAfter).not.toBeNull();

    await page.getByRole("button", { name: "Fit graph to view" }).click();
    // Large DAGs open at a readable scale, so Fit intentionally zooms out farther than the initial view.
    // The minimap viewport must grow to show the whole graph instead of returning to the initial focus position.
    await expect.poll(async () => (await view.boundingBox())?.width ?? 0).toBeGreaterThan(viewAfter!.width * 1.5);
  });

  test("honours reduced motion (no running animations)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoFixture(page, GOLDEN.synthetic300, "simulated");
    const runningNodes = page.locator("[role='treeitem'][data-running='true']");
    await expect.poll(() => runningNodes.count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await page.getByRole("button", { name: "Fit graph to view" }).click();
    await expect.poll(() => runningNodes.count()).toBeGreaterThan(0);
    const animating = await page.evaluate(() => {
      let count = 0;
      for (const el of document.querySelectorAll(".burrow-dag-node-shimmer, .burrow-dag-edge-flow, .burrow-dag-flash")) {
        const style = getComputedStyle(el);
        if (style.animationName !== "none" && style.animationDuration !== "0s") count += 1;
      }
      return count;
    });
    expect(animating).toBe(0);
  });
});

test.describe("fixture corpus in the browser", () => {
  test("every 4.2.0 golden is served and a systematic sample renders", async ({ page }) => {
    test.setTimeout(300_000); // 41 navigations, each one a cold DAG layout in a real browser
    const index = await page.request
      .get("/api/dev/dag/index")
      .then((r) => r.json() as Promise<{ items: { version: string; workload: string; file: string }[] }>);
    const golden = index.items.filter((i) => i.version === "4.2.0");
    expect(golden.length).toBe(366);

    // every 9th fixture: 41 DAGs across all 15 workloads, in the real browser
    const sample = golden.filter((_, i) => i % 9 === 0);
    const failures: string[] = [];
    for (const item of sample) {
      await gotoFixture(page, `kind=golden&v=${item.version}&w=${item.workload}&f=${encodeURIComponent(item.file)}`);
      try {
        await expect(page.getByTestId("dag-canvas")).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('[data-testid="dag-state"]:visible')).toHaveCount(0, { timeout: 15_000 });
        const nodes = await page.locator("[role='treeitem']").count();
        if (nodes === 0) failures.push(`${item.workload}/${item.file}: 0 nodes`);
        const warnings = await page.getByTestId("dag-warnings").count();
        if (warnings > 0) failures.push(`${item.workload}/${item.file}: data warnings shown`);
      } catch (err) {
        failures.push(`${item.workload}/${item.file}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(sample.length).toBeGreaterThan(30);
  });

  test("a stage-kind DAG with an incoming cross-stage edge renders a ghost stub", async ({ page }) => {
    await gotoFixture(page, "v=4.2.0&w=sql-cache-union&f=dag-stage-11-0.json");
    await expect(page.locator("[data-kind='ghost']")).toHaveCount(1);
    await expect(page.locator("[data-kind='ghost'][aria-label*='not part of this page']")).toHaveCount(1);
    // status glyph: shape + tone, never colour alone
    await expect(page.locator("[role='treeitem'] [data-glyph]").first()).toBeAttached();
  });
});

test.describe("frame timing", () => {
  test("300-node DAG with live progress updates stays inside the frame budget", async ({ page }) => {
    // The stage metrics are intercepted below, so the mock server SSE hub cannot publish their changes. Exercise
    // the supported polling fallback to keep metrics moving during this isolated frame sample.
    const fixture = await gotoFixture(page, "kind=synthetic300", "simulated", { pollingOnly: true });
    await expect.poll(async () => page.locator("[role='treeitem']").count()).toBeGreaterThanOrEqual(300);
    // Offscreen edges are culled in both layers; above CANVAS_THRESHOLD they also leave the SVG entirely.
    // Use the container's all-scene count for the precondition and report.
    await expect
      .poll(async () => Number(await page.getByTestId("dag-canvas").getAttribute("data-flowing-edges")), { timeout: 20_000 })
      .toBeGreaterThan(0);

    const readsBefore = fixture.progressReads();
    const stats = await page.evaluate(
      () =>
        new Promise<{ count: number; p50: number; p95: number; max: number; longFrameShare: number; overBudget: number }>((resolve) => {
          const samples: number[] = [];
          let last = performance.now();
          const started = last;
          const sample = (now: number) => {
            samples.push(now - last);
            last = now;
            if (now - started < 4000) {
              requestAnimationFrame(sample);
              return;
            }
            const sorted = [...samples].sort((a, b) => a - b);
            resolve({
              count: samples.length,
              p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
              p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
              max: sorted.at(-1) ?? 0,
              longFrameShare: samples.filter((ms) => ms > 34).length / samples.length,
              overBudget: samples.filter((ms) => ms > 16.7).length / samples.length,
            });
          };
          requestAnimationFrame(sample);
        }),
    );
    expect(fixture.progressReads()).toBeGreaterThan(readsBefore);
    const nodes = await page.locator("[role='treeitem']").count();
    const flowing = Number((await page.getByTestId("dag-canvas").getAttribute("data-flowing-edges")) ?? 0);
    const strategy = await page.getByTestId("dag-canvas").getAttribute("data-strategy");
    const report = {
      nodes,
      flowingEdges: flowing,
      strategy,
      frames: stats.count,
      p50: Number((stats?.p50 ?? 0).toFixed(2)),
      p95: Number((stats?.p95 ?? 0).toFixed(2)),
      max: Number((stats?.max ?? 0).toFixed(2)),
      longFrameShare: Number((stats?.longFrameShare ?? 0).toFixed(4)),
      // kept for the record only — see the note on the assertion below
      overBudgetShare: Number((stats?.overBudget ?? 0).toFixed(4)),
    };
    test.info().annotations.push({ type: "frame-timing", description: JSON.stringify(report) });
    // eslint-disable-next-line no-console -- the numbers are the deliverable
    console.log(`frame timing: ${JSON.stringify(report)}`);

    expect(report.frames).toBeGreaterThan(100);
    expect(report.p50).toBeLessThan(20);
    // Gate on *dropped* frames, not on "slower than one vsync". Measured on the built dist (real Chromium, 1440×900,
    // 4 s windows): an idle 8-node DAG with nothing animating scores overBudgetShare ≈ 0.41 and a static 338-node graph
    // ≈ 0.30, because a headless software rasteriser runs rAF at ~57 fps and every frame one vsync late is counted by
    // the 16.7 ms test. So `p95 <= 34 ms` (one dropped frame allowed) plus `longFrameShare < 0.1` (frames slower than
    // two intervals) is the honest gate; do not re-tighten either number to 16.7 ms without reading this.
    expect(report.p95).toBeLessThanOrEqual(34);
    expect(report.longFrameShare).toBeLessThan(0.1);
  });

  test("the canvas edge layer takes over past 500 nodes", async ({ page }) => {
    await gotoFixture(page, "kind=synthetic600", "simulated");
    await expect(page.getByTestId("dag-canvas")).toHaveAttribute("data-strategy", "canvas");
    await expect(page.locator(".burrow-dag-edges")).toHaveCount(0);
    await expect(page.locator("canvas")).toBeVisible();
  });
});
