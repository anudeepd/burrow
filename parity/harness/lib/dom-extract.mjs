// Browser-side DOM extraction for the stock (Hamlet) YARN UI.
//
// This function is serialised by Playwright and evaluated in the page, so it MUST be entirely
// self-contained (no imports, no closure over module scope). The same function is used for live
// scraping and for replaying recorded `page.content()` HTML, which is what makes the replay path
// faithful rather than a second implementation.
//
// Verified against Hadoop 3.4.3 live UI: `table#layout`, `div#nav`, `div#user`,
// metrics tables `#metricsoverview`/`#nodemetricsoverview`/`#schedulermetricsoverview`,
// `var appsTableData = [...]` / `var nodeTableData = [...]` DataTables sources,
// `table.info` th/td label pairs on /cluster/app & /cluster/appattempt,
// `table#nodelabels`, `table#userinfo`, `table#apps`, `table#health`, `table#lastrun`,
// `#Preemption|#Reservation|#Allocation|#Release`, `div#cs-wrapper`.

export function extractLegacyDom() {
  const norm = (s) => (s == null ? "" : String(s).replace(/\s+/g, " ").trim());
  const txt = (el) => (el ? norm(el.textContent) : "");
  const attr = (el, a) => (el && el.getAttribute ? el.getAttribute(a) : null);
  const firstHref = (el) => {
    if (!el) return null;
    const a = el.querySelector ? el.querySelector("a[href]") : null;
    return a ? a.getAttribute("href") : null;
  };
  const titleOf = (el) => {
    if (!el) return null;
    const t = attr(el, "title");
    if (t) return t;
    const inner = el.querySelector ? el.querySelector("[title]") : null;
    return inner ? attr(inner, "title") : null;
  };

  /** Bracket-counting scan of a JS array/object literal starting at `i` (index of '['). */
  function scanLiteral(text, i) {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (c === '"' || c === "'") {
        const q = c;
        j++;
        while (j < text.length && text[j] !== q) {
          if (text[j] === "\\") j++;
          j++;
        }
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) return text.slice(i, j + 1);
      }
    }
    return null;
  }

  const scripts = [...document.querySelectorAll("script")].map((s) => s.textContent || "");
  const scriptText = scripts.join("\n");

  // `var appsTableData=[ ... ]` (as written by the page) — the authoritative DataTables source.
  const embeddedVars = {};
  for (const s of scripts) {
    const re = /var\s+([A-Za-z_$][\w$]*)\s*=\s*(\[)/g;
    let m;
    while ((m = re.exec(s))) {
      const lit = scanLiteral(s, re.lastIndex - 1);
      if (!lit) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(lit);
      } catch {
        try {
          parsed = Function(`"use strict";return (${lit});`)();
        } catch {
          parsed = null;
        }
      }
      if (Array.isArray(parsed)) embeddedVars[m[1]] = parsed;
    }
  }

  // `$('#apps').dataTable({ ... aaData: appsTableData ... })` -> table id to variable name
  const tableToVar = {};
  {
    const re = /[#$]\(?['"]#([\w-]+)['"]\)?[\s\S]{0,4000}?['"]?aaData['"]?\s*:\s*([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(scriptText))) tableToVar[m[1]] = m[2];
  }

  const sectionTitleBefore = (el) => {
    // 0 hops: a direct previous-sibling heading
    let sib = el.previousElementSibling;
    while (sib) {
      if (/^(H2|H3|H4)$/.test(sib.tagName)) return txt(sib);
      if (sib.classList && sib.classList.contains("ui-widget-header")) return txt(sib);
      sib = sib.previousElementSibling;
    }
    // 1-2 hops: a wrapper that contains exactly this one table owns its own heading
    let cur = el.parentElement;
    for (let hops = 1; hops <= 2 && cur; hops++) {
      if (cur.querySelectorAll("table").length === 1) {
        const h = [...cur.children].find((c) => /^(H2|H3|H4)$/.test(c.tagName));
        if (h) return txt(h);
        if (cur.classList && cur.classList.contains("ui-widget-header")) return txt(cur);
      }
      cur = cur.parentElement;
    }
    return null;
  };

  const headerRowOf = (table) => {
    const ths = [...table.querySelectorAll("thead tr")].pop();
    if (ths && ths.querySelectorAll("th,td").length)
      return [...ths.querySelectorAll("th,td")].map((c) => ({
        label: txt(c),
        title: attr(c, "title"),
        className: attr(c, "class"),
      }));
    const tr = table.querySelector("tr");
    if (tr && tr.querySelectorAll("th").length)
      return [...tr.querySelectorAll("th")].map((c) => ({
        label: txt(c),
        title: attr(c, "title"),
        className: attr(c, "class"),
      }));
    return [];
  };

  const cellOf = (td) => ({
    text: txt(td),
    html: td.innerHTML ? td.innerHTML.trim() : "",
    title: titleOf(td),
    href: firstHref(td),
    colspan: td.colSpan || 1,
  });

  const tables = [];
  const contentRoot = document.querySelector("td.content") || document.body;
  const allTables = [...contentRoot.querySelectorAll("table")].filter(
    (t) => !t.closest("#navcell") && t.id !== "layout"
  );
  allTables.forEach((table, index) => {
    const id = attr(table, "id");
    const className = attr(table, "class");
    const headers = headerRowOf(table);
    const bodyRows = [...table.querySelectorAll("tbody tr")];
    const rawRows = bodyRows
      .filter((tr) => tr.querySelectorAll("td,th").length)
      .map((tr) => {
        const kids = [...tr.children].filter((c) => c.tagName === "TH" || c.tagName === "TD");
        return {
          tr,
          cells: kids.map(cellOf),
          allHead: kids.length > 0 && kids.every((c) => c.tagName === "TH"),
          empty: kids.length === 1 && (attr(kids[0], "class") || "").includes("dataTables_empty"),
        };
      });
    // DataTables 1.11 relocates the `<thead>` row into `<tbody>`; keep it out of the data rows
    const headerRows = rawRows.filter((r) => r.allHead).map((r) => ({ cells: r.cells }));
    // `style` keeps the row's inline style: the capacity scheduler marks users that are asking for resources with
    // `background:#FFFF00` (CapacitySchedulerPage.java:72,282), which is the only place that datum (isActive) is rendered
    const rows = rawRows.filter((r) => !r.allHead && !r.empty).map((r) => ({ cells: r.cells, style: attr(r.tr, "style") }));
    // Queue tree context (capacity scheduler): the queue whose <li> encloses this table, and the partition bar it was drawn under
    // (QueueBlock renders one tree per partition when a label has active NMs, each with its own per-queue tables).
    let queuePath = null;
    for (let el = table.parentElement; el && !queuePath; el = el.parentElement) {
      if (el.tagName !== "LI") continue;
      const a = [...el.children].find((c) => c.tagName === "A");
      const q = a ? a.querySelector("span.q") : null;
      if (q) queuePath = txt(q);
    }
    let partitionBar = null;
    if (queuePath) {
      for (const sp of document.querySelectorAll("#cs span.q")) {
        if (!/^Partition:/.test(txt(sp))) continue;
        if (sp.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) partitionBar = txt(sp);
        else break;
      }
    }
    // label/value pairs: `th` in cell 0, `td` in cell 1 (table.info, metrics tables, node labels)
    const pairs = [];
    let inlineSection = null;
    for (const tr of [...table.querySelectorAll("tr")]) {
      const cells = [...tr.children].filter((c) => c.tagName === "TH" || c.tagName === "TD");
      if (!cells.length) continue;
      if (cells.length === 1 && cells[0].tagName === "TH") {
        inlineSection = txt(cells[0]);
        continue;
      }
      if (cells[0].tagName === "TH" && cells[1] && cells[1].tagName === "TD") {
        pairs.push({
          label: txt(cells[0]),
          labelTitle: attr(cells[0], "title"),
          text: txt(cells[1]),
          html: cells[1].innerHTML ? cells[1].innerHTML.trim() : "",
          title: titleOf(cells[1]),
          href: firstHref(cells[1]),
          section: inlineSection,
        });
      }
    }
    // metrics-style table: headers in thead, body row of plain `td` values in the same order
    let metricsRow = null;
    if (!pairs.length && headers.length) {
      metricsRow = rows.find((r) => r.cells.length === headers.length) ?? null;
      if (metricsRow) {
        headers.forEach((h, i) => {
          const c = metricsRow.cells[i];
          pairs.push({ label: h.label, labelTitle: h.title, text: c.text, html: c.html, title: c.title, href: c.href, section: null });
        });
      }
    }
    const dataVariable = dataVarFor(id, tableToVar, embeddedVars);
    tables.push({
      index,
      id,
      className,
      queuePath,
      partitionBar,
      kind: dataVariable ? "datatable" : metricsRow ? "metrics" : pairs.length ? "kv" : "grid",
      sectionTitle: inlineSection || sectionTitleBefore(table),
      headers,
      headerRows,
      rows,
      pairs,
      dataVariable,
      embedded: dataVariable && embeddedVars[dataVariable] ? embeddedVars[dataVariable] : null,
    });
  });

  function dataVarFor(id, map, vars) {
    if (!id) return null;
    if (map[id] && vars[map[id]]) return map[id];
    const names = Object.keys(vars);
    const byPrefix = names.filter((n) => {
      const stem = n.replace(/TableData$/, "");
      return id.toLowerCase() === stem.toLowerCase() || id.toLowerCase() === `${stem.toLowerCase()}s`;
    });
    if (byPrefix.length === 1) return byPrefix[0];
    return null;
  }

  // tree-ish tables that carry their own header `th`s per group (scheduler userinfo tables):
  // keep them as `grid` rows with the first row acting as headers — already covered above.

  const scheduler = {};
  for (const sel of ["#cs-wrapper", "#cs", "#pq", "#lq", "#conf"] ) {
    const el = document.querySelector(sel);
    if (el) {
      scheduler[sel] = {
        text: txt(el),
        html: el.innerHTML ? el.innerHTML.trim().slice(0, 20000) : "",
      };
    }
  }

  // capacity-scheduler queue tree (#cs, jstree): one bar per queue — name (span.q), "<pct> used" (span.qstats), auto-created flag
  const queueBars = [...document.querySelectorAll("#cs li")]
    .map((li) => {
      const link = [...li.children].find((c) => c.tagName === "A");
      const q = link ? link.querySelector("span.q") : null;
      if (!q) return null;
      const stats = [...li.children].find((c) => c.classList && c.classList.contains("qstats"));
      return {
        name: txt(q),
        used: stats ? txt(stats).replace(/\s*used$/i, "") : null,
        title: attr(link, "title"),
        autoCreated: /F4F0CB/i.test(attr(li, "style") || "") || /F4F0CB/i.test(attr(link, "style") || ""),
        topLevel: !(li.parentElement && li.parentElement.closest("li")),
      };
    })
    .filter(Boolean);

  return {
    url: location.href,
    title: norm(document.title),
    h1: txt(document.querySelector("#header h1") || document.querySelector("h1")),
    user: txt(document.querySelector("#user")),
    nav: [...document.querySelectorAll("#nav a")].map((a) => ({ text: txt(a), href: a.getAttribute("href") })),
    navHeadings: [...document.querySelectorAll("#nav h3")].map((h) => txt(h)),
    // content headings (h2/h3/h4): dynamic titles such as "Total Allocated Containers: 0" are text, not label/value pairs
    headings: [...contentRoot.querySelectorAll("h2, h3, h4")].filter((h) => !h.closest("#navcell")).map((h) => txt(h)).filter(Boolean),
    footer: txt(document.querySelector("#footer")),
    jsNotice: (() => {
      const el = document.querySelector("#jsnotice");
      if (!el) return null;
      const visible = !!(el.offsetParent || (el.getClientRects && el.getClientRects().length));
      return { text: txt(el), visible };
    })(),
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    embeddedVars,
    tables,
    scheduler,
    queueBars,
    bodyError: (() => {
      const t = txt(contentRoot);
      const m = t.match(/Sorry, got error \d+/i);
      return m ? m[0] : null;
    })(),
  };
}
