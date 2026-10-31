import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Shell e2e: rail + top bar + palette + hotkeys + theme/time-zone + connection status, against the dev mock.
 * Screenshots are written to `e2e/__screenshots__/` (dark and light) as the deliverable's visual evidence.
 */
const PREFS_KEY = "burrow.prefs.v1";

declare global {
  interface Window {
    __responsePulseTrace?: { animation: Animation; canceled: boolean }[];
  }
}

/** Freeze live updates unless a test wants them: deterministic DOM, no polling races. */
async function freezeLive(page: Page) {
  await page.addInitScript((key: string) => {
    const current = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...current, livePaused: true, liveIntervalMs: 30000 }));
  }, PREFS_KEY);
}

/** Vite serves SSR markup before the client handlers attach; wait for the client preference module's DOM signal. */
async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await page.waitForFunction(() => ["local", "utc"].includes(document.documentElement.dataset.tz ?? ""));
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

test.describe("app shell", () => {
  test("rail, top bar and connection status render with live cluster identity", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");

    const rail = page.getByTestId("rail");
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("link", { name: "Applications" })).toBeVisible();
    await expect(rail.getByRole("link", { name: "Nodes" })).toBeVisible();
    await expect(rail.getByRole("link", { name: "Overview" })).toBeVisible();

    const topbar = page.getByTestId("topbar");
    await expect(topbar).toBeVisible();
    await expect(topbar).toHaveAttribute("data-live", "paused");
    // the mock cluster's id is the RM start timestamp, printed raw (`id` never groups separators) — read it from the
    // API instead of pinning a fixture number that moves with the mock's clock
    const info = (await (await page.request.get("/api/yarn/info")).json()) as { clusterInfo?: { id?: number } };
    await expect(page.getByTestId("cluster-id")).toContainText(String(info.clusterInfo?.id ?? ""));
    await expect(page.getByTestId("ha-pill")).toContainText(/active/i);
    await expect(page.getByTestId("last-updated")).toContainText(/paused|ago|…/);
  });
  test("keeps the connection trigger inside the viewport with the tablet rail expanded", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await freezeLive(page);
    await gotoReady(page, "/");

    const rail = page.getByTestId("rail");
    await expect(rail).toHaveAttribute("data-collapsed", "false");
    await expect(page.getByTestId("ha-pill")).toBeHidden();

    const expectConnectionInsideViewport = async () => {
      const bounds = await page.getByTestId("connection").boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) throw new Error("The connection trigger must have a visible hit area");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(768);
    };
    await expectConnectionInsideViewport();

    await rail.getByRole("button", { name: "Collapse navigation" }).click();
    await expect(rail).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("ha-pill")).toBeVisible();
    await expectConnectionInsideViewport();
  });
  test("keeps the Mac command shortcut inside the full-width search control", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "userAgent", {
        configurable: true,
        get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      });
    });
    await gotoReady(page, "/apps");

    const search = page.getByTestId("palette-trigger");
    await expect(search).toContainText("⌘ K");
    await expect(search).toHaveCSS("width", "144px");
    const shortcut = search.locator("kbd");
    await expect(shortcut).toHaveCSS("flex-shrink", "0");
    await expect(shortcut).toHaveCSS("white-space", "nowrap");
    await expect(shortcut).toContainText("⌘ K");
  });
  test("keeps the refresh interval and update label tightly grouped", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ livePaused: true, liveIntervalMs: 3000 }));
    }, PREFS_KEY);
    await page.goto("/apps");
    await expect(page.getByTestId("live-pause")).toHaveAttribute("data-paused", "true");
    await expect(page.getByTestId("live-interval")).toContainText("3 s");

    const spacing = await page.evaluate(() => {
      const interval = document.querySelector<HTMLElement>('[data-testid="live-interval"]');
      const trigger = interval?.querySelector<HTMLElement>("button");
      const updated = document.querySelector<HTMLElement>('[data-testid="last-updated"]');
      if (!trigger || !updated) throw new Error("Topbar refresh and update controls must be mounted");
      const range = document.createRange();
      range.selectNodeContents(updated);
      return range.getBoundingClientRect().left - trigger.getBoundingClientRect().right;
    });
    expect(spacing).toBeLessThanOrEqual(8);
  });

  test("ages the last-response label after live responses stop", async ({ page }) => {
    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ livePaused: false, liveIntervalMs: 30000 }));
    }, PREFS_KEY);
    await page.goto("/apps");
    const updated = page.getByTestId("last-updated");
    await page.getByRole("button", { name: "About Last successful response" }).focus();
    await expect(page.getByRole("tooltip")).toContainText("Last successful API response");
    await page.route("**/api/yarn/**", (route) => route.abort());
    await expect(updated).toHaveText(/\d+s ago/, { timeout: 5000 });
  });

  test("keeps the update pulse alive through a throttled successful response", async ({ page }) => {
    await page.addInitScript((key: string) => {
      localStorage.setItem(key, JSON.stringify({ livePaused: true, liveIntervalMs: 30000 }));
      // addInitScript can run before the parser creates <html>; apply the duration as soon as it exists.
      const setFlashDuration = () => {
        if (!document.documentElement) return false;
        document.documentElement.style.setProperty("--dur-flash", "30000ms");
        return true;
      };
      if (!setFlashDuration()) {
        const observer = new MutationObserver(() => {
          if (setFlashDuration()) observer.disconnect();
        });
        observer.observe(document, { childList: true });
      }
      const animate = Element.prototype.animate;
      window.__responsePulseTrace = [];
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (this.matches('[data-testid="last-updated"] > span')) {
          const pulse = { animation, canceled: false };
          animation.addEventListener("cancel", () => {
            pulse.canceled = true;
          });
          window.__responsePulseTrace?.push(pulse);
        }
        return animation;
      };
    }, PREFS_KEY);

    let firstSuccess!: () => void;
    const firstFulfilled = new Promise<void>((resolve) => {
      firstSuccess = resolve;
    });
    let successfulResponses = 0;
    let deliveredResponses = 0;
    await page.route("**/api/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/api/events") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const index = response.ok() ? successfulResponses++ : -1;
      if (index === 1) {
        await firstFulfilled;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await route.fulfill({ response });
      if (index === 0) firstSuccess();
      if (index >= 0 && index < 2) deliveredResponses++;
    });

    await gotoReady(page, "/apps");
    await expect.poll(() => deliveredResponses).toBeGreaterThanOrEqual(2);
    // Let the second response reach React while the first pulse is still running.
    await page.waitForTimeout(100);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const pulse = window.__responsePulseTrace?.[0];
          return pulse ? { canceled: pulse.canceled, playState: pulse.animation.playState } : null;
        }),
      )
      .toEqual({ canceled: false, playState: "running" });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("pause/resume and the refresh interval control the live state", async ({ page }) => {
    await gotoReady(page, "/apps");
    const pause = page.getByTestId("live-pause");
    await expect(page.getByTestId("topbar")).toHaveAttribute("data-live", "live");
    await pause.click();
    await expect(pause).toHaveAttribute("data-paused", "true");
    await expect(page.getByTestId("topbar")).toHaveAttribute("data-live", "paused");
    await pause.click();
    await expect(page.getByTestId("topbar")).toHaveAttribute("data-live", "live");

    await page.getByTestId("live-interval").click();
    await page.getByRole("option", { name: "10 s" }).click();
    await expect(page.getByTestId("live-interval")).toContainText("10 s");
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), PREFS_KEY);
    expect(stored.liveIntervalMs).toBe(10000);
  });

  test("connection popover reports the RM and every auxiliary service", async ({ page }) => {
    await freezeLive(page);
    await gotoReady(page, "/apps");
    await page.getByTestId("connection").click();
    const popover = page.getByRole("dialog").filter({ hasText: "Connection" });
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Cache");
    await expect(popover).toContainText("Served by");
    await expect(popover).toContainText("ResourceManager");
    await expect(popover).toContainText("Spark History Server");
    await expect(popover).toContainText("JobHistory Server");
    await expect(popover).toContainText("Timeline Service");
    await expect(popover).toContainText("3.4.3");
  });

  test("command palette navigates and searches cached applications", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    const palette = page.getByTestId("command-palette");
    // Search with the stable identifier from the rendered table instead of a generated application name.
    await expect(page.locator('[data-yf="app.name"]').first()).toBeAttached();
    const appId = (await page.locator('[data-yf="app.id"]').first().textContent())?.trim() ?? "";
    expect(appId).toMatch(/^application_/);

    await page.getByTestId("palette-trigger").click();
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("combobox")).toBeFocused();

    // navigation
    await palette.getByRole("combobox").fill("nodes");
    await palette.getByRole("option", { name: /Nodes/ }).first().click();
    await expect(page).toHaveURL(/\/nodes/);

    // The app-specific result carries the identifier in its hint; ignore the broader "Applications named…" filter action.
    await page.getByTestId("palette-trigger").click();
    await palette.getByRole("combobox").fill(appId);
    const appOption = palette.locator(`[id="palette-app:${appId}"]`);
    await expect(appOption).toBeVisible();
    await expect(appOption).toContainText(appId);
    await appOption.click();
    await expect(page).toHaveURL(new RegExp(`/apps/${appId}`));
  });

  test("command palette keeps the active keyboard result in view", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    await freezeLive(page);
    await gotoReady(page, "/apps");
    await page.getByTestId("palette-trigger").click();

    const palette = page.getByTestId("command-palette");
    const input = palette.getByRole("combobox");
    const results = palette.getByRole("listbox");
    await input.fill("a");
    await expect.poll(() => results.getByRole("option").count()).toBeGreaterThan(12);

    for (let i = 0; i < 12; i++) await input.press("ArrowDown");
    await expect
      .poll(() =>
        results.evaluate((list) => {
          const id = document.querySelector('[data-testid="command-palette"] [role="combobox"]')?.getAttribute("aria-activedescendant");
          const active = id ? document.getElementById(id) : null;
          if (!active) return false;
          const itemRect = active.getBoundingClientRect();
          const listRect = list.getBoundingClientRect();
          return itemRect.top >= listRect.top && itemRect.bottom <= listRect.bottom && list.scrollTop > 0;
        }),
      )
      .toBe(true);
  });

  test("the palette trigger, `/` and `?` work without a mouse", async ({ page }) => {
    await freezeLive(page);
    await gotoReady(page, "/apps");
    await page.getByTestId("palette-trigger").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toBeHidden();

    await page.keyboard.press("/");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press("?");
    const help = page.getByTestId("shortcuts-dialog");
    await expect(help).toBeVisible();
    await expect(help).toContainText("Open the command palette");
    await expect(help).toContainText("Go to Applications");
    await page.keyboard.press("Escape");
  });

  test("g-then-key navigation goes to applications, nodes and the overview", async ({ page }) => {
    await freezeLive(page);
    await gotoReady(page, "/apps");
    await page.keyboard.press("g");
    await page.keyboard.press("n");
    await expect(page).toHaveURL(/\/nodes/);
    await page.keyboard.press("g");
    await page.keyboard.press("s");
    await expect(page).toHaveURL(/\/scheduler/);
    await page.keyboard.press("g");
    await page.keyboard.press("o");
    await expect(page).toHaveURL(/\/\?window=|^http:\/\/[^/]+\/$/);
    await page.keyboard.press("g");
    await page.keyboard.press("a");
    await expect(page).toHaveURL(/\/apps/);
  });

  test("theme and time zone change the document and persist", async ({ page }) => {
    // the resolved theme follows the OS when the pref is `system`: pin dark so the toggle has a known start state
    await setPrefs(page, { livePaused: true, liveIntervalMs: 30000, theme: "dark" });
    await gotoReady(page, "/apps");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const lightTheme = page.getByRole("button", { name: "Theme: light" });
    await lightTheme.hover();
    const lightHint = "Use light mode regardless of your operating system’s appearance preference.";
    await expect(page.getByRole("tooltip").filter({ hasText: lightHint })).toHaveText(lightHint);
    const darkTheme = page.getByRole("button", { name: "Theme: dark" });
    await darkTheme.hover();
    const darkHint = "Use dark mode regardless of your operating system’s appearance preference.";
    await expect(page.getByRole("tooltip").filter({ hasText: darkHint })).toHaveText(darkHint);

    await lightTheme.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const localTime = page.getByRole("button", { name: "Times in local time zone" });
    await localTime.hover();
    const localHint = "Convert displayed timestamps to this browser’s local time zone. Stored timestamps are unchanged.";
    await expect(page.getByRole("tooltip").filter({ hasText: localHint })).toHaveText(localHint);
    const utcTime = page.getByRole("button", { name: "Times in UTC" });
    await utcTime.hover();
    const utcHint = "Display timestamps in Coordinated Universal Time (UTC). Stored timestamps are unchanged.";
    await expect(page.getByRole("tooltip").filter({ hasText: utcHint })).toHaveText(utcHint);

    await utcTime.click();
    await expect(page.locator("html")).toHaveAttribute("data-tz", "utc");

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), PREFS_KEY);
    expect(stored).toMatchObject({ theme: "light", tz: "utc" });
  });

  test("mobile connection settings explain theme and timestamp conversion without hover", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReady(page, "/apps");
    await page.getByTestId("connection").click();

    await expect(page.getByRole("heading", { name: "View settings" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Theme" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Time zone" })).toBeVisible();
    await expect(
      page.getByText(
        "Theme changes appearance. Local converts displayed timestamps to this browser’s time zone; UTC keeps them in Coordinated Universal Time.",
      ),
    ).toBeVisible();
  });

  test("saved density options are ignored and the layout stays medium", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((key) => {
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, JSON.stringify({ density: "compact", livePaused: true, liveIntervalMs: 30000 }));
      }
    }, PREFS_KEY);
    await page.goto("/apps");
    await expect(page.getByRole("heading", { name: "Applications", level: 1 })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-tz", "local");
    await expect(page.getByTestId("live-pause")).toHaveAttribute("data-paused", "true");
    await expect(page.getByTestId("density-toggle")).toHaveCount(0);

    const readSizing = () =>
      page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return {
          density: document.documentElement.getAttribute("data-density"),
          row: style.getPropertyValue("--row-h").trim(),
          cell: style.getPropertyValue("--cell-px").trim(),
          control: style.getPropertyValue("--ctl-h").trim(),
        };
      });
    const medium = { density: null, row: "34px", cell: "10px", control: "34px" };
    expect(await readSizing()).toEqual(medium);

    await page.getByTestId("tz-toggle").getByRole("button", { name: /UTC/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-tz", "utc");
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), PREFS_KEY);
    expect(saved).not.toHaveProperty("density");
    expect(saved).toHaveProperty("tz", "utc");

    await page.reload();
    await expect(page.getByTestId("live-pause")).toHaveAttribute("data-paused", "true");
    await expect(page.getByTestId("density-toggle")).toHaveCount(0);
    expect(await readSizing()).toEqual(medium);
    await expect(page.locator("html")).toHaveAttribute("data-tz", "utc");
    await page.getByTestId("palette-trigger").click();
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox").fill("density");
    await expect(palette.getByRole("option", { name: /^Density:/i })).toHaveCount(0);
  });

  test("pre-paint preferences survive hydration and keep the search control stable", async ({ page }) => {
    await page.addInitScript((key: string) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          theme: "dark",
          motion: "reduced",
          railCollapsed: true,
          livePaused: true,
          liveIntervalMs: 30000,
        }),
      );
      const history: Record<string, Array<string | null>> = {
        "data-theme": [],
        "data-theme-pref": [],
        "data-tz": [],
        "data-motion": [],
        "data-rail-collapsed": [],
        "data-parity": [],
      };
      (window as unknown as Window & { __ysPrefsAttributeHistory: typeof history }).__ysPrefsAttributeHistory = history;
      const observer = new MutationObserver((records) => {
        records.forEach((record, index) => {
          if (record.target !== document.documentElement) return;
          const name = record.attributeName;
          const values = name ? history[name] : undefined;
          if (!name || !values) return;
          const next = records
            .slice(index + 1)
            .find((candidate) => candidate.target === document.documentElement && candidate.attributeName === name);
          values.push(next ? next.oldValue : document.documentElement.getAttribute(name));
        });
      });
      observer.observe(document, {
        attributes: true,
        subtree: true,
        attributeOldValue: true,
        attributeFilter: ["data-theme", "data-theme-pref", "data-tz", "data-motion", "data-rail-collapsed", "data-parity"],
      });
    }, PREFS_KEY);
    // This test covers early preference setup, not unvirtualized table rendering. Keep the parity route lightweight.
    await page.goto("/?parity=1");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
    await expect(page.locator("html")).toHaveAttribute("data-rail-collapsed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-parity", "1");
    await expect(page.getByTestId("palette-trigger")).toHaveCSS("width", "144px");
    const widthBeforeReload = await page.getByTestId("palette-trigger").evaluate((element) => element.getBoundingClientRect().width);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
    await expect(page.locator("html")).toHaveAttribute("data-rail-collapsed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-parity", "1");
    await expect(page.getByTestId("palette-trigger")).toHaveCSS("width", "144px");
    await expect(page.getByTestId("palette-trigger")).toBeVisible();
    const widthAfterReload = await page.getByTestId("palette-trigger").evaluate((element) => element.getBoundingClientRect().width);
    expect(widthAfterReload).toBe(widthBeforeReload);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const history = await page.evaluate(
      () => (window as unknown as Window & { __ysPrefsAttributeHistory: Record<string, Array<string | null>> }).__ysPrefsAttributeHistory,
    );
    for (const name of ["data-theme", "data-theme-pref", "data-tz", "data-motion", "data-rail-collapsed", "data-parity"]) {
      expect(history[name], `html attribute ${name} was removed during hydration`).not.toContain(null);
    }
    expect(history["data-theme"]).toContain("dark");
    expect(history["data-motion"]).toContain("reduced");
    expect(history["data-rail-collapsed"]).toContain("true");
    expect(history["data-theme-pref"]).toContain("dark");
    expect(history["data-tz"]).toContain("local");
    expect(history["data-parity"]).toContain("1");
  });

  test("page switches keep the title immediate and cascade cards before the table", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/nodes");
    await expect(page.getByRole("heading", { name: "Nodes", exact: true })).toBeVisible();
    const timings = await page.evaluate(() => {
      const title = document.querySelector(".burrow-page-scroll h1");
      const cards = document.querySelector('[data-page-motion="cards"]');
      const table = document.querySelector(".burrow-tab-content");
      return {
        titleAnimation: title ? getComputedStyle(title).animationName : null,
        cardDelays: Array.from(cards?.children ?? [])
          .slice(0, 4)
          .map((element) => getComputedStyle(element).animationDelay),
        tableAnimation: table ? getComputedStyle(table).animationName : null,
        tableDelay: table ? getComputedStyle(table).animationDelay : null,
      };
    });
    expect(timings).toEqual({
      titleAnimation: "none",
      cardDelays: ["0s", "0.024s", "0.048s", "0.072s"],
      tableAnimation: "burrow-page-content-in",
      tableDelay: "0.072s",
    });
  });

  test("overview keeps its heading immediate and cascades sections on page entry", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Overview", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByTestId("cluster-metrics")).toBeVisible();
    const timing = await page.evaluate(() => {
      const title = document.querySelector(".burrow-page-scroll h1");
      const scroll = document.querySelector<HTMLElement>(".burrow-page-scroll");
      const cards = document.querySelector('[data-page-motion="cards"]');
      if (!scroll || !cards) throw new Error("Overview content groups are missing");
      const sections = Array.from(scroll.querySelectorAll(":scope > div > section"));
      return {
        titleAnimation: title ? getComputedStyle(title).animationName : null,
        sectionAnimations: sections.map((section) => getComputedStyle(section).animationName),
        sectionDelays: sections.map((section) => getComputedStyle(section).animationDelay),
        cardDelays: Array.from(cards.children).map((card) => getComputedStyle(card).animationDelay),
      };
    });
    expect(timing).toEqual({
      titleAnimation: "none",
      sectionAnimations: ["burrow-page-content-in", "burrow-page-content-in", "burrow-page-content-in"],
      sectionDelays: ["0s", "0.024s", "0.048s"],
      cardDelays: ["0s", "0.024s"],
    });
  });

  test("centers the compact rail toggle and trailing-aligns it when expanded", async ({ page }) => {
    await freezeLive(page);
    await setPrefs(page, { railCollapsed: true });
    await page.goto("/apps");

    const rail = page.getByTestId("rail");
    const brand = rail.locator(":scope > div").first();
    // The footer is the rail's last child and holds two rows: the connection line (the toggle lives here) and the
    // version line. Both rows are always in the DOM — the collapsed rail hides the version line with `display: none`
    // rather than unmounting it, so the first client render matches the server's (DESIGN §5.5 rule 10: a pref must not
    // change the shell's markup, or React throws #418 and rebuilds the tree). Select the footer, not "the last row".
    const foot = rail.locator(":scope > :last-child");
    const row = foot.locator(".burrow-rail-footer-row");

    // The compact brand and expand control share the rail centerline.
    await expect(rail).toHaveAttribute("data-collapsed", "true");
    await expect(rail).toHaveCSS("width", "56px");
    await expect(brand.getByRole("button")).toHaveCount(0);
    const expand = foot.getByRole("button", { name: "Expand navigation" });
    await expect(expand).toBeVisible();
    await expect(expand).toHaveCSS("translate", "-50% -50%");
    const collapsedRail = await rail.boundingBox();
    const expandBox = await expand.boundingBox();
    expect(collapsedRail).not.toBeNull();
    expect(expandBox).not.toBeNull();
    expect(Math.abs(expandBox!.x + expandBox!.width / 2 - (collapsedRail!.x + collapsedRail!.width / 2))).toBeLessThan(1);
    const brandMark = brand.locator(".burrow-rail-brand-mark").filter({ visible: true });
    await expect(brandMark).toHaveCSS("opacity", "1");
    const logoBox = await brandMark.boundingBox();
    expect(logoBox).not.toBeNull();
    expect(Math.abs(logoBox!.x + logoBox!.width / 2 - (collapsedRail!.x + collapsedRail!.width / 2))).toBeLessThan(2);

    // Expanded, the same control moves to the footer row's trailing edge; the brand row still has no button.
    await expand.click();
    await expect(rail).toHaveAttribute("data-collapsed", "false");
    const collapse = foot.getByRole("button", { name: "Collapse navigation" });
    await expect(collapse).toBeVisible();
    await expect(rail).toHaveCSS("width", "224px");
    await expect(collapse).toHaveCSS("translate", "-100% -50%");
    await expect(brand.getByRole("button")).toHaveCount(0);
    const rowBox = await row.boundingBox();
    const collapseBox = await collapse.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(collapseBox).not.toBeNull();
    expect(Math.abs(collapseBox!.x + collapseBox!.width - (rowBox!.x + rowBox!.width))).toBeLessThan(1);
  });

  test("desktop rail width eases between collapsed and expanded states", async ({ page }) => {
    await freezeLive(page);
    await page.goto("/apps");
    await expect(page.getByRole("heading", { name: "Applications", level: 1 })).toBeVisible();
    const rail = page.getByTestId("rail");
    const tokens = await page.locator("html").evaluate((element) => {
      const style = getComputedStyle(element);
      const token = style.getPropertyValue("--dur-base").trim();
      const value = Number.parseFloat(token);
      return {
        duration: `${token.endsWith("ms") ? value / 1000 : value}s`,
        easing: style.getPropertyValue("--ease-in-out").trim(),
      };
    });
    const widthTransition = async () =>
      rail.evaluate((element) => {
        const style = getComputedStyle(element);
        const splitCssList = (value: string) => {
          const parts: string[] = [];
          let start = 0;
          let depth = 0;
          for (let index = 0; index < value.length; index += 1) {
            const char = value[index];
            if (char === "(") depth += 1;
            else if (char === ")") depth -= 1;
            else if (char === "," && depth === 0) {
              parts.push(value.slice(start, index).trim());
              start = index + 1;
            }
          }
          parts.push(value.slice(start).trim());
          return parts;
        };
        const properties = splitCssList(style.transitionProperty);
        const widthIndex = properties.indexOf("width");
        return {
          property: properties[widthIndex],
          duration: splitCssList(style.transitionDuration)[widthIndex],
          easing: splitCssList(style.transitionTimingFunction)[widthIndex] ?? "",
        };
      });
    const normalizeEasing = (value: string) =>
      value.replace(/\s+/g, "").replace(/([,(])\.(\d)/g, (_match, prefix: string, digit: string) => `${prefix}0.${digit}`);
    const transition = await widthTransition();
    expect(transition.property).toBe("width");
    expect(transition.duration).toBe(tokens.duration);
    expect(normalizeEasing(transition.easing)).toBe(normalizeEasing(tokens.easing));

    const width = () => rail.evaluate((element) => Number.parseFloat(getComputedStyle(element).width));
    await expect.poll(width).toBe(224);

    await rail.getByRole("button", { name: "Collapse navigation" }).click();
    await expect(rail).toHaveAttribute("data-collapsed", "true");
    await expect.poll(width).toBe(56);

    await rail.getByRole("button", { name: "Expand navigation" }).click();
    await expect(rail).toHaveAttribute("data-collapsed", "false");
    await expect.poll(width).toBe(224);
    await expect(rail).toHaveCSS("transition-property", /width/);

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect((await widthTransition()).duration).toBe("0s");
  });
  test("the mobile drawer renders the expanded rail and no collapse control", async ({ page }) => {
    await freezeLive(page);
    // the pref is shared with the desktop rail; a drawer is closed, never collapsed, so it must ignore it
    await setPrefs(page, { railCollapsed: true });
    await page.setViewportSize({ width: 390, height: 780 });
    await gotoReady(page, "/apps");
    await page.getByTestId("rail-toggle").click();

    const drawer = page.getByRole("dialog", { name: "Navigation" });
    const rail = drawer.getByTestId("rail");
    await expect(rail).toHaveAttribute("data-collapsed", "false");
    await expect(rail.getByRole("link", { name: "Applications" })).toContainText("Applications");
    await expect(rail.getByRole("button", { name: /navigation/i })).toHaveCount(0);
  });

  test("removes press scaling for both reduced-motion settings", async ({ page }) => {
    const checkPress = async (control: Locator) => {
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
      await page.mouse.down();
      await expect.poll(() => control.evaluate((element) => getComputedStyle(element).scale)).toBe("none");
      await page.mouse.up();
    };

    await setPrefs(page, { livePaused: true, liveIntervalMs: 30000, motion: "system" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await checkPress(page.getByTestId("live-pause"));
    await checkPress(page.getByRole("button", { name: "Theme: light" }));

    await setPrefs(page, { livePaused: true, liveIntervalMs: 30000, motion: "reduced" });
    await page.reload();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
    await checkPress(page.getByTestId("live-pause"));
    await checkPress(page.getByRole("button", { name: "Theme: light" }));
  });

  test("screenshots: shell in dark and light", { tag: "@snapshot" }, async ({ page }) => {
    await setPrefs(page, { theme: "dark" });
    await freezeLive(page);
    await page.goto("/apps");
    await expect(page.getByTestId("topbar")).toBeVisible();
    await expect(page.locator("[data-burrow-table=apps]")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page).toHaveScreenshot("shell-dark.png");

    await page.getByTestId("theme-toggle").getByRole("button", { name: /light/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.waitForTimeout(250);
    await expect(page).toHaveScreenshot("shell-light.png");

    // the palette is part of the shell chrome
    await page.getByTestId("palette-trigger").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await expect(page).toHaveScreenshot("palette-light.png");
  });
});
test.describe("timezone-aware date rendering", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("the Overview start time updates immediately when switching to UTC", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setPrefs(page, { tz: "local", livePaused: true, liveIntervalMs: 30000 });
    await page.clock.setFixedTime(new Date("2026-10-03T12:04:09.000Z"));
    await page.goto("/");

    const started = page.getByTestId("identity").locator('[data-yf="cluster.info.startedOn"]');
    await expect(started).toBeVisible();
    const localTime = (await started.innerText()).trim();
    const rawStarted = await started.getAttribute("data-yv");
    const utcStarted = new Date(Number(rawStarted)).toISOString().replace("T", " ").slice(0, 19);
    await page.getByTestId("tz-toggle").getByRole("button", { name: /UTC/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-tz", "utc");
    await expect(started).toContainText(utcStarted);
    await expect(started).toHaveAttribute("data-yv", rawStarted!);
    await expect(started).not.toHaveText(localTime);
  });
  test("JMX last-read time follows the timezone preference", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setPrefs(page, { tz: "local", livePaused: true, liveIntervalMs: 30000 });
    await page.clock.setFixedTime(new Date("2026-10-03T12:04:09.000Z"));
    await page.goto("/tools/jmx");

    const readTime = page.getByText(/^read \d{2}:\d{2}:\d{2}$/);
    await expect(readTime).toBeVisible({ timeout: 30_000 });
    await expect(readTime).toHaveText("read 05:04:09");
    await page.getByTestId("tz-toggle").getByRole("button", { name: /UTC/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-tz", "utc");
    await expect(readTime).toHaveText("read 12:04:09");
  });

  test("Stacks last-read time follows the timezone preference", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setPrefs(page, { tz: "local", livePaused: true, liveIntervalMs: 30000 });
    await page.clock.setFixedTime(new Date("2026-10-03T12:04:09.000Z"));
    await page.goto("/tools/stacks");

    const readTime = page.getByText(/^read \d{2}:\d{2}:\d{2}$/);
    await expect(readTime).toBeVisible({ timeout: 30_000 });
    await expect(readTime).toHaveText("read 05:04:09");
    await page.getByTestId("tz-toggle").getByRole("button", { name: /UTC/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-tz", "utc");
    await expect(readTime).toHaveText("read 12:04:09");
  });
});
