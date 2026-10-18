#!/usr/bin/env bun
// P1 — REST coverage: "no key left behind".
//
// Fetches every RM/NM/daemon resource from docs/contracts/api.md §3 (the list is parsed out of the
// contract document, not from memory), across all available application states, then collects every
// JSON key path observed. Asserts both directions:
//   observed ⊆ (inventory-declared rest fields ∪ waivers)      -> unknown keys fail
//   (inventory required fields ∪ waivers) ⊆ rendered-by-DOM    -> unrendered required fields fail
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { collectJsonPaths, canonicalPath, getPath, sha1short, tally, truncate } from "./lib/util.mjs";
import { loadInventory, entityOf, waivedByGroup } from "./lib/inventory.mjs";
import { runParity } from "./run.mjs";
import { itemResourceTarget, evalWhen } from "./lib/compare.mjs";

const STATES = ["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED", "RUNNING", "FINISHED", "FAILED", "KILLED"];

/** Parse the explicit, machine-readable resource list in API contract §3. */
export function parseApiContract(repoRoot) {
  const file = path.join(repoRoot, "docs/contracts/api.md");
  const text = fs.readFileSync(file, "utf8");
  const block = text.match(/<!-- parity-resources -->\s*```json\s*([\s\S]*?)```\s*<!-- \/parity-resources -->/);
  if (!block) throw new Error(`${file}: missing parity-resources JSON block`);
  const spec = JSON.parse(block[1]);
  for (const kind of ["rm", "nm", "daemon", "nmDaemon"]) {
    if (!Array.isArray(spec[kind]) || spec[kind].some((p) => typeof p !== "string" || !p || p.startsWith("/"))) {
      throw new Error(`${file}: ${kind} must contain nonempty relative resource paths`);
    }
  }
  return {
    rm: [...new Set(spec.rm)].map((p) => `/ws/v1/cluster/${p}`),
    nm: [...new Set(spec.nm)].map((p) => `/ws/v1/node/${p}`),
    daemon: [...new Set(spec.daemon)].map((p) => `/${p}`),
    nmDaemon: [...new Set(spec.nmDaemon)].map((p) => `/${p}`),
  };
}

/** Expand grouped resources and only fully resolved templates; never invent partial URLs. */
export function expandResources(spec, scenario) {
  const params = { type: "LIFETIME", ...(scenario.params ?? {}) };
  const out = [];
  const expand = (template) => {
    const group = template.match(/\{([^{}]*\|[^{}]*)\}/);
    if (group) return group[1].split("|").flatMap((value) => expand(template.replace(group[0], value)));
    let unresolved = false;
    const concrete = template.replace(/\{([^{}]+)\}/g, (_, name) => {
      const value = params[name];
      if (value == null || value === "") unresolved = true;
      return value ?? "";
    });
    return unresolved ? [] : [concrete];
  };
  const add = (templates, kind, base) => {
    for (const template of templates ?? []) {
      for (const resource of expand(template)) {
        const headers = resource.includes("conf?format=json") ? { Accept: "application/json" } : {};
        out.push({ id: `${kind}:${base ?? ""}${resource}`, path: resource, kind, headers, ...(base ? { base } : {}) });
      }
    }
  };
  add(spec.rm, "rm");
  if (spec.rm.includes("/ws/v1/cluster/apps")) {
    for (const state of STATES) add([`/ws/v1/cluster/apps?states=${state}`], "rm");
  }
  // NodeManagers expose different resident containers and daemon metrics; test the whole fleet.
  const nodes = scenario.nodeBases?.length ? scenario.nodeBases : scenario.nodeBase ? [scenario.nodeBase] : [];
  const bases = [...new Set(nodes.map((n) => typeof n === "string" ? n : n.webapp).filter(Boolean))];
  for (const base of bases) {
    add(spec.nm, "nm", base.replace(/\/+$/, ""));
    add(spec.nmDaemon, "nm-daemon", base.replace(/\/+$/, ""));
  }
  add(spec.daemon, "daemon", scenario.rmBase);
  return out;
}

/** Dynamic map keys explicitly declared by the inventory, e.g. JMX's beans[].<attrName>. */
export function declaredDynamicPathCovers(declaredPath, observedPath) {
  if (!/<[^>]+>/.test(declaredPath)) return false;
  const segments = canonicalPath(declaredPath).split(".");
  const pattern = segments.map((segment) => segment === "*" || /^<[^>]+>$/.test(segment)
    ? "[^.]+"
    : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\.");
  return new RegExp(`^${pattern}(?:\\.|$)`).test(canonicalPath(observedPath));
}

export async function runCoverage(opts) {
  const {
    repoRoot,
    scenario,
    upstream,
    reportDir,
    oursCaptures = [], // {routeKey, datums}
    config = null, // routes config: chromeSections / includePages / excludePages
    outOfScope = new Map(), // pageId -> reason (no SPA counterpart by design)
    pageIdsInScope = null, // Set of page ids inside the P2 scope (null = all)
    gatedPages = new Set(), // page ids whose `when:` is off under this scenario's facts
    nonHtmlPages = new Set(), // page ids whose legacy body is not Hamlet HTML (harness cannot read them)
    strict = false,
    log = console.log,
  } = opts;

  const inventory = opts.inventory ?? loadInventory(repoRoot);
  const spec = parseApiContract(repoRoot);
  const targets = expandResources(spec, scenario);

  const resources = [];
  const keyToResources = new Map(); // canonical key -> Set(resource id)
  const keyMeta = new Map(); // canonical key -> {types:Set, sample, count}
  for (const t of targets) {
    const base = t.base ?? scenario.rmBase;
    const url = `${String(base).replace(/\/+$/, "")}${t.path.startsWith("/") ? t.path : `/${t.path}`}`;
    let res;
    try {
      res = await upstream.get(url, { headers: { "Cache-Control": "no-cache", ...(t.headers ?? {}) } });
    } catch (e) {
      resources.push({ id: t.id, path: t.path, url, status: 0, error: String(e?.message ?? e), keyCount: 0 });
      continue;
    }
    const ct = res.headers?.["content-type"] ?? "";
    let keys = new Map();
    // only a successful body describes the resource's schema; an error body (the RM's RemoteException envelope, e.g. a container
    // that finished between target derivation and this fetch) would register RemoteException.* as "unknown keys". The resource still
    // lands in `resources` with its status, so the failed fetch stays visible in the report.
    if (res.status >= 200 && res.status < 300 && res.json && typeof res.json === "object") keys = collectJsonPaths(res.json);
    const entry = {
      id: t.id,
      path: t.path,
      url,
      status: res.status,
      contentType: ct.split(";")[0],
      keyCount: keys.size,
      sha: sha1short(res.text ?? ""),
    };
    resources.push(entry);
    for (const [k, types] of keys) {
      if (!keyToResources.has(k)) keyToResources.set(k, new Set());
      keyToResources.get(k).add(t.id);
      const meta = keyMeta.get(k) ?? { types: new Set(), count: 0, sample: undefined };
      for (const ty of types) meta.types.add(ty);
      meta.count++;
      if (meta.sample === undefined && res.json) meta.sample = truncate(JSON.stringify(getPath(res.json, k)), 160);
      keyMeta.set(k, meta);
    }
  }

  // ---- declared keys from the inventory. A registry row may declare a *root-absolute* jsonPath
  // (`apps.app[].allocatedMB`) or an entity-relative one (`allocatedMB`). Rather than guessing the
  // owning entity root (which multiplies every field by every root), the relative form is matched by
  // suffix lookup below: an observed key counts as declared when any of its dot-suffixes is declared.
  const declared = new Map(); // canonical key -> [{field, resource}]
  const dynamicPaths = new Set();
  const declaredSuffixes = new Map(); // relative canonical path -> [{field, resource}]
  const add = (map, ck, row) => {
    if (!map.has(ck)) map.set(ck, []);
    map.get(ck).push(row);
  };
  for (const f of inventory.fields.values()) {
    const rest = Array.isArray(f.rest) ? f.rest : [];
    for (const r of rest) {
      if (!r?.jsonPath) continue;
      if (/<[^>]+>/.test(r.jsonPath)) dynamicPaths.add(r.jsonPath);
      const row = { field: f.id, resource: r.resource ?? null };
      add(declared, canonicalPath(r.jsonPath), row);
      // relative form: the last N segments of the jsonPath (bounded, no combinatorial expansion)
      const segs = canonicalPath(r.jsonPath).split('.');
      for (let i = Math.max(1, segs.length - 4); i < segs.length; i++) add(declaredSuffixes, segs.slice(i).join('.'), row);
    }
  }
  // A declared key also covers anything *under* it (containers are not declared but their leaves are)
  const declaredRoots = [...declared.keys()];

  const waivedKeys = inventory.waivers.keys;
  const groupWaived = (k) => !!waivedByGroup(inventory, k);
  const unknownKeys = [];
  const observedKeys = [...keyToResources.keys()].sort();
  for (const k of observedKeys) {
    if (declared.has(k)) continue;
    if ([...dynamicPaths].some((p) => declaredDynamicPathCovers(p, k))) continue;
    const segs = k.split(".");
    const coveredBySuffix = segs.some((_, i) => declaredSuffixes.has(segs.slice(i).join(".")));
    const coveredByContainer = declaredRoots.some((d) => k.startsWith(`${d}.`) && !d.includes("*"));
    if (coveredByContainer || coveredBySuffix) continue;
    if (waivedKeys.has(k)) continue;
    if (groupWaived(k)) continue;
    const meta = keyMeta.get(k);
    unknownKeys.push({
      key: k,
      resource: [...(keyToResources.get(k) ?? [])].join(","),
      types: [...(meta?.types ?? [])],
      count: meta?.count ?? 0,
      sample: meta?.sample,
    });
  }

  // ---- rendered-by-DOM for the required fields
  //
  // "Required" means *observable somewhere the product promises*, so the same documented exemptions P2
  // applies must hold here too — otherwise the gate demands our SPA reproduce the stock Hamlet chrome
  // (361 `static.*` literals) and pages that are out of v1 scope by design (the UI2 inventory, the ATS
  // v2 services), and it would fail forever no matter how complete the product is. An item is exempt when
  // it is (a) waived, (b) inside a chrome section (`config.chromeSections`, PLAN.md §5: our chrome is
  // deliberately different), (c) on a page outside the P2 scope / declared out of scope, or (d) gated off
  // by its `when:` under this scenario's facts (e.g. `scheduler=fair`, `conf:yarn.webapp.ui1.tools.enable`).
  // A field stays required as soon as ONE non-exempt item carries it.
  const rendered = new Set();
  for (const cap of oursCaptures) for (const d of cap.datums ?? []) rendered.add(d.field);
  const chromeRe = (config?.chromeSections ?? []).map((r) => new RegExp(r));
  const chromeSection = (sectionId) => chromeRe.some((re) => re.test(sectionId));
  const inScopePage = (pageId) => !pageIdsInScope || pageIdsInScope.has(pageId);
  const required = [];
  for (const f of inventory.fields.values()) {
    if (f.status !== "required") continue;
    if (inventory.waivers.fields.has(f.id)) continue;
    if (waivedByGroup(inventory, f.id)) continue;
    required.push(f);
  }
  // Where each field is carried, per item (page/section/id/when), so the exemptions can be applied per item.
  const itemsByField = new Map();
  for (const p of inventory.pages) {
    for (const s of p.sections) {
      for (const it of s.items) {
        if (!it.field) continue;
        if (!itemsByField.has(it.field)) itemsByField.set(it.field, []);
        itemsByField.get(it.field).push({ page: p.id, section: s.id, when: it.when ?? [], sectionWhen: s.when ?? [] });
      }
    }
  }
  // Fields no legacy page item carries are REST *sources* (consumed by a derived text) or registry rows
  // from the secondary inventories that v1 deliberately does not reproduce: the ATS v2 application
  // services (`ats*`, PLAN.md scope) and the UI2 inventory (`ui2.*`, P0-only). Requiring the SPA to tag a
  // field that no compared page renders would make the gate unfalsifiable, so those are exempt by
  // category — `static.*` is the stock Hamlet chrome, which PLAN.md §5 says we replace.
  const outOfSurface = (f) => f.origin === "static" || /^ats/.test(f.id) || /^ui2\./.test(f.id);
  // An item whose `when:` the harness cannot evaluate (e.g. `other:app.resourceRequests != null` — the RM's
  // internal attempt object is not in any REST payload) is *conditionally* rendered by design: demanding it be
  // tagged during a crawl where the condition is false would demand the impossible. It is still compared by P2
  // whenever both sides render it, and the unevaluated condition stays visible in the report warnings.
  const whenState = (conds) => (conds?.length ? evalWhen(conds, { facts: scenario.facts }) : { gated: false, unevaluated: [] });
  const exemptItem = (it) => {
    const w = whenState(it.when);
    const sw = whenState(it.sectionWhen);
    return (
      sw.unevaluated.length > 0 ||
      sw.gated ||
      chromeSection(it.section) ||
      !inScopePage(it.page) ||
      outOfScope.has(it.page) ||
      gatedPages.has(it.page) ||
      nonHtmlPages.has(it.page) ||
      w.gated ||
      w.unevaluated.length > 0
    );
  };
  const pagesByField = new Map();
  for (const [field, items] of itemsByField) pagesByField.set(field, new Set(items.map((i) => i.page)));
  // A required registry field that no page item carries is a REST *source* (a leaf of a composite the SPA
  // renders, e.g. `queue.minResources.vCores` inside the `queue.minResources` object, or a map consumed by a
  // derived text). It is still part of P1's key coverage, but requiring a separate DOM tag for it would be
  // requiring us to render an internal path nobody displays. Reported separately, never silently dropped.
  const sourceOnly = (f) => !(itemsByField.get(f.id) ?? []).length;
  // `config.fieldAliases` (e.g. attempt.startedTime -> attempt.startTime): our DOM carries the target id,
  // so a required field is observable when its alias target is. Applied before anything is called a gap.
  const aliases = config?.fieldAliases ?? {};
  const isRendered = (id) => rendered.has(id) || (aliases[id] ? rendered.has(aliases[id]) : false);
  const unrenderedRequired = required
    .filter((f) => !outOfSurface(f))
    .filter((f) => !isRendered(f.id))
    .filter((f) => {
      const items = itemsByField.get(f.id) ?? [];
      if (!items.length) return false; // REST source / registry row: see sourceOnlyRequired
      return !items.every(exemptItem);
    })
    .map((f) => {
      const items = itemsByField.get(f.id) ?? [];
      const inScope = items.filter((i) => !exemptItem(i));
      return {
        id: f.id,
        entity: f.entity,
        pages: [...new Set((inScope.length ? inScope : items).map((i) => i.page))],
        origin: f.origin,
        restGap: !!f.restGap,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const sourceOnlyRequired = required.filter((f) => !isRendered(f.id) && sourceOnly(f) && !outOfSurface(f)).map((f) => f.id).sort();
  const result = {
    generatedAt: new Date().toISOString(),
    scenario: scenario.id,
    contractSource: "docs/contracts/api.md §3",
    resources,
    observedKeyCount: observedKeys.length,
    declaredKeyCount: declared.size,
    declaredSuffixCount: declaredSuffixes.size,
    observedKeys,
    unknownKeys,
    requiredCount: required.length,
    renderedCount: rendered.size,
    renderedFields: [...rendered].sort(),
    unrenderedRequired,
    sourceOnlyRequired,
    resourceTotals: tally(resources.map((r) => String(r.status))),
    digests: {
      observed: sha1short(observedKeys.join("\n")),
      rendered: sha1short([...rendered].sort().join("\n")),
      unknown: sha1short(unknownKeys.map((k) => k.key).join("\n")),
    },
  };
  if (reportDir) {
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, "coverage.json"), `${JSON.stringify(result, null, 1)}\n`);
  }
  log(
    `P1 coverage: ${resources.length} resources, ${observedKeys.length} observed keys, ${declared.size} declared, ` +
      `${unknownKeys.length} unknown, ${required.length} required, ${unrenderedRequired.length} unrendered`
  );
  if (strict && (unknownKeys.length || unrenderedRequired.length)) {
    log(`P1 STRICT: ${unknownKeys.length} unknown keys, ${unrenderedRequired.length} unrendered required fields`);
  }
  return result;
}

export async function loadOursCapturesFromDir(fixtureDir, scenarioId) {
  const dir = path.join(fixtureDir, scenarioId, "ours");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    out.push({ routeKey: j.routeKey ?? f, datums: j.datums ?? [] });
  }
  return out;
}

/* ------------------------------- CLI ------------------------------- */

async function main(argv) {
  // P1 needs the same scenario gates and real DOM crawl as the full harness. The previous CLI
  // ignored --ours and passed no captures, so it could never prove required fields were rendered.
  const { coverage, summary } = await runParity({ ...argv, stages: "p1" });
  console.log(JSON.stringify({ observed: coverage.observedKeyCount, unknown: coverage.unknownKeys.length,
    unrenderedRequired: coverage.unrenderedRequired.length }, null, 1));
  process.exitCode = summary.exitCode;
}

if (import.meta.main) {
  const argv = parseArgs(process.argv.slice(2));
  await main(argv);
}

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
