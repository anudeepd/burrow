import { expect, test, type Page } from "@playwright/test";
import NODES_SAMPLE from "../src/api/schemas/samples/nodes.json" with { type: "json" };

const PREFS_KEY = "burrow.prefs.v1";
const nodesTable = (page: Page) => page.locator('[data-burrow-table="burrow.nodes"]');

type PageEntryRecord = {
  containsNodesTable: boolean;
  from?: string;
  to?: string;
  opacityFrames: number;
  duration?: number;
  easing?: string;
};

declare global {
  interface Window {
    __burrowRouteEntries?: PageEntryRecord[];
  }
}

test("slides the table and fades Nodes rows when initial data arrives", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript((key: string) => {
    localStorage.setItem(key, JSON.stringify({ livePaused: true, liveIntervalMs: 30000, motion: "system" }));
  }, PREFS_KEY);
  const firstNode = NODES_SAMPLE.nodes.node[0];
  if (!firstNode) throw new Error("The nodes sample must include a node");
  const body = nodesTable(page).locator('[role="rowgroup"]').nth(1);
  let releaseResponse = () => {};
  const responseHeld = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/yarn/nodes",
    async (route) => {
      await responseHeld;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-burrow-api": "1", "x-burrow-cache": "miss" },
        json: NODES_SAMPLE,
      });
    },
  );

  try {
    await page.goto("/nodes");
    await expect(body).toHaveCSS("opacity", "0");
    await body.evaluate((element) => {
      element.addEventListener("transitionrun", (event) => {
        if (event.target === element && (event as TransitionEvent).propertyName === "opacity") {
          element.setAttribute("data-e2e-opacity-transition", "started");
        }
      });
    });
    await expect
      .poll(() =>
        body.evaluate((element) => {
          const owner = element.closest('[data-page-motion="content"]');
          return (
            owner?.getAnimations().every((animation) => {
              const name = (animation as CSSAnimation).animationName;
              return name !== "burrow-page-content-shift" || animation.playState === "finished";
            }) ?? true
          );
        }),
      )
      .toBe(true);
  } finally {
    releaseResponse();
  }
  await expect(page.locator(`[role="row"][data-ye="${firstNode.id}"]`)).toBeVisible();
  await expect(body).toHaveAttribute("data-e2e-opacity-transition", "started");
  await expect
    .poll(() =>
      nodesTable(page).evaluate((table) => {
        const root = table.closest<HTMLElement>("[data-burrow-table-root]");
        return (
          root?.getAnimations().some((animation) => {
            if (!(animation.effect instanceof KeyframeEffect)) return false;
            const frames = animation.effect.getKeyframes();
            return (
              frames.some((frame) => frame.transform === "translateY(10px)") &&
              frames.some((frame) => frame.transform === "translateY(0px)")
            );
          }) ?? false
        );
      }),
    )
    .toBe(true);
});

test("moves Nodes content on page entry without fading its result owners twice", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    localStorage.setItem("burrow.prefs.v1", JSON.stringify({ livePaused: true, motion: "system" }));
    window.__burrowRouteEntries = [];
    document.addEventListener("animationstart", (event) => {
      if (event.animationName !== "burrow-page-content-shift" || !(event.target instanceof HTMLElement)) return;
      const animation = event.target
        .getAnimations()
        .find((item) => item instanceof CSSAnimation && item.animationName === event.animationName);
      const effect = animation?.effect instanceof KeyframeEffect ? animation.effect : undefined;
      const frames = effect?.getKeyframes() ?? [];
      let entries = window.__burrowRouteEntries;
      if (!entries) {
        entries = [];
        window.__burrowRouteEntries = entries;
      }
      const from = frames[0]?.transform;
      const to = frames.at(-1)?.transform;
      entries.push({
        containsNodesTable: !!event.target.querySelector('[data-burrow-table="burrow.nodes"]'),
        from: typeof from === "string" ? from : undefined,
        to: typeof to === "string" ? to : undefined,
        opacityFrames: frames.filter((frame) => frame.opacity !== undefined).length,
        duration: Number(effect?.getTiming().duration),
        easing: frames[0]?.easing,
      });
    });
  });

  await page.goto("/nodes");
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
  await expect(nodesTable(page)).toBeVisible();
  await expect(page.getByRole("tab", { name: /All/ })).toBeVisible();
  await page.waitForFunction(() => window.__burrowRouteEntries?.some((entry) => entry.containsNodesTable));
  const entries = await page.evaluate(() => window.__burrowRouteEntries ?? []);
  expect(entries.find((entry) => entry.containsNodesTable)).toMatchObject({
    from: "translateY(10px)",
    to: "translateY(0px)",
    opacityFrames: 0,
    duration: 400,
    easing: "ease-in-out",
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tools/jmx");
  const jmxResults = page.locator("[data-burrow-jmx-root] .burrow-tab-content").first();
  await expect(jmxResults).toBeVisible();
  await expect
    .poll(() =>
      jmxResults.evaluate((element) =>
        element
          .getAnimations()
          .some((animation) => animation instanceof CSSAnimation && animation.animationName === "burrow-page-content-shift"),
      ),
    )
    .toBe(false);
});
