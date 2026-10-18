// Our UI (TanStack Start SPA) scraping: reads exactly what docs/contracts/parity-dom.md promises —
// `data-ye` (entity key) / `data-yf` (field id) / `data-yv` (raw upstream value) / `data-yn` (null).
//
// Always loaded with `?parity=1`, so the SPA renders every field, all rows, no pagination and no
// animations. The same extraction runs against a recorded DOM dump in replay mode.
import path from "node:path";
import { newPage } from "./legacy.mjs";
import { readTextIfExists, slug, writeJson, writeText } from "./sources.mjs";
import { sleep } from "./util.mjs";

/** Browser-side extractor (self-contained, serialised by Playwright). */
export function extractOursDom() {
  const datums = [];
  for (const el of document.querySelectorAll("[data-yf]")) {
    const holder = el.closest("[data-ye]");
    datums.push({
      entity: holder ? holder.getAttribute("data-ye") : "_",
      field: el.getAttribute("data-yf"),
      raw: el.getAttribute("data-yv"),
      yn: el.getAttribute("data-yn") === "1",
      fmt: el.getAttribute("data-yfmt"),
      text: (el.textContent || "").replace(/\s+/g, " ").trim(),
      tag: el.tagName.toLowerCase(),
    });
  }
  const entities = [...document.querySelectorAll("[data-ye]")].map((e) => e.getAttribute("data-ye"));
  return {
    url: location.href,
    title: (document.title || "").trim(),
    datums,
    entities: [...new Set(entities)],
    bodyText: (document.body ? document.body.innerText : "").slice(0, 4000),
    hasShell: !!document.querySelector("[data-ye]"),
  };
}

export function oursDomPath(fixtureDir, scenarioId, routeKey) {
  return path.join(fixtureDir, scenarioId, "ours", `${slug(routeKey)}.html`);
}

function withParity(url) {
  const u = new URL(url);
  u.searchParams.set("parity", "1");
  return u.toString();
}

/** Capture one SPA route live. */
export async function captureOursLive(browser, { baseUrl, routeKey, timeoutMs = 15000 } = {}) {
  const { ctx, page } = await newPage(browser);
  const url = withParity(new URL(routeKey, baseUrl).toString());
  const out = { routeKey, url, error: null };
  try {
    await page.addInitScript(() => {
      window.__YS_PARITY__ = true;
    });
    const res = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    out.httpStatus = res ? res.status() : null;
    // parity mode renders every field; wait briefly for the DOM to carry parity attributes, but do
    // not burn the full timeout on routes that legitimately render nothing yet.
    await page
      .waitForFunction(() => document.querySelector("[data-yf]") || document.querySelector("[data-ye]"), null, {
        timeout: Math.min(4000, timeoutMs),
      })
      .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
    // A route renders progressively (shell first, then each query as it resolves): the first data-yf appearing is not "done".
    // Poll the datum count until it has been unchanged for ~1s (bounded), so a cold first navigation cannot be captured half-rendered.
    {
      let last = -1;
      let stableFor = 0;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && stableFor < 4) {
        const n = await page.evaluate(() => document.querySelectorAll("[data-yf]").length).catch(() => 0);
        stableFor = n === last ? stableFor + 1 : 0;
        last = n;
        await sleep(250);
      }
    }
    await sleep(120);
    const dom = await page.evaluate(extractOursDom);
    out.httpStatus = out.httpStatus ?? null;
    out.html = await page.content();
    out.datums = dom.datums;
    out.entities = dom.entities;
    out.title = dom.title;
    out.hasShell = dom.hasShell;
    out.bodyText = dom.bodyText;
  } catch (e) {
    out.error = String(e?.message ?? e);
    out.datums = out.datums ?? [];
    out.entities = out.entities ?? [];
    out.html = await page.content().catch(() => "<html><body>capture failed</body></html>");
  } finally {
    await ctx.close();
  }
  return out;
}

/** Replay a recorded SPA DOM dump: JavaScript disabled, no network at all. */
export async function captureOursFromHtml(browser, { html, routeKey, url }) {
  const { ctx, page } = await newPage(browser, { javaScriptEnabled: false });
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    const dom = await page.evaluate(extractOursDom);
    return { routeKey, url, replayed: true, error: null, datums: dom.datums, entities: dom.entities, title: dom.title, hasShell: dom.hasShell };
  } catch (e) {
    return { routeKey, url, replayed: true, error: String(e?.message ?? e), datums: [], entities: [] };
  } finally {
    await ctx.close();
  }
}

export function loadRecordedOurs(fixtureDir, scenarioId, routeKey) {
  return readTextIfExists(oursDomPath(fixtureDir, scenarioId, routeKey));
}

export function dumpOurs(fixtureDir, scenarioId, routeKey, capture) {
  writeText(oursDomPath(fixtureDir, scenarioId, routeKey), capture.html ?? "<html></html>");
  const { html, ...rest } = capture;
  writeJson(path.join(fixtureDir, scenarioId, "ours", `${slug(routeKey)}.json`), rest);
}

/** Is anything listening at this base URL? */
export async function probeBase(baseUrl, { path: probePath = "/", timeoutMs = 4000 } = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(new URL(probePath, baseUrl).toString(), { signal: ctrl.signal });
    clearTimeout(t);
    return { reachable: true, status: res.status };
  } catch (e) {
    return { reachable: false, error: String(e?.message ?? e) };
  }
}
