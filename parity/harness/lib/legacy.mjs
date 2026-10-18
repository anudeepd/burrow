// Legacy (stock Hamlet) UI scraping: live Playwright navigation and replay of recorded HTML.
//
// One extractor (`lib/dom-extract.mjs`) is used for both, so a replayed run exercises exactly the
// same parsing code as the live run. Records are flattened into (entity key, label) -> text so the
// comparison layer can join them with inventory items and with our own `data-yf` DOM.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { extractLegacyDom } from "./dom-extract.mjs";
import { htmlToText, sleep, uniq } from "./util.mjs";
import { resolveRoute, routeTokens, paramAlias } from "./inventory.mjs";
import { readTextIfExists, writeJson, writeText, slug } from "./sources.mjs";

export async function createBrowser({ headless = true } = {}) {
  return chromium.launch({
    headless,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--mute-audio"],
  });
}

export async function newPage(browser, { javaScriptEnabled = true } = {}) {
  const ctx = await browser.newContext({
    javaScriptEnabled,
    viewport: { width: 1600, height: 1400 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    timezoneId: undefined,
  });
  return { ctx, page: await ctx.newPage() };
}

/** Wait until a page's DataTables/JS is settled enough to scrape. */
export async function settle(page, { expectRows = 0, timeoutMs = 12000 } = {}) {
  await page.waitForSelector("#layout", { timeout: timeoutMs }).catch(() => {});
  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
  if (expectRows > 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const n = await page
        .evaluate(() => document.querySelectorAll("table#apps tbody tr,table#nodes tbody tr").length)
        .catch(() => 0);
      if (n >= expectRows) break;
      await sleep(200);
    }
  }
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(150);
}

/**
 * Capture one legacy page live. `expectRows` (from the REST app/node counts) makes the DataTables
 * wait deterministic instead of a blind sleep.
 */
export async function captureLive(browser, { baseUrl, routePath, pageId, expectRows = 0 } = {}) {
  const { ctx, page } = await newPage(browser);
  const url = new URL(routePath, baseUrl).toString();
  let httpStatus = null;
  let contentType = null;
  let navError = null;
  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: 25000 });
    httpStatus = res ? res.status() : null;
    contentType = res ? (res.headers()["content-type"] ?? null) : null;
    await settle(page, { expectRows });
  } catch (e) {
    navError = String(e?.message ?? e);
  }
  const capture = await page.evaluate(extractLegacyDom).catch((e) => ({
    url,
    title: null,
    tables: [],
    nav: [],
    extractError: String(e?.message ?? e),
  }));
  const html = await page.content().catch(() => "");
  await ctx.close();
  return { pageId, route: routePath, url, httpStatus, contentType, navError, capture, html };
}

/** Capture from recorded post-JS HTML with JavaScript disabled: no network, no Java, same parser. */
export async function captureFromHtml(browser, { html, url, pageId, routePath }) {
  const { ctx, page } = await newPage(browser, { javaScriptEnabled: false });
  let extract = null;
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    extract = await page.evaluate(extractLegacyDom);
  } finally {
    await ctx.close();
  }
  return { pageId, route: routePath, url, httpStatus: 200, replayed: true, capture: extract };
}

export function legacyHtmlPath(fixtureDir, scenarioId, pageId) {
  return path.join(fixtureDir, scenarioId, "legacy", `${slug(pageId)}.html`);
}

export function loadRecordedLegacy(fixtureDir, scenarioId, pageId) {
  return readTextIfExists(legacyHtmlPath(fixtureDir, scenarioId, pageId));
}

export function recordLegacyHtml(fixtureDir, scenarioId, pageId, html, meta) {
  writeText(legacyHtmlPath(fixtureDir, scenarioId, pageId), html);
  writeJson(path.join(fixtureDir, scenarioId, "legacy", `${slug(pageId)}.meta.json`), meta);
}

const ENTITY_HREF = /\/(?:cluster|proxy)\/(?:app|appattempt|container)\/([A-Za-z0-9_:.-]+)/;
const KNOWN_KEY_PREFIX = /^(application|appattempt|container)_\d+_\d+|^\d{1,3}(?:\.\d{1,3}){3}:\d+$/;

export function entityTypeOfKey(key) {
  if (!key) return null;
  if (/^application_/.test(key)) return "app";
  if (/^appattempt_/.test(key)) return "attempt";
  if (/^container_/.test(key)) return "container";
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(key)) return "node";
  return null;
}

/** Which entity does a page's own label/value pairs belong to? Derived from route tokens. */
export function pageEntityOf(routePath, params) {
  const tokens = routeTokens(routePath);
  for (const t of tokens) {
    const alias = paramAlias(t);
    const key = params[alias];
    if (!key) continue;
    const type = entityTypeOfKey(key);
    if (type) return { entity: type, key };
  }
  return null;
}

const KEY_HEADER_LABELS = new Set([
  "id", "node id", "node address", "container id", "application id", "attempt id", "appattempt id", "application id/attempt id",
]);

/**
 * The capacity-scheduler page renders one `'<queue path>' Queue Status[ for Partition '<p>']` block per
 * selected leaf queue. The title is the only place the queue identity appears, and ours keys queues by the
 * same full path (root.default), so the block's pairs/rows are keyed by it with type=queue.
 */
/** Labels of the queue-bar records for inventory items that carry no label of their own (see compare.mjs labelFallback). */
export const BAR_QUEUE_NAME = "(queue bar name)";
export const BAR_AUTO_CREATED = "(queue bar auto-created)";
export const BAR_PARTITION = "(partition bar tag)";
export const ROW_HIGHLIGHT = "(row highlight)";

/** Per-queue user tables (`table#userinfo`): rows are keyed `<queuePath>#<user>` like our `data-ye`, and carry their partition. */
function userTableContext(t) {
  if (t.id !== "userinfo" || !t.queuePath) return null;
  const pm = String(t.partitionBar ?? "").match(/^Partition:\s*(\S+)/);
  return { queuePath: t.queuePath, partition: pm ? pm[1] : null };
}

const QUEUE_BLOCK_TITLE = /^'([^']+)' Queue Status(?: for Partition '([^']*)')?/;

export function queueOfSectionTitle(title) {
  const m = title ? String(title).match(QUEUE_BLOCK_TITLE) : null;
  return m ? { entity: "queue", key: m[1], partition: m[2] ?? null } : null;
}

/**
 * Flatten a capture into records: { pageId, key (entity key), type, label, text, href, title, kind,
 * tableId, sectionTitle, columnIndex, source }.
 * `source` is "dom" (rendered cell text) or "embedded" (`var xTableData` raw array entry).
 */
export function toRecords(capture, { pageId, routePath, params, pageEntity } = {}) {
  const recs = [];
  // entity that owns the table currently being flattened: the queue named by a queue-status block title,
  // else the page entity (app/attempt/container/node page); null for cluster-wide pages
  let curEnt = pageEntity;
  const push = (r) => {
    const text = r.text == null ? "" : String(r.text);
    // an empty table cell / kv value is a datum ("" = no value, e.g. no allocation tags, empty diagnostics), not a missing
    // record; empty metric pairs, headings and chrome stay dropped
    if (text === "" && !r.href && !r.title && !((r.kind === "cell" || r.kind === "kv") && r.label != null)) return;
    const key = r.key ?? curEnt?.key ?? "_";
    recs.push({
      pageId,
      key,
      type: r.type ?? entityTypeOfKey(key) ?? (curEnt && key === curEnt.key ? curEnt.entity : null) ?? null,
      partition: r.partition ?? null,
      label: r.label ?? null,
      text,
      href: r.href ?? null,
      title: r.title ?? null,
      kind: r.kind ?? "kv",
      tableId: r.tableId ?? null,
      sectionTitle: r.sectionTitle ?? null,
      columnIndex: r.columnIndex ?? null,
      source: r.source ?? "dom",
      tableIndex: r.tableIndex ?? null,
    });
  };

  push({ label: "Logged in as: ", text: capture.user, kind: "chrome-user", key: "_", type: "clusteruser" });
  push({ label: null, text: capture.h1, kind: "title", key: "_", type: null, sectionTitle: null });
  for (const a of capture.nav ?? []) push({ label: a.text, text: a.text, href: a.href, kind: "nav", key: "_", type: "static" });

  for (const h of capture.headings ?? []) push({ label: h, text: h, kind: "heading", type: pageEntity?.entity ?? null });

  // capacity-scheduler queue tree. Without a label linked to an active NM the page draws ONE root bar that is the scheduler's own
  // (usedCapacity / queueName, key "_"); with one it draws a "Partition: <label> <resource>" bar per label, each followed by its own
  // full queue tree (root + children, that partition's usage). Bars carry the partition they were drawn for.
  {
    const bars = capture.queueBars ?? [];
    const hasPartitions = bars.some((b) => /^Partition:/.test(b.name));
    let partition = null;
    for (const bar of bars) {
      const pm = bar.name.match(/^Partition:\s*(\S+)/);
      if (pm) {
        partition = pm[1];
        push({ label: BAR_PARTITION, text: bar.name, kind: "bar", key: "_", type: "queue", partition });
        continue;
      }
      if (!hasPartitions && bar.topLevel && bar.name === "root") {
        push({ label: " used", text: bar.used, kind: "bar", key: "_", type: "scheduler" });
        push({ label: "root", text: bar.name, kind: "bar", key: "_", type: "scheduler" });
      }
      const own = { key: bar.name, type: "queue", kind: "bar", partition };
      push({ ...own, label: " used", text: bar.used });
      push({ ...own, label: BAR_QUEUE_NAME, text: bar.name });
      push({ ...own, label: BAR_AUTO_CREATED, text: String(!!bar.autoCreated) });
    }
  }

  const queueTitlesSeen = new Set();
  const pushQueueTitle = (title) => {
    const q = queueOfSectionTitle(title);
    if (!q || queueTitlesSeen.has(title)) return;
    queueTitlesSeen.add(title);
    push({ label: title, text: title, kind: "heading", key: q.key, type: q.entity, partition: q.partition });
  };

  for (const t of capture.tables ?? []) {
    const sectionTitle = t.sectionTitle ?? null;
    pushQueueTitle(sectionTitle);
    for (const p of t.pairs ?? []) pushQueueTitle(p.section ?? null);
    curEnt = queueOfSectionTitle(sectionTitle) ?? pageEntity;
    if (Array.isArray(t.pairs)) {
      for (const p of t.pairs) {
        const pairSection = p.section ?? sectionTitle;
        const q = queueOfSectionTitle(pairSection);
        const uctx = userTableContext(t);
        const firstUser = uctx ? t.rows?.[0]?.cells?.[0]?.text : null;
        const own = uctx ? (firstUser ? { key: `${uctx.queuePath}#${firstUser}`, entity: "queueuser" } : null) : t.kind === "metrics" ? null : (q ?? pageEntity);
        push({
          label: p.label,
          text: p.text,
          href: p.href,
          title: p.title,
          kind: t.kind === "metrics" ? "metric" : "kv",
          key: own?.key ?? "_",
          type: own?.entity ?? null,
          partition: uctx ? uctx.partition : (q?.partition ?? null),
          tableId: t.id,
          sectionTitle: pairSection,
          tableIndex: t.index,
        });
      }
    }
    if (t.kind === "datatable" || (t.headers?.length && t.rows?.length)) {
      const headerLabels = t.headers.map((h) => h.label);
      // --- rendered DOM cells
      const uctx = userTableContext(t);
      for (const [ri, row] of (t.rows ?? []).entries()) {
        const user = uctx ? row.cells?.[0]?.text : null;
        const key = uctx && user ? `${uctx.queuePath}#${user}` : rowKey(row, headerLabels, t, curEnt, capture);
        if (uctx && user) {
          push({ label: ROW_HIGHLIGHT, text: String(/FFFF00/i.test(row.style ?? "")), kind: "cell", key, type: "queueuser", partition: uctx.partition, tableId: t.id, sectionTitle, tableIndex: t.index, source: "dom" });
        }
        for (const [ci, c] of row.cells.entries()) {
          push({
            label: headerLabels[ci] ?? `col${ci}`,
            text: c.text,
            href: c.href,
            title: c.title,
            kind: "cell",
            key,
            ...(uctx && user ? { type: "queueuser", partition: uctx.partition } : {}),
            tableId: t.id,
            sectionTitle,
            columnIndex: ci,
            tableIndex: t.index,
            source: "dom",
          });
        }
      }
      // --- embedded DataTables source array (raw HTML strings; the pre-render ground truth)
      if (Array.isArray(t.embedded)) {
        for (const [ri, rowArr] of t.embedded.entries()) {
          if (!Array.isArray(rowArr)) continue;
          const key = embeddedRowKey(rowArr, headerLabels, t, curEnt, capture);
          for (const [ci, raw] of rowArr.entries()) {
            const parsed = parseEmbeddedCell(raw);
            push({
              label: headerLabels[ci] ?? `col${ci}`,
              text: parsed.text,
              href: parsed.href,
              title: parsed.title,
              kind: "cell",
              key,
              tableId: t.id,
              sectionTitle,
              columnIndex: ci,
              tableIndex: t.index,
              source: "embedded",
            });
          }
        }
      }
    } else if (t.kind === "grid") {
      const headers = t.headers?.length ? t.headers.map((h) => h.label) : (t.headerRows?.[0]?.cells ?? []).map((c) => c.text);
      for (const [ri, row] of (t.rows ?? []).entries()) {
        const key = rowKey(row, headers, t, curEnt, capture) ?? t.sectionTitle ?? `${t.id}#${ri}`;
        for (const [ci, c] of row.cells.entries()) {
          push({
            label: headers[ci] ?? `col${ci}`,
            text: c.text,
            href: c.href,
            title: c.title,
            kind: "grid-cell",
            key,
            tableId: t.id,
            sectionTitle,
            columnIndex: ci,
            tableIndex: t.index,
          });
        }
      }
    } else if (Array.isArray(t.rows) && t.rows.length && !t.pairs.length) {
      // unknown shape: record each cell positionally so nothing is invisible in the report
      for (const [ri, row] of t.rows.entries()) {
        for (const [ci, c] of row.cells.entries()) {
          push({
            label: `col${ci}`,
            text: c.text,
            href: c.href,
            title: c.title,
            kind: "grid-cell",
            key: curEnt?.key ?? `row${ri}`,
            tableId: t.id,
            sectionTitle,
            columnIndex: ci,
            tableIndex: t.index,
          });
        }
      }
    }
  }
  return recs;
}

function rowKey(row, headerLabels, table, pageEntity, capture) {
  const cells = row.cells ?? [];
  for (const c of cells) {
    const m = c.href ? String(c.href).match(ENTITY_HREF) : null;
    if (m) return m[1];
  }
  for (const [i, label] of headerLabels.entries()) {
    if (KEY_HEADER_LABELS.has(String(label ?? "").toLowerCase())) {
      const t = cells[i]?.text;
      if (t && (KNOWN_KEY_PREFIX.test(t) || /^[A-Za-z0-9_.:-]+$/.test(t))) return t;
    }
  }
  const first = cells[0]?.text;
  if (first && KNOWN_KEY_PREFIX.test(first)) return first;
  const m = capture?.url ? null : null;
  return pageEntity?.key ?? null;
}

function embeddedRowKey(rowArr, headerLabels, table, pageEntity, capture) {
  for (const raw of rowArr) {
    const m = String(raw).match(ENTITY_HREF);
    if (m) return m[1];
  }
  for (const [i, label] of headerLabels.entries()) {
    if (KEY_HEADER_LABELS.has(String(label ?? "").toLowerCase())) {
      const t = htmlToText(String(rowArr[i] ?? ""));
      if (t) return t;
    }
  }
  const first = htmlToText(String(rowArr[0] ?? ""));
  if (first && KNOWN_KEY_PREFIX.test(first)) return first;
  return pageEntity?.key ?? null;
}

/** A DataTables source cell is an HTML fragment: pull out text, href and the `title` attr (raw value). */
export function parseEmbeddedCell(raw) {
  const s = String(raw ?? "");
  const titleM = s.match(/title=['"]([^'"]*)['"]/);
  const hrefM = s.match(/href=['"]([^'"]*)['"]/);
  return { text: htmlToText(s), href: hrefM ? hrefM[1] : null, title: titleM ? titleM[1] : null };
}

export function newCaptureSink({ mode, fixtureDir, scenarioId, log = () => {} }) {
  return {
    mode,
    dir: fixtureDir && scenarioId ? path.join(fixtureDir, scenarioId, "legacy") : null,
    record(pageId, html, meta) {
      if (mode !== "record") return;
      recordLegacyHtml(fixtureDir, scenarioId, pageId, html, meta);
      log(`recorded legacy html ${pageId} (${html.length} bytes)`);
    },
  };
}

export function uniqRecords(recs) {
  const seen = new Map();
  for (const r of recs) {
    const k = `${r.key}\u0000${r.label}\u0000${r.kind}\u0000${r.columnIndex}\u0000${r.source}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

export function recordRoutes(recs) {
  return uniq(recs.map((r) => `${r.tableId ?? "-"}#${r.columnIndex ?? "-"}:${r.label ?? "-"}`));
}

export { resolveRoute };
