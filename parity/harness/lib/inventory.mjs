// Inventory loader: parity/inventory/** -> flat { pages, fields, waivers, issues }.
//
// Sources, in preference order (FORMAT.md "Layout"):
//   1. parity/inventory/legacy-pages.yaml  (+ ui2.yaml)     -- generated merges
//   2. parity/inventory/field-ids.yaml                       -- generated registry
// Fallback while the inventory slice is still writing them: the mergeable parts
//   parity/inventory/src/legacy-*.yaml · src/rest-*.yaml · src/field-overrides.yaml
//
// The loader is resilient (it can run against half-written sources) but strict about what it
// does read: bad YAML, wrong shapes, duplicate ids and dangling field references are all
// reported as `issues` (or thrown, with `--strict-inventory`).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { canonicalPath, sha1short } from "./util.mjs";

/** Entity ids are fixed by docs/contracts/parity-dom.md (the inventory is the authority, this is
 *  only a fallback for prefix matching when the registry is not built yet). */
export const CONTRACT_ENTITIES = [
  "cluster.info", "cluster.metrics", "scheduler", "queue", "app", "attempt", "container",
  "node", "nodelabel", "appstat", "conf", "spark.app", "spark.job", "spark.stage", "spark.task",
  "spark.executor", "spark.rdd", "spark.sql", "spark.env", "log",
];

export class InventoryError extends Error {}

function readYaml(file, onInvalid = null) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new InventoryError(`inventory: cannot read ${file}: ${e.message}`);
  }
  try {
    return YAML.parse(text, { prettyErrors: true }) ?? {};
  } catch (e) {
    // The inventory slice is still writing these files: a broken part must be loud, but must not
    // stop the rest of the gate from running. `--strict-inventory` turns this into a hard failure.
    if (onInvalid) {
      onInvalid(file, e);
      return null;
    }
    throw new InventoryError(`inventory: invalid YAML in ${file}: ${e.message}`);
  }
}

function listIfExists(dir, re) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

export function loadInventory(repoRoot, { strict = false, dir = "parity/inventory" } = {}) {
  const invDir = path.isAbsolute(dir) ? dir : path.join(repoRoot, dir);
  const srcDir = path.join(invDir, "src");
  const issues = [];
  const pushIssue = (kind, detail) => issues.push({ kind, detail });
  const fatal = (msg) => {
    if (strict) throw new InventoryError(msg);
    pushIssue("inventory-incomplete", msg);
  };

  const mergedPagesFile = path.join(invDir, "legacy-pages.yaml");
  const ui2File = path.join(invDir, "ui2.yaml");
  const registryFile = path.join(invDir, "field-ids.yaml");

  const pageFiles = [];
  if (fs.existsSync(mergedPagesFile)) pageFiles.push(mergedPagesFile);
  else pageFiles.push(...listIfExists(srcDir, /^legacy-.*\.yaml$/));
  if (fs.existsSync(ui2File)) pageFiles.push(ui2File);
  if (!pageFiles.length) {
    throw new InventoryError(
      `inventory: no page files found. Looked for ${mergedPagesFile} and ${srcDir}/legacy-*.yaml`
    );
  }

  const restFiles = listIfExists(srcDir, /^rest-.*\.yaml$/);
  const overridesFile = path.join(srcDir, "field-overrides.yaml");

  // ---------------------------------------------------------------- rest parts -> field ids
  const partEntities = new Map(); // entity id -> {description, roots}
  const objects = new Map(); // object name -> spec
  const resources = new Map(); // resource id -> spec
  const onInvalidPart = (file, e) => {
    pushIssue("inventory-invalid-file", `${rel(repoRoot, file)}: ${String(e.message).split("\n")[0]} — file skipped`);
    if (strict) throw new InventoryError(`inventory: invalid YAML in ${file}: ${e.message}`);
  };
  for (const file of restFiles) {
    const doc = readYaml(file, onInvalidPart);
    if (!doc) continue;
    for (const ent of doc.entities ?? []) {
      if (!ent?.id) {
        pushIssue("rest-part", `${path.basename(file)}: entity without id`);
        continue;
      }
      if (partEntities.has(ent.id)) pushIssue("duplicate-entity", `${ent.id} (${path.basename(file)})`);
      partEntities.set(ent.id, { ...ent, file: rel(repoRoot, file) });
    }
    for (const [name, spec] of Object.entries(doc.objects ?? {})) {
      if (objects.has(name)) pushIssue("duplicate-object", `${name} (${path.basename(file)})`);
      objects.set(name, { ...spec, name, file: rel(repoRoot, file) });
    }
    for (const res of doc.resources ?? []) {
      if (!res?.id) {
        pushIssue("rest-part", `${path.basename(file)}: resource without id`);
        continue;
      }
      resources.set(res.id, { ...res, file: rel(repoRoot, file) });
    }
  }

  /** Flatten one entity root object into field-id rows. */
  function flattenEntity(entityId, root, out, issuesOut) {
    const jsonPath = root.jsonPath ?? "";
    const seen = new Set();
    const walk = (objectName, prefix, trail) => {
      if (trail.length > 12) return;
      if (trail.includes(objectName)) return; // cycle guard for recursive DAOs
      const obj = objects.get(objectName);
      if (!obj) {
        pushIssue("dangling-object", `${entityId}: root/ref object "${objectName}" not defined by any rest part`);
        return;
      }
      const nextTrail = [...trail, objectName];
      if (obj.extends) walk(obj.extends, prefix, nextTrail);
      for (const f of obj.fields ?? []) {
        if (!f?.name) continue;
        const p = prefix ? `${prefix}.${f.name}` : f.name;
        const isEntityRoot =
          f.ref && [...partEntities.values()].some((e) => (e.roots ?? []).some((r) => r.object === f.ref));
        if (f.type === "object" && f.ref && !isEntityRoot) {
          walk(f.ref, p, nextTrail);
          continue;
        }
        if (f.type === "map" && f.ref) {
          walk(f.ref, `${p}.*`, nextTrail);
          continue;
        }
        if (f.ref && isEntityRoot) continue; // nested entity: not part of the parent (FORMAT.md)
        const id = `${entityId}.${p}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.set(id, {
          id,
          entity: entityId,
          path: p,
          origin: "rest",
          type: f.type ?? "any",
          unit: f.unit ?? null,
          nullable: !!f.nullable,
          when: f.when ?? [],
          values: f.values ?? [],
          ref: f.ref ?? null,
          array: !!f.array,
          rest: absPaths(jsonPath, p),
          source: f.source ?? obj.source ?? null,
          note: f.note ?? "",
          status: null,
          waiver: null,
        });
      }
    };
    walk(root.object, "", []);
  }

  const fields = new Map();
  for (const [entId, ent] of partEntities) {
    for (const root of ent.roots ?? []) {
      if (!root.object) {
        pushIssue("entity-root", `${entId}: root without object`);
        continue;
      }
      flattenEntity(entId, root, fields, issues);
    }
  }

  // ---------------------------------------------------------------- pages (+ derived fields)
  const pagesById = new Map();
  const derivedDecls = new Map();
  for (const file of pageFiles) {
    const doc = readYaml(file, onInvalidPart);
    if (!doc) continue;
    for (const d of doc.derived ?? []) {
      if (!d?.id) {
        pushIssue("derived", `${path.basename(file)}: derived row without id`);
        continue;
      }
      if (derivedDecls.has(d.id)) pushIssue("duplicate-derived", `${d.id} (${path.basename(file)})`);
      derivedDecls.set(d.id, { ...d, file: rel(repoRoot, file) });
      if (!fields.has(d.id)) {
        fields.set(d.id, {
          id: d.id,
          entity: d.entity ?? entityPrefixFallback(d.id),
          path: d.id.split(".").slice(1).join("."),
          origin: "derived",
          type: d.type ?? "string",
          unit: d.unit ?? null,
          nullable: true,
          when: d.when ?? [],
          values: [],
          ref: null,
          array: false,
          rest: [],
          source: d.source ?? null,
          note: d.note ?? "",
          derivation: d.derivation ?? "",
          from: d.from ?? [],
          restGap: !!d.restGap,
          altSource: d.altSource ?? null,
          status: null,
          waiver: null,
        });
      }
    }
    const docPages = doc.pages ?? [];
    if (!Array.isArray(docPages)) throw new InventoryError(`inventory: ${file}: "pages" must be a list`);
    for (const p of docPages) {
      if (!p?.id) {
        pushIssue("page", `${path.basename(file)}: page without id`);
        continue;
      }
      if (pagesById.has(p.id)) pushIssue("duplicate-page", `${p.id} (${path.basename(file)})`);
      const page = {
        id: p.id,
        daemon: p.daemon ?? "rm",
        route: p.route ?? null,
        title: p.title ?? null,
        titleDynamic: !!p.titleDynamic,
        classes: p.classes ?? [],
        when: p.when ?? [],
        includes: p.includes ?? [],
        query: p.query ?? [],
        file: rel(repoRoot, file),
        sections: (p.sections ?? []).map((s, si) => ({
          id: s.id ?? `${p.id}.section${si}`,
          title: s.title ?? null,
          source: s.source ?? null,
          when: s.when ?? [],
          scenario: s.scenario ?? null,
          items: (s.items ?? []).map((it, ii) => normaliseItem(p, s, it, ii, pushIssue)),
        })),
      };
      pagesById.set(p.id, page);
    }
  }
  if (!pagesById.size) {
    throw new InventoryError(`inventory: no pages found in ${pageFiles.map((f) => rel(repoRoot, f)).join(", ")}`);
  }

  // resolve `includes:` (shared chrome/metrics blocks rendered inside a page)
  const resolveIncludes = (page, stack = []) => {
    if (stack.includes(page.id)) {
      pushIssue("include-cycle", `${[...stack, page.id].join(" -> ")}`);
      return page;
    }
    const sections = [];
    const seenItemIds = new Set();
    const addSections = (secs) => {
      for (const s of secs) {
        const items = s.items.filter((it) => {
          if (seenItemIds.has(it.id)) return false;
          seenItemIds.add(it.id);
          return true;
        });
        if (!items.length) continue;
        sections.push({ ...s, items, id: seenItemIds.size && s.id ? s.id : s.id });
      }
    };
    for (const incId of page.includes ?? []) {
      const inc = pagesById.get(incId);
      if (!inc) {
        pushIssue("dangling-include", `${page.id} includes unknown page ${incId}`);
        continue;
      }
      const resolved = resolveIncludes(inc, [...stack, page.id]);
      addSections(resolved.sections);
    }
    addSections(page.sections);
    return { ...page, sections };
  };
  const pages = [...pagesById.values()].map((p) => {
    const r = resolveIncludes(p);
    return { ...r, standalone: typeof r.route === "string" && r.route.startsWith("/") };
  });

  // ---------------------------------------------------------------- registry overrides + waivers
  const overrides = fs.existsSync(overridesFile) ? readYaml(overridesFile, onInvalidPart) : {};
  const overrideRows = new Map();
  // `fields:` may be a list of rows or a map keyed by field id (src/field-overrides.yaml uses both
  // conventions across revisions — accept both rather than guessing).
  const overrideEntries = Array.isArray(overrides.fields)
    ? (overrides.fields ?? []).map((r) => [r?.id, r])
    : Object.entries(overrides.fields ?? overrides.rows ?? {});
  for (const [id, row] of overrideEntries) {
    if (!id || !row || typeof row !== "object") {
      pushIssue("override", `${path.basename(overridesFile)}: entry without a usable id`);
      continue;
    }
    overrideRows.set(id, { ...row, id });
  }
  // prefix-based waiver groups (`groups:`) and REST paths that deliberately have no field id
  // (`unmappedPaths:`) are the inventory's own waiver channels; both are honoured by P1 and P2.
  const groupWaivers = [];
  for (const [i, g] of (overrides.groups ?? []).entries()) {
    if (!g?.prefixes?.length || !g.category || !g.reason) {
      pushIssue("override-group", `${path.basename(overridesFile)}:groups[${i}] needs prefixes + category + reason`);
      continue;
    }
    groupWaivers.push(g);
  }
  const unmappedPathWaivers = [];
  for (const [i, u] of (overrides.unmappedPaths ?? []).entries()) {
    if (!u?.path || !u.category || !u.reason) {
      pushIssue("override-unmapped-path", `${path.basename(overridesFile)}:unmappedPaths[${i}] needs path + category + reason`);
      continue;
    }
    unmappedPathWaivers.push({ key: u.path, category: u.category, reason: u.reason, from: "field-overrides.yaml" });
  }
  if (fs.existsSync(registryFile)) {
    const reg = readYaml(registryFile);
    const rows = reg.fields ?? reg;
    if (!Array.isArray(rows)) throw new InventoryError(`inventory: ${registryFile}: expected a list of field rows`);
    for (const row of rows) {
      if (!row?.id) {
        pushIssue("registry", `${path.basename(registryFile)}: row without id`);
        continue;
      }
      const base = fields.get(row.id) ?? {};
      fields.set(row.id, { ...base, ...row, id: row.id, origin: row.origin ?? base.origin ?? "rest" });
    }
  }
  for (const [id, row] of overrideRows) {
    const base = fields.get(id);
    if (!base) {
      pushIssue("override-unknown-field", `${id} overridden but not declared by any rest part/derived row`);
      fields.set(id, { id, entity: entityPrefixFallback(id), origin: "rest", rest: [], when: [], ...row });
      continue;
    }
    fields.set(id, { ...base, ...row, id });
  }

  // status heuristic when field-ids.yaml is not built yet: referenced by an item => required.
  const referenced = new Set();
  for (const p of pages) for (const s of p.sections) for (const it of s.items) {
    if (it.field) referenced.add(it.field);
    for (const f of it.fields ?? []) referenced.add(f);
  }

  // waivers: parity/waivers.yaml is authoritative; registry rows may carry an inline waiver.
  const waiverFile = path.join(repoRoot, "parity", "waivers.yaml");
  const waivers = { fields: new Map(), items: new Map(), keys: new Map(), raw: null, file: rel(repoRoot, waiverFile) };
  if (fs.existsSync(waiverFile)) {
    const w = readYaml(waiverFile);
    waivers.raw = w;
    if (w.version !== 1) pushIssue("waivers", `${waivers.file}: version must be 1`);
    for (const [i, entry] of (w.waivers ?? []).entries()) {
      const where = `${waivers.file}:waivers[${i}]`;
      if (!entry || typeof entry !== "object") {
        pushIssue("waivers", `${where}: entry must be a mapping`);
        continue;
      }
      if (!entry.category) pushIssue("waivers", `${where}: missing category`);
      if (!entry.reason) pushIssue("waivers", `${where}: missing reason`);
      if (entry.fieldId) waivers.fields.set(entry.fieldId, entry);
      else if (entry.page && entry.label) waivers.items.set(`${entry.page}\u0000${entry.label}`, entry);
      else if (entry.key) waivers.keys.set(canonicalPath(entry.key), entry);
      else pushIssue("waivers", `${where}: needs fieldId | (page + label) | key`);
    }
    for (const [i, entry] of (w.keys ?? []).entries()) {
      if (!entry?.key) {
        pushIssue("waivers", `${waivers.file}:keys[${i}]: missing key`);
        continue;
      }
      waivers.keys.set(canonicalPath(entry.key), entry);
    }
  } else {
    pushIssue("waivers-missing", `${waivers.file} does not exist; no waivers in effect`);
  }
  for (const u of unmappedPathWaivers) {
    const ck = canonicalPath(u.key);
    if (!waivers.keys.has(ck)) waivers.keys.set(ck, u);
  }
  waivers.groups = groupWaivers;

  // ---------------------------------------------------------------- validate + finalise fields
  for (const p of pages) {
    for (const s of p.sections) {
      for (const it of s.items) {
        for (const fid of [it.field, ...(it.fields ?? [])]) {
          if (!fid) continue;
          if (fid.startsWith("static.") && !fields.has(fid)) {
            // FORMAT.md: `static.<name>` items are declared automatically, never REST fields.
            fields.set(fid, {
              id: fid, entity: "static", path: fid.slice("static.".length), origin: "static",
              type: "any", unit: null, nullable: true, when: [], values: [], ref: null, array: false,
              rest: [], source: it.source ?? null, note: it.note ?? "", status: "waivable", waiver: null,
            });
            continue;
          }
          if (!fields.has(fid)) {
            fatal(`item ${it.id} references field "${fid}" which is not declared by any rest part or derived row`);
            // register a stub so the report can still render the row, flagged as unresolved
            fields.set(fid, {
              id: fid, entity: entityPrefixFallback(fid), path: fid.split(".").slice(1).join("."),
              origin: "unresolved", rest: [], when: [], type: "any", unresolved: true,
            });
          }
        }
      }
    }
  }
  for (const [id, f] of fields) {
    if (f.status) continue;
    f.status = referenced.has(id) ? "required" : "waivable";
  }
  for (const row of overrideRows.values()) {
    const f = fields.get(row.id);
    if (f && row.status) f.status = row.status;
  }

  const entities = new Set([...partEntities.keys(), "static", ...CONTRACT_ENTITIES]);
  for (const f of fields.values()) if (f.entity) entities.add(f.entity);

  return {
    repoRoot,
    dir: rel(repoRoot, invDir),
    pageFiles: pageFiles.map((f) => rel(repoRoot, f)),
    restFiles: restFiles.map((f) => rel(repoRoot, f)),
    registryFile: fs.existsSync(registryFile) ? rel(repoRoot, registryFile) : null,
    merged: fs.existsSync(mergedPagesFile),
    pages,
    fields,
    entities,
    resources,
    waivers,
    issues,
    digest: sha1short(JSON.stringify([...fields.keys()].sort()) + pages.map((p) => p.id).join(",")),
  };
}

function normaliseItem(page, section, it, idx, pushIssue) {
  if (!it || typeof it !== "object" || !it.id) {
    pushIssue("item", `${page.id}/${section.id}: item[${idx}] has no id`);
  }
  return {
    id: it.id ?? `${page.id}.item${idx}`,
    page: page.id,
    section: section.id,
    sectionTitle: section.title ?? null,
    label: it.label ?? null,
    dynamic: !!it.dynamic,
    kind: it.kind ?? "kv",
    field: it.field ?? null,
    fields: it.fields ?? [],
    rest: it.rest ?? null,
    derivation: it.derivation ?? "",
    format: it.format ?? "none",
    normaliser: it.normaliser ?? "none",
    nullDisplay: it.nullDisplay ?? null,
    when: it.when ?? [],
    scenario: it.scenario ?? "",
    source: it.source ?? null,
    tooltip: it.tooltip ?? null,
    restGap: !!it.restGap,
    note: it.note ?? "",
  };
}

/** `cluster.info.id` -> `cluster.info` (known entity prefix, else contract list, else first seg). */
export function entityPrefixFallback(fieldId) {
  const s = String(fieldId);
  for (const e of [...CONTRACT_ENTITIES, "usermetrics", "clusteruser", "static"]) {
    if (s === e || s.startsWith(`${e}.`)) return e;
  }
  const first = s.split(".")[0];
  if (s.split(".")[1] === "info" || s.split(".")[1] === "metrics") return `${first}.${s.split(".")[1]}`;
  return first;
}

export function entityOf(fieldId, inventory) {
  const ids = [...inventory.entities].sort((a, b) => b.length - a.length);
  for (const e of ids) if (fieldId === e || fieldId.startsWith(`${e}.`)) return e;
  return entityPrefixFallback(fieldId);
}

/**
 * Prefix-based waivers declared in `src/field-overrides.yaml` -> `groups:`. Applies to field ids
 * (`appstat.`) and to canonical REST key paths alike, so P1 and P2 agree on what is waived.
 */
export function waivedByGroup(inventory, idOrKey) {
  if (!idOrKey) return null;
  for (const g of inventory.waivers?.groups ?? []) {
    for (const p of g.prefixes ?? []) {
      if (String(idOrKey) === p || String(idOrKey).startsWith(p)) return g;
    }
  }
  return null;
}

function absPaths(jsonPath, rel) {
  const root = (jsonPath ?? "").trim();
  const p = root ? `${root}.${rel}` : rel;
  return canonicalPath(p);
}

function rel(root, file) {
  return path.relative(root, file);
}

/** Resolve a route pattern against scenario params (`{appId}`, `{app.state}`, `{queue.name}` …). */
export function resolveRoute(route, params) {
  if (!route || !route.startsWith("/")) return null;
  return route.replace(/\{([^}]+)\}/g, (_, token) => {
    const key = paramAlias(token);
    return params[key] ?? "";
  });
}

export function routeTokens(route) {
  if (!route) return [];
  return [...String(route).matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

export function paramAlias(token) {
  const map = {
    appId: "appId",
    attemptId: "attemptId",
    containerId: "containerId",
    nodeId: "nodeId",
    "app.state": "state",
    app_state: "state",
    state: "state",
    "queue.name": "queue",
    queue: "queue",
    user: "user",
    "app.id": "appId",
    "attempt.id": "attemptId",
    "appattempt.id": "attemptId",
    "container.id": "containerId",
    "node.id": "nodeId",
    // a node-state facet (/cluster/nodes/{node.state}) is not the application-state facet scenarios carry as `state`
    "node.state": "nodeState",
    "app.name": "appId",
    "queue.path": "queue",
    filename: "logFile",
    file: "logFile",
  };
  if (map[token]) return map[token];
  const [head, tail] = String(token).split(".");
  if (!tail) return token;
  if (tail === "id") return `${head}Id`;
  if (tail === "name" && head === "queue") return "queue";
  if (tail === "state") return "state";
  if (tail === "path" && head === "queue") return "queue";
  return tail;
}

/** Route templates for the *legacy* UI use `|`-separated alternatives in the inventory. */
export function routeAlternatives(route) {
  if (!route) return [];
  return String(route)
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("/"));
}
