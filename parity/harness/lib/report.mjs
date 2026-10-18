// Report generation: parity/report/index.html (self-contained, dark/light) + summary.json
// + coverage.json + per-scenario JSON. Every row links to the raw capture it came from, so a
// reviewer can look at the actual legacy HTML / recorded DOM without re-running anything.
import fs from "node:fs";
import path from "node:path";
import { escapeHtml, tally, truncate } from "./util.mjs";

export const STATUS_STYLE = {
  match: { label: "match", cls: "ok" },
  waived: { label: "waived", cls: "waived" },
  "ours-only": { label: "ours-only", cls: "info" },
  "chrome-only": { label: "chrome-only", cls: "info" },
  "not-observable": { label: "not-observable", cls: "info" },
  "not-applicable": { label: "not-applicable", cls: "info" },
  "sampling-race": { label: "sampling-race", cls: "waived" },
  "not-captured": { label: "not-captured", cls: "warn" },
  "harness-uncovered": { label: "harness-uncovered", cls: "warn" },
  "legacy-only": { label: "legacy-only", cls: "bad" },
  mismatch: { label: "mismatch", cls: "bad" },
  absent: { label: "absent", cls: "warn" },
  unmapped: { label: "unmapped", cls: "warn" },
  "inventory-incomplete": { label: "inventory-incomplete", cls: "warn" },
};

/** Statuses that must not appear for the gate to pass. */
export const FAIL_ON = ["mismatch", "legacy-only", "absent", "unmapped", "inventory-incomplete"];

export function summarise({ compareByScenario, coverage, wire, inventory, meta }) {
  const totals = {};
  const perPage = {};
  const failing = [];
  const warnings = [];
  const skippedPages = [];
  const failOn = meta?.strictNotObservable ? [...FAIL_ON, "not-observable"] : FAIL_ON;
  for (const [scenarioId, res] of Object.entries(compareByScenario)) {
    for (const sp of res.skippedPages ?? []) skippedPages.push({ scenario: scenarioId, ...sp });
    for (const [k, v] of Object.entries(res.totals)) totals[k] = (totals[k] ?? 0) + v;
    for (const r of res.rows) {
      const key = `${scenarioId}\u0000${r.page}`;
      perPage[key] ??= {};
      perPage[key][r.status] = (perPage[key][r.status] ?? 0) + 1;
      if (failOn.includes(r.status)) {
        failing.push({
          scenario: scenarioId,
          page: r.page,
          section: r.section,
          item: r.item,
          label: r.label,
          field: r.field,
          status: r.status,
          detail: r.observations?.[0] ?? null,
          justification: r.justification ?? null,
        });
      }
    }
    for (const w of res.warnings ?? []) warnings.push({ scenario: scenarioId, ...w });
  }
  const inventoryIssues = (inventory?.issues ?? []).map((i) => ({ kind: i.kind, detail: i.detail }));
  const coverageFailing = coverage
    ? {
        unknownKeys: coverage.unknownKeys?.length ?? 0,
        unrenderedRequired: coverage.unrenderedRequired?.length ?? 0,
      }
    : null;
  const gate =
    failing.length === 0 &&
    inventoryIssues.length === 0 &&
    (coverageFailing ? coverageFailing.unknownKeys === 0 && coverageFailing.unrenderedRequired === 0 : true) &&
    (!wire || wire.status === "pass" || wire.status === "skipped");
  return {
    generatedAt: new Date().toISOString(),
    meta,
    totals,
    failing,
    warnings,
    inventoryIssues,
    skippedPages,
    skippedCaptures: meta?.skippedCaptures ?? [],
    scopeExcluded: meta?.scopeExcluded ?? [],
    coverage: coverage
      ? {
          resources: coverage.resources,
          observedKeys: coverage.observedKeyCount,
          declaredKeys: coverage.declaredKeyCount,
          unknownKeys: coverage.unknownKeys?.length ?? 0,
          requiredFields: coverage.requiredCount,
          renderedFields: coverage.renderedCount,
          unrenderedRequired: coverage.unrenderedRequired?.length ?? 0,
          digests: coverage.digests,
        }
      : null,
    wire: wire ?? null,
    gate: gate ? "pass" : "fail",
    exitCode: gate ? 0 : 1,
  };
}

function chip(status) {
  const s = STATUS_STYLE[status] ?? { label: status, cls: "warn" };
  return `<span class="chip ${s.cls}">${escapeHtml(s.label)}</span>`;
}

function cell(v, cls = "") {
  if (v === null || v === undefined) return `<td class="${cls} muted">—</td>`;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return `<td class="${cls}">${escapeHtml(truncate(s, 120))}</td>`;
}

export function renderHtml({ summary, compareByScenario, coverage, wire, meta }) {
  const css = `
:root{--bg:#0f1115;--fg:#e6e8eb;--muted:#8b949e;--card:#161b22;--line:#262c36;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--info:#58a6ff;--waived:#8b949e}
@media (prefers-color-scheme: light){:root{--bg:#f7f8fa;--fg:#111418;--muted:#5c6470;--card:#fff;--line:#e2e5ea;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--info:#0969da;--waived:#6e7781}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:20px 24px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:2}
h1{margin:0 0 6px;font-size:18px}
h2{margin:22px 0 8px;font-size:16px;border-bottom:1px solid var(--line);padding-bottom:6px}
h3{margin:16px 0 6px;font-size:14px;color:var(--muted)}
.sub{color:var(--muted);font-size:12px}
main{padding:0 24px 64px;max-width:1500px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--line);font-size:12px;white-space:nowrap}
.chip.ok{color:var(--ok);border-color:var(--ok)}
.chip.bad{color:var(--bad);border-color:var(--bad)}
.chip.warn{color:var(--warn);border-color:var(--warn)}
.chip.info{color:var(--info);border-color:var(--info)}
.chip.waived{color:var(--waived)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:8px 0 18px}
th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-variant-numeric:tabular-nums}
th{background:color-mix(in srgb,var(--card) 70%,var(--line));font-weight:600;font-size:12px;color:var(--muted);position:sticky;top:0}
td.muted{color:var(--muted)}
tr.bad{background:color-mix(in srgb,var(--bad) 8%,transparent)}
tr.warn{background:color-mix(in srgb,var(--warn) 8%,transparent)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
pre{background:var(--card);border:1px solid var(--line);padding:10px;border-radius:6px;overflow:auto;max-height:420px}
details{margin:4px 0 12px}
summary{cursor:pointer}
.gate-pass{color:var(--ok);font-weight:700}
.gate-fail{color:var(--bad);font-weight:700}
a{color:var(--info)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px 12px}
.card b{display:block;font-size:20px}
ul{margin:4px 0 12px 18px}
`;

  const parts = [];
  parts.push(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>burrow parity report</title><style>${css}</style>
<header>
<h1>burrow parity report</h1>
<div class="sub">generated ${escapeHtml(summary.generatedAt)} · gate <span class="${summary.gate === "pass" ? "gate-pass" : "gate-fail"}">${summary.gate.toUpperCase()}</span> · exit ${summary.exitCode}</div>
<div class="sub">harness mode: ${escapeHtml(meta.mode)}${meta.replayDir ? ` · fixtures ${escapeHtml(meta.replayDir)}` : ""}${meta.recordDir ? ` · recorded to ${escapeHtml(meta.recordDir)}` : ""} · RM ${escapeHtml(meta.rmBase ?? "—")} · legacy ${escapeHtml(meta.legacyBase ?? "—")} · ours ${escapeHtml(meta.oursBase ?? "—")}</div>
<div class="chips">${Object.entries(summary.totals)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${chip(k)} <b>${v}</b>`)
    .join(" ")}</div>
</header><main>`);

  // ---- headline numbers
  parts.push(`<h2>Totals</h2><div class="grid">
<div class="card"><span class="sub">inventory items compared</span><b>${Object.values(summary.totals).reduce((a, b) => a + b, 0)}</b></div>
<div class="card"><span class="sub">failures (${FAIL_ON.join(", ")})</span><b>${summary.failing.length}</b></div>
<div class="card"><span class="sub">inventory issues</span><b>${summary.inventoryIssues.length}</b></div>
<div class="card"><span class="sub">warnings</span><b>${summary.warnings.length}</b></div>
<div class="card"><span class="sub">inventory files</span><b>${escapeHtml((meta.inventoryFiles ?? []).join(" · "))}</b></div>
${(summary.scopeExcluded ?? []).length ? `<div class="card"><span class="sub">pages outside P2 scope (config/routes.yaml)</span><b>${summary.scopeExcluded.length}</b><div class="sub">${escapeHtml(summary.scopeExcluded.join(", "))}</div></div>` : ""}
${summary.coverage ? `<div class="card"><span class="sub">REST keys observed / declared / unknown</span><b>${summary.coverage.observedKeys} / ${summary.coverage.declaredKeys} / ${summary.coverage.unknownKeys}</b></div>
<div class="card"><span class="sub">required fields rendered / unrendered</span><b>${summary.coverage.renderedFields} / ${summary.coverage.unrenderedRequired}</b></div>` : ""}
${wire ? `<div class="card"><span class="sub">P3 wire fidelity</span><b>${escapeHtml(wire.status)}</b><div class="sub">${escapeHtml(wire.reason ?? `${wire.compared ?? 0} endpoints compared`)}</div></div>` : ""}
</div>`);

  // ---- inventory issues
  if (summary.inventoryIssues.length) {
    parts.push(`<h2>Inventory issues (blockers)</h2><table><tr><th>kind</th><th>detail</th></tr>${summary.inventoryIssues
      .slice(0, 400)
      .map((i) => `<tr class="warn"><td>${escapeHtml(i.kind)}</td><td>${escapeHtml(truncate(i.detail, 220))}</td></tr>`)
      .join("")}</table>`);
  }

  if ((summary.skippedPages ?? []).length) {
    parts.push(
      `<h2>Pages skipped by their own conditions</h2><table><tr><th>scenario</th><th>page</th><th>reason</th></tr>${summary.skippedPages
        .map((s) => `<tr><td>${escapeHtml(s.scenario)}</td><td><code>${escapeHtml(s.page)}</code></td><td>${escapeHtml(s.reason)}</td></tr>`)
        .join("")}</table>`
    );
  }

  // ---- per scenario / page
  for (const [scenarioId, res] of Object.entries(compareByScenario)) {
    parts.push(`<h2>Scenario ${escapeHtml(scenarioId)}</h2>`);
    parts.push(`<div class="chips">${Object.entries(res.totals)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${chip(k)} <b>${v}</b>`)
      .join(" ")}</div>`);
    const byPage = new Map();
    for (const r of res.rows) {
      if (!byPage.has(r.page)) byPage.set(r.page, []);
      byPage.get(r.page).push(r);
    }
    for (const [pageId, rows] of byPage) {
      const counts = tally(rows.map((r) => r.status));
      const open = rows.some((r) => FAIL_ON.includes(r.status));
      parts.push(`<details ${open ? "open" : ""}><summary><b>${escapeHtml(pageId)}</b> ${Object.entries(counts)
        .map(([k, v]) => `${chip(k)} ${v}`)
        .join(" ")}</summary>`);
      const bySection = new Map();
      for (const r of rows) {
        if (!bySection.has(r.section)) bySection.set(r.section, []);
        bySection.get(r.section).push(r);
      }
      for (const [sectionId, srows] of bySection) {
        parts.push(`<h3>${escapeHtml(sectionId)}${srows[0].sectionTitle ? ` — ${escapeHtml(srows[0].sectionTitle)}` : ""}</h3>`);
        parts.push(`<table><tr><th>status</th><th>label</th><th>field</th><th>legacy</th><th>canonical</th><th>ours raw</th><th>ours text</th><th>rest</th><th>notes</th></tr>`);
        for (const r of srows) {
          const o = r.observations?.[0] ?? null;
          const cls = STATUS_STYLE[r.status]?.cls ?? "warn";
          parts.push(
            `<tr class="${cls}"><td>${chip(r.status)}</td><td>${escapeHtml(r.label ?? "—")}${
              r.kind ? ` <span class="sub">${escapeHtml(r.kind)}</span>` : ""
            }</td><td><code>${escapeHtml(r.field ?? "—")}</code></td>` +
              cell(o?.legacyText ?? null) +
              cell(o?.canonical ?? null) +
              cell(o?.oursRaw ?? null) +
              cell(o?.oursText ?? null) +
              cell(
                o?.restValue !== undefined && o?.restValue !== null
                  ? `${typeof o.restValue === "object" ? JSON.stringify(o.restValue) : o.restValue}${o.restHow ? ` (${o.restHow})` : ""}`
                  : null
              ) +
              `<td>${escapeHtml(
                [
                  o?.reason,
                  o?.embeddedDisagrees ? `embedded≠dom: ${JSON.stringify(o.embeddedDisagrees)}` : null,
                  (r.normaliser && r.normaliser !== "none") ? `norm=${r.normaliser}` : null,
                  o?.normaliserNotes?.join(" "),
                  r.when?.length ? `when=${r.when.join("&")}` : null,
                  r.restGap ? "restGap" : null,
                  r.justification,
                  o?.hint,
                  r.oursError ? `ours: ${r.oursError}` : null,
                  r.occurrences && r.occurrences > 1 ? `×${r.occurrences}` : null,
                ]
                  .filter(Boolean)
                  .join(" | ")
              )}</td></tr>`
          );
        }
        parts.push("</table>");
      }
      parts.push(`</details>`);
    }
    if (res.warnings?.length) {
      parts.push(`<details><summary>${res.warnings.length} harness warnings</summary><ul>${res.warnings
        .slice(0, 200)
        .map((w) => `<li>${escapeHtml(JSON.stringify(w).slice(0, 260))}</li>`)
        .join("")}</ul></details>`);
    }
  }

  if (coverage) {
    parts.push(`<h2>P1 — REST key coverage</h2>`);
    parts.push(`<div class="grid">
<div class="card"><span class="sub">resources fetched</span><b>${coverage.resources.length}</b></div>
<div class="card"><span class="sub">distinct key paths observed</span><b>${coverage.observedKeyCount}</b></div>
<div class="card"><span class="sub">declared by the inventory</span><b>${coverage.declaredKeyCount}</b></div>
<div class="card"><span class="sub">unknown keys (fail)</span><b>${coverage.unknownKeys.length}</b></div>
<div class="card"><span class="sub">required fields</span><b>${coverage.requiredCount}</b></div>
<div class="card"><span class="sub">rendered by DOM crawl</span><b>${coverage.renderedCount}</b></div>
<div class="card"><span class="sub">unrendered required (fail)</span><b>${coverage.unrenderedRequired.length}</b></div></div>`);
    parts.push(`<h3>observed ⊆ declared ∪ waivers — unknown keys</h3><table><tr><th>key</th><th>resource</th><th>types</th><th>sample</th></tr>${
      coverage.unknownKeys.length
        ? coverage.unknownKeys.map((k) => `<tr class="warn"><td><code>${escapeHtml(k.key)}</code></td><td>${escapeHtml(k.resource)}</td><td>${escapeHtml((k.types ?? []).join(","))}</td><td>${escapeHtml(truncate(JSON.stringify(k.sample), 120))}</td></tr>`).join("")
        : `<tr><td colspan="4">none</td></tr>`
    }</table>`);
    parts.push(`<h3>required ∪ waivers ⊆ rendered — unrendered required fields</h3><table><tr><th>field</th><th>entity</th><th>pages</th></tr>${
      coverage.unrenderedRequired.length
        ? coverage.unrenderedRequired.map((f) => `<tr class="bad"><td><code>${escapeHtml(f.id)}</code></td><td>${escapeHtml(f.entity ?? "")}</td><td>${escapeHtml((f.pages ?? []).join(", "))}</td></tr>`).join("")
        : `<tr><td colspan="3">none</td></tr>`
    }</table>`);
    parts.push(`<details><summary>per-resource key counts</summary><table><tr><th>resource</th><th>status</th><th>keys</th><th>url</th></tr>${coverage.resources
      .map((r) => `<tr><td>${escapeHtml(r.id ?? r.path)}</td><td>${escapeHtml(String(r.status))}</td><td>${r.keyCount ?? 0}</td><td class="sub">${escapeHtml(r.url)}</td></tr>`)
      .join("")}</table></details>`);
  }

  if (wire) {
    parts.push(`<h2>P3 — wire fidelity</h2><div class="card"><b>${escapeHtml(wire.status)}</b>
<div class="sub">${escapeHtml(wire.reason ?? "")}</div>
<div class="sub">compared ${wire.compared ?? 0} endpoints · mismatches ${wire.mismatches?.length ?? 0} · skipped ${wire.skipped?.length ?? 0}</div></div>`);
    if (wire.samplingRaces?.length) {
      parts.push(`<details open><summary>${wire.samplingRaces.length} live sampling races (weaker proof)</summary><ul>${wire.samplingRaces
        .map((s) => `<li><code>${escapeHtml(s.path)}</code> ${escapeHtml(s.reason)}</li>`)
        .join("")}</ul></details>`);
    }
    if (wire.mismatches?.length) {
      parts.push(`<details open><summary>${wire.mismatches.length} mismatching endpoints</summary><table><tr><th>path</th><th>diff</th></tr>${wire.mismatches
        .slice(0, 100)
        .map((m) => `<tr class="bad"><td><code>${escapeHtml(m.path)}</code></td><td><pre>${escapeHtml(truncate(JSON.stringify(m.diff, null, 1), 800))}</pre></td></tr>`)
        .join("")}</table></details>`);
    }
    if (wire.skipped?.length) {
      parts.push(`<details><summary>${wire.skipped.length} skipped</summary><ul>${wire.skipped
        .slice(0, 100)
        .map((s) => `<li><code>${escapeHtml(s.path)}</code> ${escapeHtml(s.reason)}</li>`)
        .join("")}</ul></details>`);
    }
  }

  if (summary.warnings.length) {
    parts.push(`<h2>Harness warnings</h2><table><tr><th>scenario</th><th>page</th><th>item</th><th>kind</th><th>detail</th></tr>${summary.warnings
      .slice(0, 300)
      .map((w) => `<tr class="warn"><td>${escapeHtml(w.scenario ?? "")}</td><td>${escapeHtml(w.page ?? "")}</td><td>${escapeHtml(w.item ?? "")}</td><td>${escapeHtml(w.kind ?? "")}</td><td>${escapeHtml(truncate(w.detail ?? "", 200))}</td></tr>`)
      .join("")}</table>`);
  }

  parts.push(`<h2>Raw captures</h2><ul>${(meta.rawLinks ?? [])
    .slice(0, 200)
    .map((l) => `<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></li>`)
    .join("")}</ul>`);

  parts.push(`</main></html>`);
  return parts.join("\n");
}

export function writeReport({ reportDir, summary, compareByScenario, coverage, wire, meta }) {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "index.html"), renderHtml({ summary, compareByScenario, coverage, wire, meta }));
  fs.writeFileSync(path.join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
  if (coverage) fs.writeFileSync(path.join(reportDir, "coverage.json"), `${JSON.stringify(coverage, null, 1)}\n`);
  const dir = path.join(reportDir, "scenarios");
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, res] of Object.entries(compareByScenario)) {
    fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(res, null, 1)}\n`);
  }
  return { index: path.join(reportDir, "index.html"), summary: path.join(reportDir, "summary.json") };
}
