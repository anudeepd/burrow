// Differential comparison: legacy(label→text) ↔ inventory item(field id) ↔ ours(field id→raw).
//
// Statuses (per item, and per entity when the item is repeated over a table):
//   match          both sides present and compatible after normalisation
//   mismatch       both present, incompatible
//   legacy-only    legacy shows it, ours never rendered it        (failure)
//   ours-only      rendered by ours with no legacy counterpart    (info)
//   waived         parity/waivers.yaml (or the registry) said so
//   not-observable the item's `when`/`scenario` is not satisfied in this run (justified)
//   absent         neither side showed it and nothing justifies it (counted, not silently skipped)
//   chrome-only    static-text item (nav/legend/button) ours deliberately does not reproduce
//   unmapped       the inventory gives no label to join on (harness/inventory gap)
import { canonicalise, canonicalEqual, looseEqual, looseText, parseSpec } from "./normalise.mjs";
import { entityOf, routeTokens, paramAlias, routeAlternatives, waivedByGroup } from "./inventory.mjs";
import { pageEntityOf, entityTypeOfKey, BAR_QUEUE_NAME, BAR_AUTO_CREATED, BAR_PARTITION, ROW_HIGHLIGHT } from "./legacy.mjs";
import { getPath, canonicalPath, truncate } from "./util.mjs";

export const FAILING = new Set(["mismatch", "legacy-only", "absent", "unmapped", "inventory-incomplete"]);
export const INFO = new Set(["ours-only", "chrome-only", "waived", "not-observable", "match", "not-applicable", "sampling-race", "harness-uncovered"]);

/**
 * Fields whose value is a live counter/gauge on a cluster that other processes are actively
 * driving. The stock DOM snapshot and the REST sample cannot be taken at the same instant, so a
 * numeric disagreement here is ambiguous between "the cluster moved on" and "a real bug". Those
 * disagreements are reported as `sampling-race` (counted, displayed, NOT silent) instead of
 * `mismatch`; non-numeric fields (state, user, id...) in these entities stay strict.
 */
const VOLATILE_PREFIXES = ["cluster.metrics.", "scheduler.", "queue.", "node.", "nodelabel."];
const NUMERIC_NORMALISERS = ["int", "mb", "percent", "duration", "epoch", "bytes-desc", "none"];

/**
 * Clock-derived durations of in-flight applications: Elapsed = now - startTime, so two samples taken seconds apart
 * differ by exactly that gap. Unlike the gauges above the drift is one-directional: the later sample is never
 * smaller, so a race is admitted when the later-sampled side (ours / REST) is >= the legacy value, or at most 10s below it
 * (response-stamping skew).
 */
const CLOCK_DERIVED_FIELDS = new Set(["app.elapsedTime", "attempt.derived.elapsedText", "container.elapsedTime"]);

function clockRaceOk(fieldId, legacyCanon, laterCanon) {
  if (!CLOCK_DERIVED_FIELDS.has(fieldId)) return true;
  const a = Number(legacyCanon);
  const b = Number(laterCanon);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  // later sample >= legacy is plain drift; a smaller later value is only skew of the two serialisations (the Rust backend and
  // the browser each stamp "now" when they build the response), bounded to 10s so a genuinely wrong elapsed still fails
  return b >= a || a - b <= 10_000;
}

export function isVolatileField(fieldId, normaliser) {
  if (!fieldId) return false;
  if (CLOCK_DERIVED_FIELDS.has(fieldId)) return true;
  if (!VOLATILE_PREFIXES.some((p) => fieldId.startsWith(p))) return false;
  const parts = String(normaliser ?? "none").split("+").map((s) => s.trim());
  return parts.every((p) => NUMERIC_NORMALISERS.includes(p));
}

/* ------------------------------------------------------------------ conditions */

/**
 * Evaluate one `when` condition against scenario facts.
 * Returns { ok, gate, reason }: gate=true means the condition controls visibility (unmet => not
 * observable); gate=false means it is a rendering branch (the normaliser/nullDisplay covers it) or
 * an unrecognised condition (recorded loudly, never used to skip a comparison).
 */
/**
 * Compiled-in defaults of keys that no *-default.xml declares, so /conf omits them while unset.
 * Source-grounded: CapacitySchedulerConfiguration.ENABLE_USER_METRICS / DEFAULT_ENABLE_USER_METRICS = false
 * (AbstractCSQueue.java:153 builds root QueueMetrics with enableUserMetrics from it).
 */
const CONF_JAVA_DEFAULTS = {
  "yarn.scheduler.capacity.user-metrics.enable": "false",
};

export function evalCondition(cond, ctx) {
  const s = String(cond ?? "").trim();
  if (!s) return { ok: true, gate: false, reason: "empty" };
  let m;
  if ((m = s.match(/^scheduler=(capacity|fair|fifo)$/i))) {
    const want = m[1].toLowerCase();
    const have = String(ctx.facts.scheduler ?? "").toLowerCase();
    return { ok: have === want, gate: true, reason: `scheduler=${have}` };
  }
  if ((m = s.match(/^state=([A-Z_]+)$/))) {
    const want = m[1];
    const have = ctx.facts.states ?? [];
    return { ok: have.includes(want), gate: true, reason: `states=${have.join(",") || "(none)"}` };
  }
  if ((m = s.match(/^conf:([^=]+)=(.*)$/))) {
    const raw = ctx.facts.conf?.[m[1]];
    // an unset key means the compiled-in default, not "no value": the RM's /conf lists only keys that are set
    // in a *-site.xml or have a default in a loaded *-default.xml, so defaults declared only in Java are listed here
    const have = raw ?? CONF_JAVA_DEFAULTS[m[1]];
    return { ok: String(have ?? "") === m[2], gate: true, reason: `conf ${m[1]}=${have ?? "(unset)"}${raw === undefined && have !== undefined ? " (Java default)" : ""}` };
  }
  if (s === "labels") return { ok: !!ctx.facts.labels, gate: true, reason: `labels=${!!ctx.facts.labels}` };
  if (s === "ha") return { ok: !!ctx.facts.ha, gate: true, reason: `ha=${!!ctx.facts.ha}` };
  if (s === "secure") return { ok: !!ctx.facts.secure, gate: true, reason: `secure=${!!ctx.facts.secure}` };
  if ((m = s.match(/^ui:(\S+)$/))) {
    const have = ctx.facts.ui?.[m[1]];
    return { ok: !!have, gate: true, reason: `ui.${m[1]}=${!!have}` };
  }
  // `fact:<name>` / `fact:<name>=<value>` / `fact:!<name>`: a boolean/string fact the harness derives from the live
  // cluster (lib/scenarios.mjs deriveLive) and persists in the scenario, so replay evaluates the same condition.
  // An underived fact is *not* a gate (loudly reported as unevaluated) so a missing derivation can never hide an item.
  if ((m = s.match(/^fact:(!?)([A-Za-z0-9_.-]+)(?:=(.*))?$/))) {
    const have = ctx.facts?.[m[2]];
    if (have === undefined) return { ok: true, gate: false, reason: `fact ${m[2]} not derived (matched both sides anyway)`, unevaluated: true };
    const truth = m[3] === undefined ? !!have && have !== "false" : String(have) === m[3];
    const ok = m[1] ? !truth : truth;
    return { ok, gate: true, reason: `fact ${m[2]}=${JSON.stringify(have)}` };
  }
  if (/^value:/.test(s)) return { ok: true, gate: false, reason: "branch condition (normaliser/nullDisplay handles it)" };
  return {
    ok: true,
    gate: false,
    reason: `unevaluated condition "${s}" (matched both sides anyway; review manually)`,
    unevaluated: true,
  };
}

export function evalWhen(conds, ctx) {
  const out = { gated: false, reasons: [], unevaluated: [] };
  for (const c of conds ?? []) {
    const r = evalCondition(c, ctx);
    if (!r.ok && r.gate) out.gated = true;
    if (r.unevaluated) out.unevaluated.push(r.reason);
    out.reasons.push(String(c) + (r.ok ? " ✓" : " ✗") + ` (${r.reason})`);
  }
  return out;
}

export function isNonHtmlContentType(contentType) {
  if (contentType == null) return false; // unknown -> treat as HTML (live captures set it)
  return !/text\/html/i.test(String(contentType));
}

/**
 * Explicit, documented tolerances (`parity/harness/config/tolerances.yaml`). Each entry must carry a
 * reason; the report shows it on the row. Nothing here is implicit.
 *   version-prefix : compare only the leading `x.y.z` version token of a composite build string
 *   pct-tolerance  : numeric values within `pct` percent of each other count as equal
 */
export function applyTolerance(tol, restCheck) {
  if (!tol?.mode) return null;
  const a = restCheck.legacyCanonical;
  const b = restCheck.restCanonical;
  if (tol.mode === "version-prefix") {
    const va = String(a ?? "").match(/^\d+\.\d+\.\d+/)?.[0] ?? null;
    const vb = String(b ?? "").match(/^\d+\.\d+\.\d+/)?.[0] ?? null;
    if (va && vb && va === vb) {
      return { ignored: true, note: `leading version token ${va} matches; trailing build/date text differs by design (${String(a).length} vs ${String(b).length} chars)` };
    }
    return { ignored: false, note: `version tokens differ (${va} vs ${vb})` };
  }
  if (tol.mode === "ignore-bracket-timestamp") {
    // a leading `[<Times.format(now)>] ` stamp that the RM regenerates on every scheduling attempt
    const strip = (x) => String(x ?? "").replace(/^\s*\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
    const sa = strip(a);
    const sb = strip(b);
    if (sa && sb && sa === sb) return { ignored: true, note: "only the leading [timestamp] differs (regenerated by the scheduler on each attempt)" };
    return { ignored: false, note: "text differs beyond the leading timestamp" };
  }
  if (tol.mode === "pct-tolerance") {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      const pct = Math.abs(nb) > 0 ? (Math.abs(na - nb) / Math.abs(nb)) * 100 : Math.abs(na - nb);
      if (pct <= Number(tol.pct ?? 5)) return { ignored: true, note: `${pct.toFixed(1)}% drift <= ${tol.pct ?? 5}% (${a} vs ${b})` };
      return { ignored: false, note: `${pct.toFixed(1)}% drift > ${tol.pct ?? 5}%` };
    }
    return { ignored: false, note: "non-numeric values" };
  }
  return null;
}

/* ------------------------------------------------------------------ rest value resolution */

const BUILTIN_RESOURCES = {
  // stopgap until parity/inventory/src/rest-rm.yaml lands; ids match the inventory's `resource:` refs
  "rm.info": { path: "/ws/v1/cluster/info", root: "clusterInfo" },
  "rm.metrics": { path: "/ws/v1/cluster/metrics", root: "clusterMetrics" },
  "rm.apps": { path: "/ws/v1/cluster/apps", root: "apps.app[]" },
  "rm.app": { path: "/ws/v1/cluster/apps/{appId}", root: "app" },
  "rm.app.attempts": { path: "/ws/v1/cluster/apps/{appId}/appattempts", root: "appAttempts.appAttempt[]" },
  "rm.attempt.containers": {
    path: "/ws/v1/cluster/apps/{appId}/appattempts/{attemptId}/containers",
    root: "containers.container[]",
  },
  "rm.nodes": { path: "/ws/v1/cluster/nodes", root: "nodes.node[]" },
  "rm.node": { path: "/ws/v1/cluster/nodes/{nodeId}", root: "node" },
  "rm.scheduler": { path: "/ws/v1/cluster/scheduler", root: null },
  "rm.cluster-user-info": { path: "/ws/v1/cluster/get-node-labels", root: null },
  "rm.get-node-labels": { path: "/ws/v1/cluster/get-node-labels", root: "nodeLabels.nodeLabel[]" },
  "rm.get-node-to-labels": { path: "/ws/v1/cluster/get-node-to-labels", root: "nodeToLabels.entry[]" },
  "rm.appstatistics": { path: "/ws/v1/cluster/appstatistics", root: "appStatInfo[]" },
};

export function resourceTarget(inventory, resourceId, scenario) {
  const fromInv = inventory.resources?.get(resourceId);
  if (fromInv?.path) {
    return { path: subst(fromInv.path, scenario.params), root: rootOfResource(inventory, resourceId), source: "inventory" };
  }
  const b = BUILTIN_RESOURCES[resourceId];
  if (b) return { path: subst(b.path, scenario.params), root: b.root, source: "builtin" };
  return null;
}

function rootOfResource(inventory, resourceId) {
  for (const f of inventory.fields.values()) {
    const r = Array.isArray(f.rest) ? f.rest.find((x) => x?.resource === resourceId) : null;
    if (r?.jsonPath) return canonicalPath(r.jsonPath).replace(/\.\*$/, "");
  }
  return null;
}

function subst(p, params) {
  return String(p).replace(/\{([^}]+)\}/g, (_, t) => params[paramAlias(t)] ?? "");
}

/**
 * Resolve the REST value for (field, entity key). Handles single objects, arrays (find the element
 * whose `id`/`name` matches the entity key) and map roots.
 */
export function resolveRestValue(inventory, field, resourceJson, entityKey) {
  if (!field || !resourceJson) return { value: undefined, how: "no-resource" };
  const paths = [];
  if (Array.isArray(field.rest)) {
    for (const r of field.rest) if (r?.jsonPath) paths.push({ resource: r.resource ?? null, path: r.jsonPath });
  } else if (typeof field.rest === "string") {
    paths.push({ resource: null, path: field.rest });
  }
  if (!paths.length) return { value: undefined, how: "no-rest-path" };
  const chosen = paths[0];
  const canon = canonicalPath(chosen.path);
  const segs = canon.split(".");
  // find the element that this entity key identifies: walk from the root, tracking arrays
  let cur = resourceJson;
  let i = 0;
  let matchedBy = "direct";
  while (i < segs.length && cur != null) {
    if (segs[i] === "*") {
      if (Array.isArray(cur)) {
        const next = segs[i + 1];
        let el = null;
        if (entityKey) {
          // `<queuePath>#<user>` (queue users) selects the queue by path on the queue[] level and the user by name on user[]
          const [qPart, uPart] = String(entityKey).includes("#") ? String(entityKey).split("#") : [entityKey, null];
          el = cur.find(
            (x) =>
              x &&
              (x.id === entityKey ||
                x.name === entityKey ||
                x.containerId === entityKey ||
                (x.queuePath != null && x.queuePath === qPart) ||
                (uPart != null && x.username === uPart))
          );
          if (el) matchedBy = "entity-lookup";
        }
        if (!el) {
          el = cur[0];
          matchedBy = entityKey ? "first-element" : "first-element";
        }
        cur = el;
        i++;
        continue;
      }
      if (typeof cur === "object") {
        const k = Object.keys(cur)[0];
        cur = cur[k];
        i++;
        matchedBy = "map-first-key";
        continue;
      }
      return { value: undefined, how: "array-expected" };
    }
    cur = cur[segs[i]];
    i++;
  }
  return { value: cur, how: matchedBy, path: canon };
}

/* ------------------------------------------------------------------ main comparison */

export function compareScenario(ctx) {
  const {
    inventory,
    scenario,
    legacyByPage, // Map(pageId -> {capture, records})
    oursByRoute, // Map(routeKey -> {datums, entities, url, error})
    restByUrl, // Map(url -> json)
    routes, // config/routes.yaml resolved rules
    outOfScope = new Map(), // pageId -> reason (page has no SPA counterpart by design)
    config = {}, // chromeSections / normaliserOverrides / tolerances
    log = () => {},
  } = ctx;
  const chromeSectionRe = (config.chromeSections ?? []).map((r) => new RegExp(r));
  const sharedSectionRe = (config.sharedSections ?? []).map((r) => new RegExp(r));
  const toleranceFor = (fieldId) => (config.tolerances ?? {})[fieldId] ?? null;
  const rows = [];
  const warnings = [];
  const skippedPages = [];

  for (const page of inventory.pages) {
    if (!page.standalone) continue;
    if (scenario.pages && !scenario.pages.includes(page.id)) continue;
    const pageWhen = evalWhen(page.when, { facts: scenario.facts });
    if (pageWhen.gated) {
      skippedPages.push({ page: page.id, reason: `page when: ${pageWhen.reasons.join("; ")}` });
      continue;
    }
    const legacy = legacyByPage.get(page.id);
    const routeAlt = routeAlternatives(page.route);
    const legacyParams = paramsForPage(legacy?.route ?? routeAlt[0], scenario.params, page);
    const pageEntity = legacy ? pageEntityOf(page.route, scenario.params) : null;
    const oursRoute = resolveOursRoute(page, scenario.params, routes, ctx.resolveOurs ?? null);
    const ours = oursRoute ? oursByRoute.get(oursRoute.key) : null;

    const itemCtxBase = {
      pageSections: page.sections,
      sharedAlternatives: (field, ownKey) => sharedAlternatives(oursByRoute, field, ownKey),
      facts: scenario.facts,
      pageEntity,
      scenario,
      ours: {
        datums: ours?.datums ?? [],
        entities: ours?.entities ?? [],
        url: ours?.url ?? null,
        error: ours?.error ?? (oursRoute ? "not captured" : null),
      },
      oursRoutePath: oursRoute?.key ?? null,
      oursRouteMapped: !!oursRoute,
      legacy: legacy ?? { capture: null, records: [] },
      records: legacy?.records ?? [],
      pageError: legacy?.error ?? null,
      pageRoute: legacy?.route ?? null,
      restValueFor: (field, key, item) => {
        const eff = effectiveRestField(field, item);
        const t = eff && itemResourceTarget(inventory, eff, scenario);
        if (!t) return { value: undefined, how: "no-resource-mapping" };
        const url = joinUrl(scenario.rmBase, t.path);
        const json = restByUrl.get(url);
        if (json === undefined) return { value: undefined, how: `resource-not-fetched:${t.path}` };
        return resolveRestValue(inventory, eff, json, key);
      },
    };

    for (const section of page.sections) {
      const itemCtx = {
        ...itemCtxBase,
        sectionTitle: section.title,
        sectionId: section.id,
        // a section that lists table columns is a table: its `link` items (Node, Logs, Tracking UI) are cells of that table, not kv pairs
        sectionIsTable: section.items.some((i) => i.kind === "column" || i.kind === "cell"),
        fieldAliases: config.fieldAliases ?? {},
        sectionWhen: section.when ?? [],
        isShared: sharedSectionRe.some((re) => re.test(section.id)),
        sectionScenario: section.scenario ?? null,
        outOfScopeReason: outOfScope.get(page.id) ?? null,
        isChrome: chromeSectionRe.some((re) => re.test(section.id)),
        isNonHtml: isNonHtmlContentType(legacy?.contentType),
        contentType: legacy?.contentType ?? null,
        normaliserOverrides: config.normaliserOverrides ?? {},
        tolerances: config.tolerances ?? {},
      };
      for (const item of section.items) {
        const perItem = {
          ...itemCtx,
          normaliserOverride: (config.normaliserOverrides ?? {})[item.field] ?? null,
          tolerance: (config.tolerances ?? {})[item.field] ?? null,
        };
        const row = compareItem(item, section, perItem, inventory, scenario);
        if (row.warnings?.length) warnings.push(...row.warnings.map((w) => ({ page: page.id, item: item.id, ...w })));
        rows.push({ page: page.id, section: section.id, sectionTitle: section.title, ...row });
      }
    }
  }

  const totals = {};
  for (const r of rows) totals[r.status] = (totals[r.status] ?? 0) + 1;
  const entityTotals = {};
  for (const r of rows) for (const o of r.observations ?? []) entityTotals[o.status] = (entityTotals[o.status] ?? 0) + 1;
  return { rows, totals, entityTotals, warnings, skippedPages };
}

function paramsForPage(route, params, page) {
  const tokens = routeTokens(route);
  const out = { ...params };
  for (const t of tokens) {
    const a = paramAlias(t);
    if (out[a] == null || out[a] === "") out[a] = params[a];
  }
  return out;
}



export function resolveOursRoute(page, params, routes, resolver = null) {
  if (resolver) return resolver(page, params, routes);
  const rule = (routes?.rules ?? []).find((r) => {
    try {
      return new RegExp(r.match).test(page.id);
    } catch {
      return false;
    }
  });
  if (!rule || rule.ours == null) return null;
  let path = rule.ours;
  path = path.replace(/\{([^}]+)\}/g, (_, t) => params[paramAlias(t)] ?? params[t] ?? "");
  if (/\{/.test(path)) return null;
  const query = (rule.query ?? []).map((q) => q.replace(/\{([^}]+)\}/g, (_, t) => params[paramAlias(t)] ?? "")).join("&");
  const key = query ? `${path}?${query}` : path;
  return { key, path, query, rule };
}

/**
 * The field row to use for REST resolution: registry `rest` rows win, else the item's inline
 * `rest: {resource, path}` (legacy-*.yaml carries it even before rest-rm.yaml is generated).
 */
export function effectiveRestField(field, item) {
  const rest = Array.isArray(field?.rest) ? field.rest.filter((r) => r?.jsonPath || typeof r === "string") : [];
  if (rest.length) return field;
  const inline = item?.rest;
  if (inline?.path || typeof inline === "string") {
    const jsonPath = typeof inline === "string" ? inline : inline.path;
    const resource = typeof inline === "string" ? null : (inline.resource ?? null);
    return { ...(field ?? {}), rest: [{ resource, jsonPath }] };
  }
  return field;
}

/**
 * Which upstream resource carries this field? Uses the inventory's `rest: [{resource, jsonPath}]`
 * when present, else maps the jsonPath root against the built-in stopgap table.
 */
export function itemResourceTarget(inventory, field, scenario) {
  const rest = Array.isArray(field?.rest) ? field.rest : [];
  if (!rest.length) return null;
  const withResource = rest.find((r) => r?.resource);
  if (withResource) {
    const t = resourceTarget(inventory, withResource.resource, scenario);
    if (t) return t;
  }
  for (const r of rest) {
    const guess = builtinResourceByRoot(r?.jsonPath);
    if (guess) return resourceTarget(inventory, guess, scenario);
  }
  return null;
}

function builtinResourceByRoot(jsonPath) {
  const p = canonicalPath(jsonPath ?? "");
  if (!p) return null;
  const roots = Object.entries(BUILTIN_RESOURCES)
    .map(([id, spec]) => [id, spec.root ? canonicalPath(spec.root) : null])
    .filter(([, r]) => !!r)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [id, root] of roots) if (p === root || p.startsWith(`${root}.`)) return id;
  // map roots written as `x[]` in the inventory vs `x.*` here
  for (const [id, root] of roots) {
    const loose = root.replace(/^/, "");
    if (p.replace(/\.\*/g, "") === loose.replace(/\.\*/g, "")) return id;
  }
  return null;
}

function joinUrl(base, p) {
  if (!base) return p;
  return `${String(base).replace(/\/+$/, "")}${p.startsWith("/") ? p : `/${p}`}`;
}

/* ------------------------------------------------------------------ one item */

function compareItem(item, section, ctx, inventory, scenario) {
  const out = {
    item: item.id,
    label: item.label,
    field: item.field,
    fields: item.fields,
    kind: item.kind,
    normaliser: item.normaliser,
    format: item.format,
    nullDisplay: item.nullDisplay,
    when: item.when,
    scenarioHint: item.scenario,
    restGap: item.restGap,
    derivation: item.derivation,
    source: item.source,
    oursRoute: ctx.oursRoutePath ?? null,
    oursError: ctx.ours?.error ?? null,
    observations: [],
    warnings: [],
  };

  const field = inventory.fields.get(item.field);
  out.fieldOrigin = field?.origin ?? "unknown";
  out.fieldUnresolved = !!field?.unresolved;

  // ---- waivers
  const groupWaiver = waivedByGroup(inventory, item.field) ?? (field?.rest?.[0]?.jsonPath ? waivedByGroup(inventory, canonicalPath(field.rest[0].jsonPath)) : null);
  const waiver =
    inventory.waivers.items.get(`${item.page}\u0000${item.label ?? ""}`) ??
    (item.field ? inventory.waivers.fields.get(item.field) : null) ??
    field?.waiver ??
    groupWaiver ??
    null;
  // A waiver explains a field we cannot/should not render; it must not mask the fact that the legacy UI does not even
  // show it in this scenario. An unmet visibility gate wins (the row is then a justified `not-observable` below).
  const when = evalWhen([...(ctx.sectionWhen ?? []), ...(item.when ?? [])], { facts: scenario.facts });
  if (waiver && !when.gated) {
    return { ...out, status: "waived", waiver, observations: [{ status: "waived", reason: waiver.category }] };
  }

  // ---- the page could not be crawled (route params unavailable, capture failed, or the phase
  // budget was exhausted): reported as `not-captured` with the reason — explicit, never a silent
  // absence, and never mistaken for a value result.
  if (ctx.pageError && !ctx.records.length) {
    return {
      ...out,
      status: "not-captured",
      justification: `page not captured (${ctx.pageError}); route=${ctx.pageRoute ?? "n/a"}`,
      harnessGap: true,
      observations: [
        {
          status: "not-captured",
          reason: `page not captured (${ctx.pageError})`,
          hint: "harness-side: unresolved route params, a capture failure, or the --capture-timeout budget; see summary.skippedCaptures",
        },
      ],
    };
  }

  // ---- legacy chrome: the Hamlet frame (nav/tools header/legend) that PLAN.md §5 says our SPA
  // deliberately does not reproduce; classified systematically by section, not row by row.
  if (ctx.isChrome && !ctx.ours.datums?.some((d) => d.field === item.field)) {
    return {
      ...out,
      status: "chrome-only",
      justification: `legacy Hamlet chrome section (${section.id}); our chrome is intentionally different (PLAN.md §5)`,
      observations: [{ status: "chrome-only", reason: "legacy chrome, no data parity requirement" }],
    };
  }

  // ---- non-HTML legacy pages (servlet bodies: /conf XML, /jmx JSON, /stacks text, /metrics text):
  // the DOM extractor only reads Hamlet HTML, so nothing here is observable by this harness.
  if (ctx.isNonHtml) {
    return {
      ...out,
      status: "harness-uncovered",
      justification: `legacy page is ${ctx.contentType ?? "not HTML"}; the DOM extractor parses Hamlet HTML tables only — needs a raw-body parse path (harness gap, not a product gap)`,
      observations: [{ status: "harness-uncovered", reason: `content-type ${ctx.contentType ?? "unknown"}` }],
    };
  }

  // ---- explicit scope decision recorded in parity/harness/config/routes.yaml
  if (ctx.outOfScopeReason) {
    return {
      ...out,
      status: "not-applicable",
      justification: ctx.outOfScopeReason,
      observations: [{ status: "not-applicable", reason: ctx.outOfScopeReason }],
    };
  }

  // ---- `when` gating
  // the section's own `when` gates every item in it (e.g. the User Metrics block exists only when root QueueMetrics
  // keeps per-user metrics); item-level conditions add to it (evaluated above, before waivers)
  for (const u of when.unevaluated) out.warnings.push({ kind: "unevaluated-condition", detail: u });
  if (when.gated) {
    return {
      ...out,
      status: "not-observable",
      justification: `when: ${when.reasons.join("; ")}`,
      observations: [{ status: "not-observable", reason: when.reasons.join("; ") }],
    };
  }

  const entityType = item.field ? entityOf(item.field, inventory) : null;
  out.entity = entityType;
  ctx = { ...ctx, remapped: new Set() };

  // ---- legacy observations
  const legacyRecs = selectLegacyRecords(item, ctx, entityType);
  // ---- ours observations
  // `fieldAliases` (config/routes.yaml): ids that name the same datum from two REST shapes
  const aliasId = ctx.fieldAliases?.[item.field] ?? null;
  const oursDatums = (ctx.ours.datums ?? []).filter((d) => d.field === item.field || (aliasId && d.field === aliasId));

  const routeMapped = !!ctx.oursRouteMapped;

  const keys = new Set([...legacyRecs.map((r) => r.key), ...oursDatums.map((d) => entityKeyOfDatum(d, ctx, entityType))]);

  // Static copy (`static.*`: page/section titles, column headers, legends, state descriptions) carries no datum: the
  // field id names a string the stock UI prints, not a value. Our chrome is intentionally different (PLAN.md §5), so a
  // static item our DOM does not tag is `chrome-only` — also when the legacy side matched some text (kept on the
  // observation so the report shows what the stock UI printed). A static item that ours *does* tag is compared normally.
  if (item.field?.startsWith("static.") && !oursDatums.length) {
    return {
      ...out,
      status: "chrome-only",
      justification: "static copy (no datum); our chrome is intentionally different (PLAN.md §5)",
      observations: [{ status: "chrome-only", reason: "static copy, no data", legacyText: legacyRecs[0]?.text ?? null }],
    };
  }

  if (!legacyRecs.length && !oursDatums.length) {
    const hint = hintFor(item, ctx);
    const scenarioText = item.scenario || ctx.sectionScenario || "";
    const justification = scenarioText
      ? `not rendered in this scenario (declared by inventory: ${truncate(scenarioText, 120)})`
      : null;
    if (item.field?.startsWith("static.")) {
      return { ...out, status: "chrome-only", observations: [{ status: "chrome-only", reason: "static chrome, no data" }] };
    }
    // an unlabelled item is only unmappable when there is no join hint at all (labelFallback: e.g. the href of the
    // "Tracking UI" anchor)
    if (item.label == null && item.kind !== "title" && labelFallback(item, ctx) == null) {
      return {
        ...out,
        status: "unmapped",
        justification: "inventory item has no label; the harness cannot join it to a legacy cell (add label or a join hint)",
        observations: [{ status: "unmapped" }],
      };
    }
    return {
      ...out,
      status: justification ? "not-observable" : "absent",
      justification,
      hint,
      observations: [
        {
          status: justification ? "not-observable" : "absent",
          reason: justification ?? "neither the stock UI nor ours rendered this item in this scenario",
          hint,
        },
      ],
    };
  }

  if (!legacyRecs.length && oursDatums.length) {
    return {
      ...out,
      status: "ours-only",
      observations: keys.size ? [...keys].map((k) => ({ status: "ours-only", key: k })) : [],
      routeMapped,
    };
  }

  const observations = [];
  for (const key of keys) {
    const rel = legacyRecs.filter((r) => r.key === key);
    const ods = oursDatums.filter((d) => entityKeyOfDatum(d, ctx, entityType) === key);
    let obs = compareOne(key, rel, ods, item, field, ctx);
    // shared-sidebar policy: a shared-section item our own route does not render counts as covered when ANY other
    // crawled route of the scenario renders it with an equal value (own route first; the route is reported).
    // Own-route datums are never second-guessed: a value difference there stays a mismatch.
    if (ctx.isShared && obs.status === "legacy-only" && !ods.length && rel.length) {
      const alts = ctx.sharedAlternatives(item.field, ctx.oursRoutePath);
      let first = null;
      for (const alt of alts) {
        const altOds = alt.datums.filter((d) => (d.entity && d.entity !== "_" ? d.entity : "_") === key);
        if (!altOds.length) continue;
        const o2 = compareOne(key, rel, altOds, item, field, ctx);
        o2.sharedFromRoute = alt.route;
        o2.justification = `shared sidebar section: not rendered on ${ctx.oursRoutePath ?? "its own route"}; rendered on ${alt.route} (${o2.status})`;
        first ??= o2;
        if (o2.status === "match") {
          obs = o2;
          break;
        }
      }
      if (obs.status === "legacy-only" && first) obs = first;
    }
    observations.push(obs);
  }
  for (const note of ctx.remapped) out.warnings.push({ kind: "ours-entity-tag", detail: note });
  // collapse: worst status wins
  const order = ["mismatch", "legacy-only", "ours-only", "match"];
  const worst = observations
    .map((o) => o.status)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? "absent";
  return {
    ...out,
    status: worst,
    observations,
    justification: observations.find((o) => o.justification)?.justification ?? null,
    routeMapped,
  };
}

function entityKeyOfDatum(d, ctx, entityType = null) {
  const key = d.entity && d.entity !== "_" ? d.entity : (ctx.pageEntity?.key ?? "_");
  // Our attempt page tags `attempt.*` datums with the *application* id in data-ye. The values are still ours-vs-legacy
  // comparable (the page shows exactly one attempt), so a datum of the page's own entity type whose tag is a foreign entity
  // key is joined to the page entity — and the tag itself is reported as a warning, never hidden.
  if (entityType && ctx.pageEntity?.entity === entityType) {
    const t = entityTypeOfKey(key);
    if (t && t !== entityType) {
      ctx.remapped?.add(`${d.field}: data-ye=${key} (${t}) on a ${entityType} page, joined to ${ctx.pageEntity.key}`);
      return ctx.pageEntity.key;
    }
  }
  return key;
}

/** Legacy records that plausibly carry this item, best first. */
function selectLegacyRecords(item, ctx, entityType) {
  const label = item.label;
  const records = ctx.records ?? [];
  let cands;
  if (item.kind === "title" || label == null) {
    const fallbackLabel = label == null ? labelFallback(item, ctx) : label;
    if (fallbackLabel == null) {
      // a `title` item without a label matches the page heading
      cands = records.filter((r) => r.kind === "title");
    } else {
      cands = records.filter((r) => sameLabel(r.label, fallbackLabel, { dynamic: item.dynamic }));
    }
  } else {
    cands = records.filter((r) => sameLabel(r.label, label, { dynamic: item.dynamic }));
  }
  if (!cands.length) return [];
  // A page can carry the same label twice with different meanings: the app page has a `Started:`
  // label/value pair *and* an attempts table whose first column is also `Started`. Column items must
  // only ever join table cells; label/value items must only join kv/metric pairs.
  const isColumnItem = item.kind === "column" || item.kind === "cell" || (ctx.sectionIsTable && (item.kind === "link" || item.kind === "chart"));
  const kindScoped = cands.filter((r) =>
    isColumnItem
      ? r.kind === "cell" || r.kind === "grid-cell"
      : item.kind === "title"
        ? r.kind === "heading" || r.kind === "title"
        : r.kind === "kv" || r.kind === "metric"
  );
  // Kind scoping is a *preference*, not a hard filter: a `link` item (e.g. the apps table's Tracking UI
  // column, whose cell carries the href) would otherwise be dropped entirely when its only candidate is a
  // table cell. Falling back keeps the join honest — the scoped set still wins when it exists.
  if (kindScoped.length) cands = kindScoped;
  // entity type filter
  if (entityType) {
    const typed = cands.filter((r) => r.type === entityType || r.type == null);
    if (typed.length) cands = typed;
  }
  // Table cells are captured twice: the DataTables *source* (`embedded`, the page's own value) and the rendered
  // text (`dom`). Prefer the embedded value for comparison. Verified live: the apps table's FinishTime cell
  // rendered "Sat Oct 3 14:38:57 +0550 2026" for an embedded epoch that is 14:38:57 at +0530 — the client-side
  // rendering's zone label disagrees with its own instant, while the embedded value is byte-identical to the RM
  // JSON and to our `data-yv`. Comparing against the rendering therefore manufactures a 20-minute mismatch.
  if (isColumnItem) {
    const byCell = new Map();
    for (const r of cands) {
      const id = `${r.key}|${r.label}|${r.tableId}|${r.columnIndex}`;
      const prev = byCell.get(id);
      if (!prev || (r.source === "embedded" && prev.source !== "embedded")) byCell.set(id, r);
    }
    cands = [...byCell.values()];
  }
  // section filter (prefer the item's own section title when the legacy page labels sections)
  if (ctx.sectionTitle) {
    const scoped = cands.filter((r) => titleMatches(r.sectionTitle, ctx.sectionTitle));
    if (scoped.length) return scoped;
    // No record carries this section's own title. Falling back to every label match used to join a label that
    // belongs to a *different* section of the same page (User Metrics "Apps Submitted" vs Cluster Metrics "Apps
    // Submitted"). A candidate whose legacy section is claimed by another inventory section is not ours.
    const others = (ctx.pageSections ?? []).filter((x) => x.id !== ctx.sectionId && x.title).map((x) => x.title);
    cands = cands.filter((r) => !r.sectionTitle || !others.some((t) => titleMatches(r.sectionTitle, t)));
  }
  // Non-default partitions have their own block per queue ("... for Partition 'gpu'"); our scheduler page selects one
  // partition at a time, so the join uses the default partition's block when it exists (other partitions stay visible
  // in the legacy records and the report, they are just not joined to the single-partition datum).
  const defaultPartition = cands.filter((r) => !r.partition || r.partition === "<DEFAULT_PARTITION>");
  if (defaultPartition.length && defaultPartition.length < cands.length) cands = defaultPartition;
  return cands;
}

/** Section titles: exact (whitespace-normalised), or a dynamic prefix ("User Metrics for " + user). */
function titleMatches(recTitle, sectionTitle) {
  if (recTitle == null || sectionTitle == null) return false;
  const norm = (x) => String(x).replace(/\s+/g, " ").trim();
  const r = norm(recTitle);
  const t = norm(sectionTitle);
  if (r === t) return true;
  return /\s$/.test(String(sectionTitle)) && r.startsWith(`${t} `);
}

/**
 * Shared-sidebar policy (config/routes.yaml `sharedSections`): the stock UI repeats the cluster/nodes/scheduler/user
 * metrics blocks on every page, while our SPA renders each once (the dashboard/sidebar). Datums for `field` on every
 * crawled route of the scenario, as [{route, datums}].
 */
function sharedAlternatives(oursByRoute, field, ownRoute) {
  const out = [];
  for (const [route, cap] of oursByRoute ?? []) {
    if (route === ownRoute) continue;
    const datums = (cap?.datums ?? []).filter((d) => d.field === field);
    if (datums.length) out.push({ route, datums });
  }
  return out.sort((a, b) => a.route.length - b.route.length || a.route.localeCompare(b.route));
}

function labelFallback(item, ctx) {
  // e.g. `app.trackingUrl` (label null) is the href of the "Tracking UI" anchor
  if (item.field === "app.trackingUrl") return "Tracking UI";
  // capacity-scheduler queue-tree bars: unlabelled items map onto the labelled bar records legacy.mjs emits
  if (/\.scheduler\.capacity\.bar\.queue-name$/.test(item.id ?? "")) return BAR_QUEUE_NAME;
  if (/\.scheduler\.capacity\.bar\.autocreated$/.test(item.id ?? "")) return BAR_AUTO_CREATED;
  if (/\.scheduler\.capacity\.bar\.partition$/.test(item.id ?? "")) return BAR_PARTITION;
  if (/\.scheduler\.capacity\.users\.highlight$/.test(item.id ?? "")) return ROW_HIGHLIGHT;
  if (item.kind === "title") return null;
  return null;
}

/** Source-grounded explanation for the common "not rendered by either side" cases. */
const DOMAIN_HINTS = [
  {
    test: (item) => /^usermetrics\./.test(item.field ?? ""),
    hint:
      "the stock UI only renders the `User Metrics for <user>` table when the RM's *remote user* has root-queue " +
      "metrics (MetricsOverviewTable.java:157-160 -> UserMetricsInfo(user).metricsAvailable()); with the default " +
      "StaticUserWebFilter the remote user is dr.who, so apps submitted as another user produce no table. " +
      "Inventory should declare `when: [other:remote user has root-queue QueueMetrics]`.",
  },
  {
    test: (item) => /^clusteruser\./.test(item.field ?? ""),
    hint:
      "the `User Metrics for ` heading carries the remote user name (HeaderBlock.java:29 / MetricsOverviewTable.java:158); " +
      "it appears only with that table (see usermetrics.* hint).",
  },
];

function hintFor(item, ctx) {
  for (const h of DOMAIN_HINTS) {
    try {
      if (h.test(item)) return h.hint;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function sameLabel(a, b, { dynamic = false } = {}) {
  if (a == null || b == null) return a == null && b == null;
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x.replace(/:$/, "") === y.replace(/:$/, "")) return true;
  if (dynamic) {
    // a dynamic label marks its variable part with a leading/trailing space ("User Metrics for " + user, " Queue Status"
    // = "'<queue>' Queue Status"); the fixed part must be there, and something must have been added to it
    const fixed = norm(b);
    const lead = /^\s/.test(String(b));
    const trail = /\s$/.test(String(b));
    if (fixed.length > 3 && x.length > fixed.length) {
      if (trail && !lead && x.startsWith(fixed)) return true;
      if (lead && !trail && x.includes(fixed)) return true;
      if (lead && trail && x.includes(fixed)) return true;
    }
  }
  return false;
}

function compareOne(key, rel, ods, item, field, ctx) {
  const legacyRec = rel.find((r) => r.source === "dom") ?? rel[0] ?? null;
  const embeddedRec = rel.find((r) => r.source === "embedded") ?? null;
  const od = ods[0] ?? null;
  // A progress bar carries its value in the cell's title attribute (RMAppsBlock.java:78: bar width + title="<%.1f>%"); the cell text is empty.
  // The title is the legacy datum, so it is compared like any other legacy text (no value is ignored).
  const titleIsValue = item.format === "progress-bar" && legacyRec && String(legacyRec.text ?? "") === "" && /^\s*-?\d+(\.\d+)?\s*%?\s*$/.test(String(legacyRec.title ?? ""));
  const legacyText = titleIsValue ? String(legacyRec.title).trim() : (legacyRec?.text ?? null);
  const detail = {
    key,
    status: "match",
    legacyText: legacyText ?? null,
    legacyHref: legacyRec?.href ?? null,
    legacyTitle: legacyRec?.title ?? null,
    legacySource: legacyRec?.source ?? null,
    embeddedText: embeddedRec?.text ?? null,
    embeddedTitle: embeddedRec?.title ?? null,
    oursRaw: od ? (od.yn ? null : od.raw) : null,
    oursText: od?.text ?? null,
    oursFmt: od?.fmt ?? null,
    canonical: null,
    restValue: undefined,
    restHow: null,
    reason: null,
    occurrences: ods.length,
  };

  const ctxN = {
    unit: field?.unit ?? null,
    nullDisplay: item.nullDisplay,
    href: legacyRec?.href,
    side: "legacy",
    // `config/normaliser-overrides.yaml` supplies normalisers the inventory is missing; provisional
    // by design (it should move into the registry) and always visible in the report's notes.
    normaliserSpec: ctx.normaliserOverride ?? item.normaliser,
  };
  const normSpec = ctx.normaliserOverride ?? item.normaliser;
  const lc = canonicalise(legacyText, normSpec, ctxN);
  detail.canonical = lc.value;
  detail.normaliserApplied = normSpec;
  if (ctx.normaliserOverride) detail.normaliserOverride = `${item.normaliser} -> ${ctx.normaliserOverride}`;
  if (lc.notes?.length) detail.normaliserNotes = lc.notes;

  // REST cross-check (independent of our UI, and the only check available when ours is missing)
  const rv = ctx.restValueFor(field, key, item);
  if (rv.value !== undefined) {
    detail.restValue = rv.value;
    detail.restHow = rv.how ?? null;
    detail.restPath = rv.path ?? field?.rest?.[0]?.jsonPath ?? null;
  }

  const derived = item.field?.includes(".derived.") || field?.origin === "derived";
  const canonOf = (v) => canonicalise(v, normSpec, { unit: field?.unit ?? null, nullDisplay: item.nullDisplay, href: null, side: "ours" });
  let eq;
  // A `link` item whose legacy record carries an href is the anchor's destination, not its caption: the
  // apps table's Tracking UI cell renders the caption (`History`) while `data-yv` on the anchor holds the
  // URL (verified live: legacy embedded href == REST trackingUrl == our data-yv). Only when the two sides
  // disagree in *kind* — our value is a URL and the legacy text is a caption — is the href the datum to
  // compare; a link item whose value is an id (`legacy.rm.apps.table.id`) keeps comparing text.
  const urlLike = (v) => typeof v === "string" && /^[a-z][a-z0-9+.-]*:\/\/|^\//i.test(v.trim());
  const linkHref = item.format === "url" && legacyRec?.href && od && !od.yn && urlLike(od.raw) && !urlLike(legacyText) ? String(legacyRec.href) : null;
  // A datum whose raw upstream value is an object/array is a *composite*: our `data-yv` holds the source
  // structure (e.g. `{"memory":2304,...}`) while the rendered text is the legacy `Resource.toString()`
  // (`<memory:2304, vCores:3>`). Canonicalising the JSON against that text can never be equal, so compare
  // the rendered text — the same rule derived items already use. `data-yv` is an attribute, so the source
  // structure arrives as a JSON string: recognise it by shape, not by typeof.
  const jsonObjectish = (v) => {
    if (typeof v !== "string" || !/^\s*[[{]/.test(v)) return false;
    try {
      const p = JSON.parse(v);
      return p != null && typeof p === "object";
    } catch {
      return false;
    }
  };
  const compositeRaw = !!od && !od.yn && jsonObjectish(od.raw);
  if (linkHref != null) {
    const lh = canonicalise(linkHref, normSpec, { unit: field?.unit ?? null, nullDisplay: item.nullDisplay, href: linkHref, side: "legacy" });
    const or_ = canonOf(od?.yn ? null : od?.raw);
    detail.legacyHrefCanonical = lh.value;
    detail.oursCanonical = or_.value;
    eq = canonicalEqual(lh.value, or_.value);
    detail.compareMode = "href";
  } else if (compositeRaw && !(CLOCK_DERIVED_FIELDS.has(item.field) && od)) {
    eq = looseEqual(legacyText, detail.oursText ?? detail.oursRaw);
    detail.compareMode = "derived-text";
  } else if (derived && !(CLOCK_DERIVED_FIELDS.has(item.field) && od)) {
    eq = looseEqual(legacyText, detail.oursText ?? detail.oursRaw);
    detail.compareMode = "derived-text";
    // A derived composite can be rendered with different wording while `data-yv` carries the exact upstream
    // text (verified: our version field shows "3.4.3 on <builtOn>" and its raw value is byte-identical to the
    // legacy build string). The configured tolerance covers exactly that case; its reason is recorded on the
    // row and both texts stay in the observation.
    if (!eq.equal && ctx.tolerance) {
      const tol = applyTolerance(ctx.tolerance, { legacyCanonical: lc.value, restCanonical: detail.oursRaw });
      if (tol?.ignored) {
        detail.tolerance = { ...ctx.tolerance, note: tol.note };
        eq = { equal: true, why: `tolerance(${ctx.tolerance.mode})` };
      }
    }
  } else if (od) {
    const oc = canonOf(od.yn ? null : od.raw);
    detail.oursCanonical = oc.value;
    eq = canonicalEqual(lc.value, oc.value);
    detail.compareMode = "raw";
  } else {
    eq = { equal: false, why: "ours-absent" };
    detail.compareMode = "raw";
  }

  // documented tolerance on the legacy-vs-ours comparison as well (e.g. composite build strings where
  // our wording deliberately differs but the datum — the version token — is identical)
  if (!eq.equal && od && ctx.tolerance) {
    const tol = applyTolerance(ctx.tolerance, { legacyCanonical: lc.value, restCanonical: detail.oursCanonical });
    if (tol?.ignored) {
      detail.tolerance = { ...ctx.tolerance, note: tol.note };
      eq = { equal: true, why: `tolerance(${ctx.tolerance.mode})` };
    }
  }

  // ---- independent cross-check against the REST reference (works with or without our UI).
  // Skipped for derived/composite items (`app.derived.elapsedText` legitimately differs from any
  // single upstream field) and for opaque `other:` normalisers (nothing to canonicalise with).
  const specParsed = parseSpec(normSpec ?? "none");
  const opaqueNormaliser = !!specParsed.opaque || specParsed.unknown.length > 0;
  let restCheck = null;
  if (detail.restValue !== undefined && !derived && !opaqueNormaliser) {
    const rc = canonOf(detail.restValue);
    detail.restCanonical = rc.value;
    const re = derived ? looseEqual(legacyText, detail.restValue) : canonicalEqual(lc.value, rc.value);
    const bothAbsent = lc.value == null && rc.value == null;
    restCheck = { equal: re.equal, why: re.why, bothAbsent, restCanonical: rc.value, legacyCanonical: lc.value };
    detail.restEqual = bothAbsent ? null : re.equal;
    detail.restCompareWhy = re.why;
  }

  if (detail.restValue !== undefined && (derived || opaqueNormaliser)) detail.restCheckSkipped = derived ? "derived value" : "opaque normaliser";

  // ours-vs-rest (when both are present) is the strongest signal that our UI formats/derives wrongly
  let oursRestCheck = null;
  if (od && detail.restValue !== undefined && !derived) {
    const oc = canonOf(od.yn ? null : od.raw);
    const rc = canonOf(detail.restValue);
    const re = canonicalEqual(oc.value, rc.value);
    oursRestCheck = { equal: re.equal, why: re.why };
    detail.oursRestEqual = re.equal;
  }

  // The legacy DOM cell vs the embedded DataTables array must agree with each other too: if the
  // rendered text disagrees with the raw array it means client-side formatting did something.
  if (embeddedRec && legacyRec && legacyRec.source === "dom") {
    const ec = canonicalise(embeddedRec.text, normSpec, { ...ctxN, href: embeddedRec.href });
    detail.embeddedCanonical = ec.value;
    if (!canonicalEqual(ec.value, lc.value).equal) {
      detail.embeddedDisagrees = { dom: lc.value, embedded: ec.value };
    }
  }

  if (restCheck && !restCheck.equal && !restCheck.bothAbsent) {
    // an explicit, reviewable tolerance (config/tolerances.yaml): `version-prefix` compares only the
    // leading version token of a composite build string; `pct-tolerance` allows a documented drift.
    const tol = ctx.tolerance ? applyTolerance(ctx.tolerance, restCheck) : null;
    if (tol?.ignored) {
      detail.status = "match";
      detail.reason = `tolerance(${ctx.tolerance.mode}): ${tol.note}`;
      detail.tolerance = { ...ctx.tolerance, note: tol.note };
      return detail;
    }
    // legacy text and the upstream value disagree. On multi-agent/live clusters the two samples are
    // never simultaneous, so numeric live counters are reported as `sampling-race` (counted and
    // shown, never hidden); everything else is a hard mismatch.
    const volatile =
      isVolatileField(item.field, normSpec) &&
      clockRaceOk(item.field, restCheck.legacyCanonical, restCheck.restCanonical) &&
      typeof detail.restValue !== "object" &&
      // widened: any disagreement on a numeric volatile field is a race (the legacy snapshot and our/REST
      // sample cannot be simultaneous on a live cluster); both fresh values stay on the observation, so the
      // drift is visible and reviewable. A per-node field compared under the singleton key has no REST
      // canonical at all, which is exactly the case this must still classify.
      (!od || detail.oursCanonical != null || detail.restCanonical != null);
    detail.status = volatile ? "sampling-race" : "mismatch";
    detail.reason = `${volatile ? "sampling-race" : "legacy-vs-rest"}: ${restCheck.why} (legacy=${JSON.stringify(restCheck.legacyCanonical)}, rest=${JSON.stringify(restCheck.restCanonical)})`;
    detail.source = "rest";
    detail.volatile = volatile;
    return detail;
  }
  if (oursRestCheck && !oursRestCheck.equal && eq.equal) {
    const tolOR = ctx.tolerance
      ? applyTolerance(ctx.tolerance, {
          legacyCanonical: canonOf(od.yn ? null : od.raw).value,
          restCanonical: canonOf(detail.restValue).value,
        })
      : null;
    if (tolOR?.ignored) {
      detail.tolerance = { ...ctx.tolerance, note: tolOR.note };
      detail.status = "match";
      detail.reason = `tolerance(${ctx.tolerance.mode}) on ours-vs-rest: ${tolOR.note}`;
      return detail;
    }
    detail.status = "mismatch";
    detail.reason = `ours-vs-rest: ${oursRestCheck.why}`;
    detail.source = "rest-vs-ours";
    return detail;
  }

  if (eq.equal) {
    detail.status = od || detail.restValue !== undefined || embeddedRec || legacyRec ? "match" : "absent";
    detail.reason = eq.why;
  } else if (!legacyRec && od) {
    detail.status = "ours-only";
  } else if (legacyRec && !od) {
    // no ours datum: the REST value (when available) already agreed above, so this is purely a
    // rendering gap — the user cannot see this field in our UI.
    detail.status = "legacy-only";
    detail.reason = restCheck?.equal ? "ours did not render this field (value confirmed against upstream)" : "ours did not render this field";
  } else if (legacyRec && od) {
    // The configured tolerance applies to this comparison too: the version composites differ only in the
    // trailing wording (the version token is identical), which is a product presentation choice.
    const tol = ctx.tolerance
      ? applyTolerance(ctx.tolerance, {
          legacyCanonical: detail.canonical,
          restCanonical: detail.oursCanonical,
          equal: false,
          bothAbsent: false,
          why: "ours-vs-legacy",
        })
      : null;
    if (tol?.ignored) {
      detail.status = "match";
      detail.reason = `tolerance(${ctx.tolerance.mode}): ${tol.note}`;
      detail.tolerance = { ...ctx.tolerance, note: tol.note };
      return detail;
    }
    // A live gauge (node./cluster.metrics./scheduler./queue.) captured at two different instants cannot be
    // expected to agree; when both canonical values are numeric the disagreement is a sampling race.
    const numeric = (v) => v != null && /^-?\d+(?:\.\d+)?$/.test(String(v));
    const race =
      isVolatileField(item.field, normSpec) &&
      numeric(detail.canonical) &&
      numeric(detail.oursCanonical) &&
      clockRaceOk(item.field, detail.canonical, detail.oursCanonical);
    detail.status = race ? "sampling-race" : "mismatch";
    detail.reason = race
      ? `sampling-race: ours-vs-legacy (legacy=${detail.canonical}, ours=${detail.oursCanonical})`
      : eq.why;
    detail.source = "ours";
    detail.volatile = race;
  } else {
    detail.status = "absent";
  }
  return detail;
}

export { truncate };
