#!/usr/bin/env bun
// burrow parity harness — the acceptance gate.
//
//   bun run parity                       # live cluster: P1 + P2 (+P3 when the backend is up)
//   bun run parity --record fixtures/parity/live
//   bun run parity --fixtures fixtures/parity/live --assert-no-network
//
// Modes
//   live    Playwright + HTTP against the real cluster; nothing is written unless --record/--keep
//   record  live + write everything needed to replay (scenario, upstream JSON, legacy HTML, SPA DOM)
//   replay  no network at all: comparison runs from recorded upstream JSON / HTML / DOM dumps
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadInventory, routeAlternatives, routeTokens, paramAlias, entityOf } from "./lib/inventory.mjs";
import { createUpstream, installNetworkGuard, writeJson, slug, scenarioDir } from "./lib/sources.mjs";
import {
  loadScenarioDefs,
  loadEndpoints,
  deriveLive,
  resolveScenario,
  writeScenario,
  readScenario,
  listRecordedScenarios,
} from "./lib/scenarios.mjs";
import {
  createBrowser,
  captureLive,
  captureFromHtml,
  toRecords,
  recordLegacyHtml,
  legacyHtmlPath,
  pageEntityOf,
} from "./lib/legacy.mjs";
import { captureOursLive, captureOursFromHtml, dumpOurs, oursDomPath, probeBase } from "./lib/ours.mjs";
import { compareScenario, itemResourceTarget, effectiveRestField, evalWhen, isNonHtmlContentType } from "./lib/compare.mjs";
import { summarise, writeReport, FAIL_ON } from "./lib/report.mjs";
import { runCoverage } from "./coverage.mjs";
import { runWire } from "./wire.mjs";

/* ------------------------------------------------------------------ config */

export function loadRoutesConfig(repoRoot, file) {
  const p = file ?? path.join(repoRoot, "parity", "harness", "config", "routes.yaml");
  if (!fs.existsSync(p)) return { rules: [], legacyRoutes: {}, file: null };
  const doc = YAML.parse(fs.readFileSync(p, "utf8")) ?? {};
  const tolPath = path.join(repoRoot, "parity", "harness", "config", "tolerances.yaml");
  const tolerances = fs.existsSync(tolPath) ? (YAML.parse(fs.readFileSync(tolPath, "utf8"))?.tolerances ?? {}) : {};
  for (const [id, t] of Object.entries(tolerances)) {
    if (!t?.reason) console.warn(`WARNING: tolerance for ${id} has no reason; add one in config/tolerances.yaml`);
  }
  return {
    rules: doc.rules ?? [],
    legacyRoutes: doc.legacyRoutes ?? {},
    includePages: doc.includePages ?? ["^legacy\\."],
    excludePages: doc.excludePages ?? [],
    chromeSections: doc.chromeSections ?? [],
    sharedSections: doc.sharedSections ?? [],
    fieldAliases: doc.fieldAliases ?? {},
    normaliserOverrides: doc.normaliserOverrides ?? {},
    tolerances,
    file: p,
  };
}

/** Capture one SPA route (live or from the recorded DOM dump). */
async function captureOneOurs({ mode, fixtureDir, recordDir, scenario, browser, oursBase, r, log }) {
  if (mode === "replay") {
    const html = fs.existsSync(oursDomPath(fixtureDir, scenario.id, r.key))
      ? fs.readFileSync(oursDomPath(fixtureDir, scenario.id, r.key), "utf8")
      : null;
    if (!html) return { routeKey: r.key, error: "no recorded DOM", datums: [], entities: [] };
    return captureOursFromHtml(browser, { html, routeKey: r.key, url: new URL(r.key, oursBase).toString() });
  }
  const cap = await captureOursLive(browser, { baseUrl: oursBase, routeKey: r.key });
  if (mode === "record") dumpOurs(recordDir, scenario.id, r.key, cap);
  return cap;
}

/** Which inventory pages are outside P2 scope (config includePages/excludePages). */
export function isNonHtmlType(contentType) {
  if (!contentType) return false;
  return !/text\/html/i.test(contentType);
}

export function pageInScope(pageId, config) {
  const inc = (config.includePages ?? []).some((r) => new RegExp(r).test(pageId));
  if (!inc) return false;
  return !(config.excludePages ?? []).some((r) => new RegExp(r).test(pageId));
}

export function applyRouteTokens(tpl, params) {
  if (!tpl) return null;
  let out = tpl;
  for (const t of routeTokens(tpl)) {
    const alias = paramAlias(t);
    const v = params[alias];
    if (alias === "state" && (v == null || v === "" || String(v).toUpperCase() === "ALL")) {
      out = out.replace(new RegExp(`/?\\{${escapeRe(t)}\\}`), "");
      continue;
    }
    if (v == null || v === "") return null;
    out = out.replace(`{${t}}`, String(v));
  }
  if (routeTokens(out).length) return null;
  if (/\/\//.test(out)) return null;
  if (out.endsWith("/") && !String(tpl).endsWith("/")) return null;
  return out || "/";
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function pickLegacyRoute(page, params, config) {
  const override = config.legacyRoutes?.[page.id];
  if (override) return applyRouteTokens(override, params);
  const alts = routeAlternatives(page.route).filter((a) => !/[()]/.test(a));
  const scored = alts.map((a, i) => ({ a, i, tokens: routeTokens(a).length })).sort((x, y) => y.tokens - x.tokens || x.i - y.i);
  for (const { a } of scored) {
    const r = applyRouteTokens(a, params);
    if (r) return r;
  }
  return null;
}

/* ------------------------------------------------------------------ main */

export async function runParity(argv = {}, hooks = {}) {
  const log = argv.quiet ? () => {} : (s) => console.log(s);
  const repoRoot = path.resolve(argv.repoRoot ?? path.join(import.meta.dirname, "..", ".."));
  // CLI paths are documented as repo-root relative; relative paths must not depend on cwd
  const fromRoot = (p) => (p ? path.resolve(repoRoot, String(p)) : null);
  const stages = argv.stages ? String(argv.stages).split(",").map((s) => s.trim().toLowerCase()) : ["p1", "p2", "p3"];
  const reportDir = fromRoot(argv.report ?? "parity/report");
  const fixtureDir = argv.fixtures ? fromRoot(argv.fixtures) : null;
  const recordDir = argv.record ? fromRoot(argv.record) : null;
  const mode = fixtureDir ? "replay" : recordDir ? "record" : "live";
  const scenarioFilter = argv.scenario ? String(argv.scenario).split(",").map((s) => s.trim()) : null;

  const config = loadRoutesConfig(repoRoot, argv.routes ? String(argv.routes) : undefined);
  const inventory = loadInventory(repoRoot, { strict: !!argv.strictInventory });
  // Capture-phase safeguards (a slow/loaded cluster must never abort the gate): a whole-phase budget,
  // per-capture skip-and-record, and optional reuse of this scenario's already-captured sides.
  const captureBudgetMs = Number(argv.captureTimeout ?? 900) * 1000;
  const captureDeadline = Date.now() + captureBudgetMs;
  const captureExpired = () => Date.now() > captureDeadline;
  const skippedCaptures = [];
  const reuseCaptures = !!argv.reuseCaptures && !argv.refresh;
  const reuseJson = (p) => {
    try {
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
    } catch {
      return null;
    }
  };
  /** Where a dumped capture lives: `--keep-captures`/`--record` write here, `--reuse-captures` reads here. */
  const reusePath = (scenarioId, file) => path.join(reportDir, "raw", scenarioId, file);
  // The differential gate compares the legacy Hamlet UI (PLAN.md §8 P2 baseline) against our SPA.
  // ui2.yaml is a *secondary inventory source* (P0) and is deliberately out of P2 scope; any page
  // filtered here is reported in summary.json under `scopeExcluded`, never silently dropped.
  const scopeExcluded = inventory.pages.filter((p) => p.standalone && !pageInScope(p.id, config)).map((p) => p.id);
  const p2Pages = inventory.pages.filter((p) => p.standalone && pageInScope(p.id, config));
  const outOfScope = new Map();
  for (const page of inventory.pages) {
    if (!page.standalone) continue;
    const r = oursRouteFor(page, {}, { rules: config.rules });
    const rule = (config.rules ?? []).find((x) => {
      try {
        return new RegExp(x.match).test(page.id);
      } catch {
        return false;
      }
    });
    if (rule && rule.ours == null && rule.outOfScope) outOfScope.set(page.id, rule.outOfScope);
  }
  log(
    `inventory: ${inventory.pages.filter((p) => p.standalone).length} standalone pages, ${inventory.fields.size} fields ` +
      `(sources: ${inventory.pageFiles.join(", ")}${inventory.registryFile ? `, ${inventory.registryFile}` : ", registry NOT built"})`
  );
  if (inventory.issues.length && !argv.quiet) {
    log(`inventory issues: ${inventory.issues.length} (see report)`);
  }

  const endpoints = loadEndpoints(repoRoot);
  const legacyBase = argv.legacyUrl ?? endpoints?.rm?.webapp ?? "http://127.0.0.1:8088";
  let oursBase = argv.ours ?? "http://127.0.0.1:8787";
  let staticServer = null;
  if (argv.oursServe && mode !== "replay") {
    const { createStaticServer } = await import("./lib/static-server.mjs");
    staticServer = createStaticServer({
      root: path.resolve(repoRoot, argv.oursServe === true ? "web/dist/client" : String(argv.oursServe)),
      rm: legacyBase,
      shs: endpoints?.sparkHistory?.webapp,
      nm: [],
      port: Number(argv.oursPort ?? 8899),
      log,
    });
    oursBase = `http://127.0.0.1:${staticServer.port}`;
  }
  const oursReach = mode === "replay" ? { reachable: true } : await probeBase(oursBase);
  if (!oursReach.reachable && mode !== "replay") {
    const fallback = argv.oursFallback ?? "http://127.0.0.1:5173";
    const fbReach = await probeBase(fallback);
    if (fbReach.reachable) {
      log(`burrow backend not up at ${oursBase}; using SPA dev server at ${fallback}`);
      oursBase = fallback;
    } else {
      log(`WARNING: neither ${oursBase} nor ${fallback} is reachable — every site item will be legacy-only`);
    }
  }

  // ---------------- scenario planning
  const defs = loadScenarioDefs(path.join(repoRoot, "parity", "harness", "scenarios")).filter(
    (d) => !scenarioFilter || scenarioFilter.includes(d.id)
  );
  let planned = [];
  if (mode === "replay") {
    const recorded = listRecordedScenarios(fixtureDir);
    // Recording writes shared wire captures under the first declared scenario.
    // Replay must therefore use scenario definition order, not directory order.
    const definedIds = defs.map((d) => d.id);
    const ids = scenarioFilter ?? [
      ...definedIds.filter((id) => recorded.includes(id)),
      ...recorded.filter((id) => !definedIds.includes(id)),
    ];
    if (!ids.length) throw new Error(`replay: no recorded scenarios under ${fixtureDir}`);
    for (const id of ids) {
      const p = path.join(fixtureDir, id, "scenario.json");
      if (!fs.existsSync(p)) throw new Error(`replay: ${p} missing`);
      const s = readScenario(fixtureDir, id);
      s.nodeBases = endpoints?.nodeManagers ?? s.nodeBases ?? [];
      s.repoRoot = repoRoot;
      planned.push(s);
    }
  } else {
    const derivUpstream = await createUpstream({ mode: "live", log: () => {} });
    const rmBase = argv.rm ?? endpoints?.rm?.webapp ?? "http://127.0.0.1:8088";
    const derived = await deriveLive(derivUpstream, rmBase);
    if (derived.notes.length) log(`live derivation notes: ${derived.notes.join(" | ")}`);
    const effective = defs.length ? defs : [{ id: "live", description: "auto", params: { appId: "auto", attemptId: "auto", containerId: "auto", nodeId: "auto", queue: "auto", state: "auto" } }];
    for (const d of effective) {
      const s = resolveScenario(d, { derived, endpoints, repoRoot });
      s.nodeBases = endpoints?.nodeManagers ?? [];
      s.oursBase = oursBase;
      s.legacyBase = legacyBase;
      planned.push(s);
    }
  }
  log(`scenarios: ${planned.map((s) => s.id).join(", ")} (mode=${mode})`);

  // ---------------- browser
  const browser = await createBrowser({ headless: argv.headless !== false });
  const release =
    argv.assertNoNetwork && mode === "replay"
      ? installNetworkGuard((u) => log(`NETWORK GUARD: blocked ${u}`))
      : () => {};

  const compareByScenario = {};
  const rawLinks = [];
  const capturedRest = new Map();

  try {
    for (const scenario of planned) {
      const upstream = await createUpstream({
        mode,
        fixtureDir: fixtureDir ?? recordDir,
        scenarioId: scenario.id,
        timeoutMs: Number(argv.timeout ?? 20000),
        log,
      });
      if (mode === "record") {
        scenario.repoRoot = repoRoot;
        writeScenario(recordDir, scenario);
      }
      const dir = scenarioDir(fixtureDir ?? recordDir ?? "", scenario.id);
      if (scenario.derivedNotes?.length) log(`[${scenario.id}] derivation notes: ${scenario.derivedNotes.join(" | ")}`);

      // ---- 1. reference REST values for every inventory item that has a rest.path
      const restByUrl = new Map();
      if (stages.includes("p2") || stages.includes("p1")) {
        const wanted = new Set();
        for (const page of p2Pages) {
          for (const sec of page.sections) {
            for (const it of sec.items) {
              const f = effectiveRestField(inventory.fields.get(it.field), it);
              const t = f && itemResourceTarget(inventory, f, scenario);
              if (t?.path && !t.path.includes("{")) wanted.add(`${(scenario.rmBase ?? "").replace(/\/+$/, "")}${t.path}`);
            }
          }
        }
        for (const url of [...wanted].sort()) {
          let r = capturedRest.get(url);
          if (r === undefined) {
            try {
              r = await upstream.get(url, { headers: { "Cache-Control": "no-cache" } });
            } catch (e) {
              r = { status: 0, error: String(e?.message ?? e) };
            }
            capturedRest.set(url, r);
            if (mode === "record") writeJson(path.join(dir, "rest", `${slug(url)}.json`), { url, status: r.status, json: r.json ?? null });
          }
          restByUrl.set(url, r?.json ?? undefined);
        }
        log(`[${scenario.id}] reference REST: ${restByUrl.size} resources`);
      }

      const oursByRoute = new Map();
      const captured = new Map();
      // One SPA route capture (shared by the per-page interleaving below and the completeness sweep in step 3).
      const captureRoute = async (r) => {
          if (captureExpired()) {
            const reason = `--capture-timeout ${captureBudgetMs / 1000}s exhausted before this route`;
            log(`[${scenario.id}] ours ${r.key}: not captured (${reason})`);
            skippedCaptures.push({ route: r.key, kind: "ours", reason });
            oursByRoute.set(r.key, { routeKey: r.key, datums: [], entities: [], error: reason, notCaptured: true });
            return;
          }
          let cap;
          if (reuseCaptures) {
            const reused = reuseJson(reusePath(scenario.id, `ours-${slug(r.key)}.json`));
            if (reused) {
              cap = { ...reused, reused: true };
              oursByRoute.set(r.key, cap);
              log(`[${scenario.id}] ours ${cap.routeKey}: reused ${cap.datums?.length ?? 0} datums`);
              return;
            }
          }
          try {
            cap = await captureOneOurs({ mode, fixtureDir, recordDir, scenario, browser, oursBase, r, log });
          } catch (e) {
            const reason = `capture failed: ${String(e?.message ?? e).slice(0, 160)}`;
            log(`[${scenario.id}] ours ${r.key}: not captured (${reason})`);
            skippedCaptures.push({ route: r.key, kind: "ours", reason });
            cap = { routeKey: r.key, datums: [], entities: [], error: reason, notCaptured: true };
          }
          // parity on a filtered/param'd route can legitimately render nothing (e.g. a state facet
          // with no rows, or a param the SPA spells differently): retry the bare path before
          // concluding that the field is missing from our UI.
          if (mode !== "replay" && !(cap.datums ?? []).length && r.key.includes("?")) {
            const bare = { ...r, key: r.path };
            const alt = await captureOneOurs({ mode, fixtureDir, recordDir, scenario, browser, oursBase, r: bare, log });
            if ((alt.datums ?? []).length) {
              log(`[${scenario.id}] ours ${r.key}: 0 datums, using ${bare.key} instead (${alt.datums.length} datums)`);
              cap = alt;
            }
          }
          captured.set(r.key, cap);
          oursByRoute.set(r.key, cap);
          log(
            `[${scenario.id}] ours ${cap.routeKey}: ${cap.datums?.length ?? 0} datums` + (cap.error ? ` (error: ${String(cap.error).slice(0, 90)})` : "")
          );
          if (argv.keepCaptures || mode === "record") {
            writeJson(path.join(reportDir, "raw", scenario.id, `ours-${slug(cap.routeKey)}.json`), {
              routeKey: cap.routeKey,
              url: cap.url,
              error: cap.error ?? null,
              datums: cap.datums ?? [],
              entities: cap.entities ?? [],
            });
            rawLinks.push({ label: `ours datums ${scenario.id}/${cap.routeKey}`, href: `raw/${scenario.id}/ours-${slug(cap.routeKey)}.json` });
          }
      };

      // Capture the SPA routes of a page right after its legacy capture: legacy and ours are then seconds apart instead of
      // a whole crawl phase apart, which is what turns a live counter / state into a spurious mismatch.
      const captureOursForPage = async (page) => {
        if (scenario.pages && !scenario.pages.includes(page.id)) return;
        if (evalWhen(page.when, { facts: scenario.facts }).gated) return;
        const r = oursRouteFor(page, scenario.params, config);
        if (!r) return;
        for (const k of r.keys) if (!oursByRoute.has(k)) await captureRoute({ ...r, key: k });
      };

      // ---- 2. legacy captures
      const legacyByPage = new Map();
      if (stages.includes("p2")) {
        for (const page of p2Pages) {
          if (scenario.pages && !scenario.pages.includes(page.id)) continue;
          if (evalWhen(page.when, { facts: scenario.facts }).gated) {
            log(`[${scenario.id}] ${page.id}: skipped (page when: ${page.when.join(", ")})`);
            legacyByPage.set(page.id, { capture: null, records: [], route: null, error: "page when not satisfied" });
            continue;
          }
          const route = pickLegacyRoute(page, scenario.params, config);
          const routeWithQuery = route && scenario.legacyQuery ? `${route}${route.includes("?") ? "&" : "?"}${scenario.legacyQuery}` : route;
          if (!route) {
            log(`[${scenario.id}] ${page.id}: no resolvable legacy route (params: ${JSON.stringify(scenario.params)})`);
            legacyByPage.set(page.id, { capture: null, records: [], route: null, error: "unresolvable route" });
            continue;
          }
          if (captureExpired()) {
            const reason = `--capture-timeout ${captureBudgetMs / 1000}s exhausted before this page`;
            log(`[${scenario.id}] legacy ${page.id}: not captured (${reason})`);
            skippedCaptures.push({ page: page.id, kind: "legacy", reason });
            legacyByPage.set(page.id, { capture: null, records: [], route: null, error: reason });
            continue;
          }
          let cap = null;
          const pageEntity = pageEntityOf(page.route, scenario.params);
          if (reuseCaptures) {
            // preferred: re-extract from the dumped post-JS DOM with the *current* toRecords, so extraction/key
            // fixes apply with no RM load; fall back to the already-flattened records.json
            const rawHtmlFile = reusePath(scenario.id, `${slug(page.id)}.legacy.html`);
            if (fs.existsSync(rawHtmlFile)) {
              cap = await captureFromHtml(browser, {
                html: fs.readFileSync(rawHtmlFile, "utf8"),
                url: new URL(routeWithQuery, legacyBase).toString(),
                pageId: page.id,
                routePath: route,
              });
              cap.reused = true;
            } else {
              const reused = reuseJson(reusePath(scenario.id, `${slug(page.id)}.records.json`));
              if (reused) {
                legacyByPage.set(page.id, { capture: null, records: reused, route: routeWithQuery, pageEntity, reused: true });
                log(`[${scenario.id}] legacy ${page.id}: reused ${reused.length} records (no raw html; keys not re-derived)`);
                continue;
              }
            }
          }
          if (cap) {
            /* already re-extracted from the dumped DOM */
          } else if (mode === "replay") {
            const html = fs.existsSync(legacyHtmlPath(fixtureDir, scenario.id, page.id))
              ? fs.readFileSync(legacyHtmlPath(fixtureDir, scenario.id, page.id), "utf8")
              : null;
            if (!html) {
              log(`[${scenario.id}] replay miss: no recorded legacy html for ${page.id}`);
              legacyByPage.set(page.id, { capture: null, records: [], route, error: "no recorded html" });
              continue;
            }
            cap = await captureFromHtml(browser, {
              html,
              url: new URL(routeWithQuery, legacyBase).toString(),
              pageId: page.id,
              routePath: route,
            });
          } else {
            try {
              cap = await captureLive(browser, { baseUrl: legacyBase, routePath: routeWithQuery, pageId: page.id, expectRows: expectRowsFor(page, scenario) });
            } catch (e) {
              const reason = `capture failed: ${String(e?.message ?? e).slice(0, 160)}`;
              log(`[${scenario.id}] legacy ${page.id}: not captured (${reason})`);
              skippedCaptures.push({ page: page.id, kind: "legacy", reason });
              legacyByPage.set(page.id, { capture: null, records: [], route: routeWithQuery, error: reason });
              continue;
            }
            if (mode === "record") {
              recordLegacyHtml(recordDir, scenario.id, page.id, cap.html ?? "", {
                pageId: page.id,
                route: routeWithQuery,
                url: cap.url,
                httpStatus: cap.httpStatus,
                navError: cap.navError ?? null,
                capturedAt: new Date().toISOString(),
              });
            }
          }
          const records = toRecords(cap.capture ?? {}, { pageId: page.id, routePath: route, params: scenario.params, pageEntity });
          legacyByPage.set(page.id, { ...cap, records, route: routeWithQuery, pageEntity });
          log(`[${scenario.id}] legacy ${page.id} ${routeWithQuery}: ${records.length} records${cap.navError ? ` (navError: ${cap.navError})` : ""}`);
          if (stages.includes("p2")) await captureOursForPage(page);
          if (argv.keepCaptures || mode === "record") {
            writeJson(path.join(reportDir, "raw", scenario.id, `${slug(page.id)}.records.json`), records);
            rawLinks.push({ label: `legacy records ${scenario.id}/${page.id}`, href: `raw/${scenario.id}/${slug(page.id)}.records.json` });
            if (cap.html) {
              const rel = `raw/${scenario.id}/${slug(page.id)}.legacy.html`;
              fs.mkdirSync(path.dirname(path.join(reportDir, rel)), { recursive: true });
              fs.writeFileSync(path.join(reportDir, rel), cap.html);
              rawLinks.push({ label: `legacy DOM ${scenario.id}/${page.id}`, href: rel });
            }
          }
        }
      }

      // ---- 3. our UI captures (a page may map to several SPA routes: crawl and merge them all)
      if (stages.includes("p2") || stages.includes("p1")) {
        const routeKeys = new Map();
        for (const page of p2Pages) {
          if (scenario.pages && !scenario.pages.includes(page.id)) continue; // same page filter as the legacy crawl
          if (evalWhen(page.when, { facts: scenario.facts }).gated) continue;
          const r = oursRouteFor(page, scenario.params, config);
          if (!r) continue;
          for (const k of r.keys) if (!routeKeys.has(k)) routeKeys.set(k, { ...r, key: k });
        }
        for (const r of routeKeys.values()) if (!oursByRoute.has(r.key)) await captureRoute(r);
        // merge the per-page route captures so the comparison sees one datum map per page
        for (const page of p2Pages) {
          const r = oursRouteFor(page, scenario.params, config);
          if (!r) continue;
          const primary = oursByRoute.get(r.key) ?? { datums: [], entities: [], error: "not captured" };
          const extra = r.keys
            .filter((k) => k !== r.key)
            .map((k) => oursByRoute.get(k))
            .filter((c) => c && (c.datums ?? []).length);
          if (extra.length) {
            const merged = {
              ...primary,
              datums: [...(primary.datums ?? []), ...extra.flatMap((c) => c.datums ?? [])],
              entities: [...new Set([...(primary.entities ?? []), ...extra.flatMap((c) => c.entities ?? [])])],
              mergedRoutes: [primary.routeKey ?? r.key, ...extra.map((c) => c.routeKey)],
            };
            oursByRoute.set(r.key, merged);
            log(`[${scenario.id}] ours ${r.key}: merged ${extra.length} sibling route(s) -> ${merged.datums.length} datums`);
          }
        }
      }

      // ---- 3b. refresh the reference REST bodies so metrics are sampled as late as the DOM
      // (volatile cluster metrics otherwise disagree purely because the cluster moved on)
      if (stages.includes("p2") && !argv.noRefreshReference && restByUrl.size) {
        let refreshed = 0;
        for (const url of [...restByUrl.keys()]) {
          try {
            const r = await upstream.get(url, { headers: { "Cache-Control": "no-cache" } });
            restByUrl.set(url, r?.json ?? undefined);
            refreshed++;
          } catch {
            /* keep the earlier sample */
          }
        }
        log(`[${scenario.id}] refreshed ${refreshed}/${restByUrl.size} reference REST bodies after the captures`);
      }

      // ---- 4. compare
      if (stages.includes("p2")) {
        const res = compareScenario({
          inventory,
          scenario,
          legacyByPage,
          oursByRoute,
          restByUrl,
          routes: config,
          outOfScope,
          resolveOurs: oursRouteFor,
          config,
          log,
        });
        compareByScenario[scenario.id] = res;
        log(`[${scenario.id}] compare: ${JSON.stringify(res.totals)}`);
      }

      // ---- 5. P1 coverage (once, on the first scenario that has captures)
      if (stages.includes("p1") && !compareByScenario._coverage) {
        const coverage = await runCoverage({
          repoRoot,
          inventory,
          scenario,
          upstream,
          reportDir,
          oursCaptures: [...oursByRoute.values()],
          config,
          outOfScope,
          pageIdsInScope: new Set(p2Pages.map((p) => p.id)),
          gatedPages: new Set(p2Pages.filter((p) => evalWhen(p.when, { facts: scenario.facts }).gated).map((p) => p.id)),
          nonHtmlPages: new Set([...legacyByPage].filter(([, c]) => isNonHtmlContentType(c?.contentType)).map(([id]) => id)),
          log,
        });
        compareByScenario._coverage = coverage;
      }

      // ---- 6. P3 wire fidelity (once, needs the backend)
      if (stages.includes("p3") && !compareByScenario._wire) {
        const reach = mode === "replay" ? { reachable: true } : await probeBase(oursBase);
        if (!reach.reachable && mode !== "replay") {
          compareByScenario._wire = {
            status: "skipped",
            reason: `burrow backend not reachable at ${oursBase} (pass --ours or start the binary)`,
            compared: 0,
            mismatches: [],
            skipped: [],
          };
          log("P3 wire: skipped (backend not reachable)");
        } else {
          scenario.oursBase = oursBase;
          const direct = await createUpstream({ mode, fixtureDir: fixtureDir ?? recordDir, scenarioId: scenario.id, label: "wire-direct", log });
          const ours = await createUpstream({ mode, fixtureDir: fixtureDir ?? recordDir, scenarioId: scenario.id, label: "wire-ours", log });
          const wire = await runWire({ repoRoot, scenario, direct, ours, inventory, oursCaptures: [...oursByRoute.values()], reportDir, log });
          if (mode === "record") {
            direct.flush();
            ours.flush();
          }
          compareByScenario._wire = wire;
        }
      }

      if (mode === "record") {
        const n = upstream.flush();
        log(`[${scenario.id}] recorded ${n} upstream responses to ${path.relative(repoRoot, scenarioDir(recordDir, scenario.id))}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    if (staticServer) staticServer.stop(true);
    release();
  }

  const coverage = compareByScenario._coverage ?? null;
  const wire = compareByScenario._wire ?? null;
  delete compareByScenario._coverage;
  delete compareByScenario._wire;

  const meta = {
    mode,
    replayDir: fixtureDir ? path.relative(repoRoot, fixtureDir) : null,
    recordDir: recordDir ? path.relative(repoRoot, recordDir) : null,
    rmBase: legacyBase,
    legacyBase,
    oursBase,
    inventoryFiles: [...inventory.pageFiles, inventory.registryFile].filter(Boolean).map((f) => path.basename(f)),
    scopeExcluded,
    skippedCaptures,
    strictNotObservable: !!argv.strictNotObservable,
    pageScope: { include: config.includePages, exclude: config.excludePages },
    scenarios: planned.map((s) => ({ id: s.id, params: s.params, legacyBase, oursBase })),
    rawLinks,
    stages,
  };
  const summary = summarise({ compareByScenario, coverage, wire, inventory, meta });
  if (stages.includes("p1") && coverage) {
    // P1's own failures are part of the gate
    summary.gate = summary.gate === "pass" && !coverage.unknownKeys.length && !coverage.unrenderedRequired.length ? "pass" : "fail";
    summary.exitCode = summary.gate === "pass" ? 0 : 1;
  }
  const written = writeReport({ reportDir, summary, compareByScenario, coverage, wire, meta });
  log(`report: ${written.index}`);
  log(`summary: ${written.summary}`);
  log(
    `GATE ${summary.gate.toUpperCase()} — totals ${JSON.stringify(summary.totals)} failures ${summary.failing.length} ` +
      `inventoryIssues ${summary.inventoryIssues.length}` +
      (coverage ? ` unknownKeys ${coverage.unknownKeys.length} unrenderedRequired ${coverage.unrenderedRequired.length}` : "") +
      (wire ? ` wire ${wire.status}` : "")
  );
  return { summary, compareByScenario, coverage, wire, meta, reportDir, written };
}

function expectRowsFor(page, scenario) {
  // make the DataTables wait deterministic: apps -> number of apps on the cluster, nodes -> node count
  if (/apps$/.test(page.id)) return Math.min(Number(scenario.facts?.appCount ?? 1), 5);
  if (/nodes$/.test(page.id)) return Math.min(Number(scenario.facts?.nodeCount ?? 1), 5);
  return 0;
}
export function oursRouteFor(page, params, config) {
  const rule = (config.rules ?? []).find((r) => {
    try {
      return new RegExp(r.match).test(page.id);
    } catch {
      return false;
    }
  });
  if (!rule || rule.ours == null) return null;
  // a legacy page may be split across several SPA routes (tabs): `ours` may be a list; we crawl
  // every route and merge the datum maps, so "the data is rendered" counts even when it lives on a
  // sibling tab rather than the legacy page's own route.
  const templates = Array.isArray(rule.ours) ? rule.ours : [rule.ours];
  const unlessHit = (rule.queryUnless ?? []).some((u) => {
    const [k, v] = String(u).split("=");
    return String(params[paramAlias(k)] ?? "") === v;
  });
  const query = unlessHit
    ? []
    : (rule.query ?? []).filter((frag) => {
        const f = frag.replace(/\{([^}]+)\}/g, (_, t) => params[paramAlias(t)] ?? "");
        return !f.includes("{") && !/=$/.test(f) && !/=ALL$/.test(f);
      });
  const keys = [];
  for (const tpl of templates) {
    const effParams =
      String(tpl).includes("{containerId}") && params.containerAppId ? { ...params, appId: params.containerAppId } : params;
    let p = String(tpl).replace(/\{([^}]+)\}/g, (_, t) => effParams[paramAlias(t)] ?? effParams[t] ?? "");
    if (/\{/.test(p) || /\/\//.test(p) || (p.endsWith("/") && !String(tpl).endsWith("/"))) continue;
    keys.push(query.length ? `${p}?${query.join("&")}` : p);
  }
  if (!keys.length) return null;
  return { key: keys[0], keys, path: keys[0].split("?")[0], query, pageId: page.id, outOfScope: rule.outOfScope ?? null };
}

/* ------------------------------------------------------------------ CLI */

export function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, vInline] = a.slice(2).split("=");
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (vInline !== undefined) out[key] = vInline;
    else if (args[i + 1] && !args[i + 1].startsWith("--")) out[key] = args[++i];
    else out[key] = true;
  }
  return out;
}

if (import.meta.main) {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help) {
    console.log(`burrow parity harness

  bun run parity [options]

  --rm URL            legacy RM webapp (default from .cluster/endpoints.json)
  --ours URL          our SPA base (default http://127.0.0.1:8787, falls back to :5173)
  --legacy-url URL    legacy UI base (same as --rm)
  --scenario a,b      scenario ids from parity/harness/scenarios/*.yaml
  --stages p1,p2,p3   which proofs to run (default p1,p2,p3)
  --record DIR        run live and write fixtures to DIR
  --fixtures DIR      replay from DIR with no network
  --assert-no-network hard-fail the run if any live fetch is attempted (replay)
  --report DIR        report output directory (default parity/report)
  --keep-captures     also dump legacy/ours captures under the report dir in live mode
  --strict-inventory  treat incomplete inventory as fatal
  --strict-not-observable  also fail on justified not-observable items
  --capture-timeout N whole-capture-phase budget in seconds (default 900); routes not reached are
                      recorded as "not-captured", never silently absent
  --reuse-captures    reuse this scenario's already-dumped captures (report/raw/<scenario>/…) instead
                      of re-crawling; --refresh overrides
  --refresh           always re-crawl, ignoring any dumped captures
  --list              print inventory pages, their resolved routes and scope, then exit
  --quiet             less logging
`);
    process.exit(0);
  }
  if (argv.list) {
    const repoRoot = path.resolve(argv.repoRoot ?? path.join(import.meta.dirname, "..", ".."));
    const inv = loadInventory(repoRoot, { strict: false });
    const config = loadRoutesConfig(repoRoot, argv.routes ? String(argv.routes) : undefined);
    const defs = loadScenarioDefs(path.join(repoRoot, "parity", "harness", "scenarios"));
    console.log(`inventory sources: ${[...inv.pageFiles, inv.registryFile].filter(Boolean).join(", ")}`);
    console.log(`pages: ${inv.pages.length} (${inv.pages.filter((p) => p.standalone).length} standalone), fields: ${inv.fields.size}`);
    console.log(`scenarios: ${defs.map((d) => d.id).join(", ") || "(none)"}`);
    console.log("");
    for (const p of inv.pages) {
      const inScope = pageInScope(p.id, config);
      const ours = p.standalone ? oursRouteFor(p, { appId: "APP", attemptId: "ATTEMPT", containerId: "CONT", nodeId: "NODE", queue: "Q", state: "RUNNING" }, config) : null;
      const rule = (config.rules ?? []).find((r) => {
        try {
          return new RegExp(r.match).test(p.id);
        } catch {
          return false;
        }
      });
      const items = p.sections.reduce((a, s) => a + s.items.length, 0);
      console.log(
        `${p.standalone ? " " : "·"} ${p.id.padEnd(38)} ${String(inScope ? "" : "OUT-OF-SCOPE ").padEnd(12)}` +
          `legacy=${String(p.route ?? "(include-only)").padEnd(42)} ours=${ours?.path ?? (rule?.outOfScope ? "(out of scope)" : "(none)")} items=${items}`
      );
    }
    process.exit(0);
  }
  const res = await runParity(argv);
  process.exitCode = res.summary.exitCode;
}
