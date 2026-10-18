export interface DagHtmlPalette {
  ground: string;
  surface: string;
  raised: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
}

const DEFAULT_PALETTE: DagHtmlPalette = {
  ground: "#0b1015",
  surface: "#11171d",
  raised: "#1a2028",
  ink: "#e7edf2",
  muted: "#9ba6b2",
  line: "#2b343e",
  accent: "#43d4d5",
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Wrap the styled SVG and its complete metadata payload in one offline-capable, inspectable HTML artifact.
 * The SVG's metadata is the canonical JSON export, so the visual and the downloadable data cannot drift apart.
 */
export function serializeDagHtml(svg: string, title: string, palette: Partial<DagHtmlPalette> = {}): string {
  const colors = { ...DEFAULT_PALETTE, ...palette };
  const cssVariables = Object.entries(colors)
    .map(([key, value]) => `--${key}:${value};`)
    .join("");
  const safeTitle = escapeHtml(title);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${safeTitle} · Burrow DagViz</title>
  <style>
    :root { color-scheme: dark; ${cssVariables} font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 20px; background: var(--ground); color: var(--ink); }
    button { min-height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--raised); color: var(--ink); font: inherit; cursor: pointer; }
    button:hover { border-color: var(--accent); }
    button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 auto 16px; max-width: 1600px; }
    header h1 { margin: 2px 0 4px; font-size: clamp(19px, 3vw, 26px); line-height: 1.2; }
    .eyebrow { margin: 0; color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .summary { margin: 0; color: var(--muted); font-size: 13px; }
    .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .zoom { min-width: 48px; color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; text-align: center; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 330px); gap: 12px; max-width: 1600px; margin: 0 auto; align-items: start; }
    .card { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
    .card-title { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--line); font-weight: 650; }
    .hint { color: var(--muted); font-size: 11px; font-weight: 400; text-align: right; }
    #dag-canvas { position: relative; height: min(72dvh, 760px); min-height: 360px; overflow: hidden; background-color: var(--ground); background-image: radial-gradient(color-mix(in srgb, var(--line), transparent 28%) 1px, transparent 1px); background-size: 22px 22px; touch-action: pan-y pinch-zoom; }
    #dag-canvas svg { display: block; width: 100%; height: 100%; max-width: none; user-select: none; cursor: grab; }
    #dag-canvas[data-panning="true"] svg { cursor: grabbing; }
    #dag-canvas .burrow-dag-node { cursor: pointer; }
    #dag-canvas .burrow-dag-node.export-selected .burrow-dag-node-body { stroke: var(--accent) !important; stroke-width: 2.5px !important; }
    #dag-canvas .burrow-dag-edge { cursor: pointer; }
    #dag-canvas .burrow-dag-edge.export-selected .burrow-dag-edge-track { stroke: var(--accent) !important; stroke-width: 3px !important; }
    aside { padding: 12px; }
    aside h2 { margin: 0 0 8px; font-size: 15px; }
    aside p, .empty { color: var(--muted); }
    .kv { display: grid; grid-template-columns: minmax(92px, .75fr) minmax(0, 1.4fr); gap: 7px 12px; margin: 0; }
    .kv dt { color: var(--muted); overflow-wrap: anywhere; }
    .kv dd { margin: 0; overflow-wrap: anywhere; }
    .metrics { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--line); }
    .metrics h3 { margin: 0 0 8px; font-size: 13px; }
    .metrics p { margin: 0 0 8px; font-size: 11px; }
    .metric-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .metric-table td { padding: 5px 0; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
    .metric-table td:first-child { color: var(--muted); }
    .metric-table td:last-child { text-align: right; }
    .plan-line { margin: 0; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .section { margin: 12px 0 0; }
    .section h3 { margin: 0 0 6px; font-size: 13px; }
    details { max-width: 1600px; margin: 12px auto 0; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); }
    summary { padding: 10px 12px; cursor: pointer; font-weight: 600; }
    pre { max-height: 55dvh; overflow: auto; margin: 0; padding: 12px; border-top: 1px solid var(--line); color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .foot { max-width: 1600px; margin: 10px auto 0; color: var(--muted); font-size: 11px; }
    @media (max-width: 820px) {
      body { padding: 12px; }
      header { align-items: flex-start; flex-direction: column; }
      main { grid-template-columns: minmax(0, 1fr); }
      #dag-canvas { height: 62dvh; min-height: 300px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">Burrow DagViz · offline export</p>
      <h1>${safeTitle}</h1>
      <p class="summary" id="summary">Loading graph details…</p>
    </div>
    <div class="controls" role="toolbar" aria-label="DAG export controls">
      <button type="button" id="fit">Fit</button>
      <button type="button" id="zoom-out" aria-label="Zoom out">−</button>
      <output class="zoom" id="zoom">100%</output>
      <button type="button" id="zoom-in" aria-label="Zoom in">+</button>
      <button type="button" id="save-json">Save full JSON</button>
    </div>
  </header>
  <main>
    <section class="card" aria-label="DAG graph">
      <div class="card-title"><span>Plan DAG</span><span class="hint">Scroll to zoom · Shift+scroll to move page · drag to pan · click a node or edge for details</span></div>
      <div id="dag-canvas">${svg}</div>
    </section>
    <aside class="card" aria-live="polite">
      <h2 id="inspect-title">Graph details</h2>
      <div id="inspect"><p class="empty">Select a node or edge to inspect its Spark details and metrics.</p></div>
    </aside>
  </main>
  <details>
    <summary>Raw Spark plan</summary>
    <pre id="raw-plan"></pre>
  </details>
  <details>
    <summary>Complete DAG, layout, and metrics data</summary>
    <pre id="full-data"></pre>
  </details>
  <p class="foot">This file contains the rendered DagViz graph, its styling, complete source payload, routed layout, and metric records. It works offline.</p>
  <script>
    (() => {
      const canvas = document.getElementById('dag-canvas');
      const svg = canvas && canvas.querySelector('svg');
      const metadata = svg && svg.querySelector('#burrow-dagviz-export');
      if (!canvas || !svg || !metadata) return;
      let data;
      try { data = JSON.parse(metadata.textContent || '{}'); } catch { return; }
      const graph = data.dagViz && data.dagViz.graph || {};
      const dagViz = data.dagViz || {};
      const scene = dagViz.scene || {};
      const source = data.sourcePayload || {};
      const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
      const edges = Array.isArray(graph.edges) ? graph.edges : [];
      const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
      const rawPlan = source.planDescription || source.description || '';
      const planBox = document.getElementById('raw-plan');
      const dataBox = document.getElementById('full-data');
      const inspector = document.getElementById('inspect');
      const inspectorTitle = document.getElementById('inspect-title');
      const summary = document.getElementById('summary');
      planBox.textContent = rawPlan || 'No raw plan was included in the source payload.';
      dataBox.textContent = JSON.stringify(data, null, 2);
      const totals = scene.totals || {};
      summary.textContent = [source.status, nodes.length + ' nodes', edges.length + ' edges', (totals.done || 0) + '/' + (totals.total || 0) + ' tasks complete'].filter(Boolean).join(' · ');

      const escapeHtml = (value) => String(value == null || value === '' ? '—' : value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
      const valueText = (value) => typeof value === 'string' ? value : value == null ? '—' : JSON.stringify(value);
      const rowsHtml = (rows) => '<dl class="kv">' + rows.map(([key, value]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(valueText(value)) + '</dd>').join('') + '</dl>';
      const sqlMetricsHtml = (metrics) => '<section class="metrics"><h3>SQL plan metrics</h3><p class="empty">operator accumulables from the SQL plan — not stage task counters</p><table class="metric-table"><tbody>' + metrics.map((metric) => '<tr><td>' + escapeHtml(metric.name) + '</td><td>' + escapeHtml(metric.value) + '</td></tr>').join('') + '</tbody></table></section>';
      const rawRecord = (value) => '<details><summary>Full record</summary><pre>' + escapeHtml(JSON.stringify(value, null, 2)) + '</pre></details>';
      function showNode(id, element) {
        const node = nodes.find((item) => String(item.id) === String(id));
        if (!node) return;
        const visual = (scene.nodes || []).find((item) => item.node && String(item.node.id) === String(id));
        const raw = rawNodes.find((item) => String(item.nodeId) === String(node.ref));
        const nodeMetrics = Array.isArray(node.metrics) ? node.metrics : [];
        const metrics = nodeMetrics.length > 0 ? nodeMetrics : (raw && Array.isArray(raw.metrics) ? raw.metrics : []);
        svg.querySelectorAll('.burrow-dag-node.export-selected').forEach((item) => item.classList.remove('export-selected'));
        svg.querySelectorAll('.burrow-dag-edge.export-selected').forEach((item) => item.classList.remove('export-selected'));
        if (element) element.classList.add('export-selected');
        inspectorTitle.textContent = node.label || 'Node details';
        if (node.kind === 'sql') {
          const metricHtml = metrics.length ? sqlMetricsHtml(metrics) : '<p class="empty">This operator reports no accumulables in the plan JSON.</p>';
          const planLine = node.detail ? '<section class="section"><h3>Plan line</h3><p class="plan-line">' + escapeHtml(node.detail) + '</p></section>' : '';
          const callsite = node.callsite ? '<section class="section"><h3>Callsite</h3><p class="plan-line">' + escapeHtml(node.callsite) + '</p></section>' : '';
          inspector.innerHTML = '<p class="empty">physical operator</p>' + metricHtml + planLine + callsite + rawRecord({ normalized: node, source: raw || null, scene: visual || null });
        } else {
          const rows = [['Type', node.kind], ['Node ID', node.ref], ['Stage', node.stageId], ['Attempt', node.attempt], ['Status', node.status || (visual && visual.statusLabel)], ['Callsite', node.callsite], ['Plan detail', node.detail], ['Progress', visual && visual.taskSummary], ['Badges', visual && visual.badges && visual.badges.map((item) => item.text).join(', ')]];
          const metricHtml = metrics.length ? '<section class="metrics"><h3>Metrics (' + metrics.length + ')</h3>' + rowsHtml(metrics.map((metric) => [metric.name, metric.value])) + '</section>' : '<p class="empty">No operator metrics were reported for this node.</p>';
          inspector.innerHTML = rowsHtml(rows) + metricHtml + rawRecord({ normalized: node, source: raw || null, scene: visual || null });
        }
      }
      function showEdge(id, element) {
        const edge = edges.find((item) => String(item.id) === String(id));
        if (!edge) return;
        const visual = (scene.edges || []).find((item) => item.edge && String(item.edge.id) === String(id));
        svg.querySelectorAll('.burrow-dag-node.export-selected').forEach((item) => item.classList.remove('export-selected'));
        svg.querySelectorAll('.burrow-dag-edge.export-selected').forEach((item) => item.classList.remove('export-selected'));
        if (element) element.classList.add('export-selected');
        inspectorTitle.textContent = 'Dependency edge';
        inspector.innerHTML = rowsHtml([['Kind', edge.kind], ['From node', edge.from], ['To node', edge.to], ['From stage', edge.fromStage], ['To stage', edge.toStage], ['Crosses codegen scope', edge.crossCluster], ['Shuffle label', visual && visual.shuffleLabel], ['Flowing', visual && visual.flowing], ['Flow intensity', visual && visual.intensity]]) + rawRecord({ normalized: edge, scene: visual || null });
      }
      // Pointer capture retargets the eventual click to the canvas; retain the original SVG hit target for selection.
      let pointerDownTarget = null;
      canvas.addEventListener('click', (event) => {
        if (suppressClick) {
          event.stopImmediatePropagation();
          suppressClick = false;
          pointerDownTarget = null;
          return;
        }
        const eventTarget = event.target instanceof Element ? event.target : null;
        const target = eventTarget && (eventTarget.closest('[data-node-id], [data-edge-id]') ? eventTarget : pointerDownTarget);
        pointerDownTarget = null;
        const nodeElement = target && target.closest('[data-node-id]');
        if (nodeElement) { showNode(nodeElement.getAttribute('data-node-id'), nodeElement); return; }
        const edgeElement = target && target.closest('[data-edge-id]');
        if (edgeElement) showEdge(edgeElement.getAttribute('data-edge-id'), edgeElement);
      });

      const box = svg.viewBox.baseVal;
      const width = Number(svg.getAttribute('width')) || box.width;
      const height = Number(svg.getAttribute('height')) || box.height;
      let scale = 1;
      let centerX = width / 2;
      let centerY = height / 2;
      function drawViewBox() {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const viewWidth = rect.width / scale;
        const viewHeight = rect.height / scale;
        svg.setAttribute('viewBox', (centerX - viewWidth / 2) + ' ' + (centerY - viewHeight / 2) + ' ' + viewWidth + ' ' + viewHeight);
        document.getElementById('zoom').textContent = Math.round(scale * 100) + '%';
      }
      function fitGraph() {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height || !width || !height) return;
        scale = Math.max(0.005, Math.min(1, (rect.width - 32) / width, (rect.height - 32) / height));
        centerX = width / 2;
        centerY = height / 2;
        drawViewBox();
      }
      function zoomAt(factor, px, py) {
        const rect = canvas.getBoundingClientRect();
        const next = Math.max(0.02, Math.min(4, scale * factor));
        const worldX = centerX + (px - rect.width / 2) / scale;
        const worldY = centerY + (py - rect.height / 2) / scale;
        centerX = worldX - (px - rect.width / 2) / next;
        centerY = worldY - (py - rect.height / 2) / next;
        scale = next;
        drawViewBox();
      }
      document.getElementById('fit').addEventListener('click', fitGraph);
      document.getElementById('zoom-in').addEventListener('click', () => zoomAt(1.25, canvas.clientWidth / 2, canvas.clientHeight / 2));
      document.getElementById('zoom-out').addEventListener('click', () => zoomAt(0.8, canvas.clientWidth / 2, canvas.clientHeight / 2));
      canvas.addEventListener('wheel', (event) => {
        if (event.shiftKey) {
          const amount = event.deltaY || event.deltaX;
          if (amount) { event.preventDefault(); window.scrollBy({ top: amount, behavior: 'auto' }); }
          return;
        }
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const unit = event.deltaMode === 1 ? 0.05 : 0.0016;
        zoomAt(Math.exp(-event.deltaY * unit), event.clientX - rect.left, event.clientY - rect.top);
      }, { passive: false });
      let drag = null;
      let suppressClick = false;
      canvas.addEventListener('pointerdown', (event) => {
        pointerDownTarget = null;
        if (event.button !== 0 || event.pointerType === 'touch' || event.target.closest('button')) return;
        pointerDownTarget = event.target instanceof Element ? event.target : null;
        drag = { x: event.clientX, y: event.clientY, centerX, centerY, moved: false };
        canvas.setPointerCapture(event.pointerId);
      });
      canvas.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (!drag.moved) return;
        centerX = drag.centerX - dx / scale;
        centerY = drag.centerY - dy / scale;
        canvas.setAttribute('data-panning', 'true');
        drawViewBox();
      });
      const finishDrag = () => { if (drag && drag.moved) suppressClick = true; drag = null; canvas.removeAttribute('data-panning'); };
      canvas.addEventListener('pointerup', finishDrag);
      canvas.addEventListener('pointercancel', () => { finishDrag(); pointerDownTarget = null; });
      document.getElementById('save-json').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = (document.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'dag') + '.json';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(drawViewBox).observe(canvas);
      requestAnimationFrame(fitGraph);
    })();
  </script>
</body>
</html>`;
}
