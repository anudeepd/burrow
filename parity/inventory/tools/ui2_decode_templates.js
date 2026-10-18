#!/usr/bin/env bun
// Decode the precompiled Ember 2.8 HTMLBars templates of UI2 back into readable pseudo-Handlebars.
//
//   bun parity/inventory/tools/ui2_decode_templates.js          (run after ui2_extract.py)
//
// Input : .cluster/src-extract/ui2/templates/**/*.raw.js   (AMD modules `define("yarn-ui/templates/<name>", ..., Ember.HTMLBars.template(spec))`)
// Output: .cluster/src-extract/ui2/templates/**/<name>.hbs.txt   one line per output line, prefixed `<hbs line>: `
//
// How: each module is evaluated with a stub `define`/`Ember.HTMLBars.template(spec)=>spec`.  The spec's `buildFragment(dom)` is run
// against a recording mini-DOM (elements/text/comment placeholders), `buildRenderNodes(dom, fragment)` yields the morphs (which
// placeholder / attribute / element each entry of `spec.statements` binds to) and the statements are spliced back in as
// `{{content}}`, `{{inline arg k=v}}`, `{{#block ... as |x|}}…{{else}}…{{/block}}`, `<el attr={{expr}}>`, `<el {{action ...}}>`.
// Child templates (`spec.templates[i]`) are inlined recursively.  Literal text/labels are therefore exactly what the compiled
// templates contain.  `{{get path}}` prints as `path`; `(subexpr ...)` as `(name args k=v)`.
// Line prefixes come from the `loc` of each statement (Handlebars strips whitespace around standalone block tags, so counts may drift
// by a line between statements; they are resynchronised at every statement).
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(import.meta.dir, "../../..");
const TPL = path.join(ROOT, ".cluster/src-extract/ui2/templates");

function mkNode(type, extra) { return Object.assign({ type, children: [], attrs: [] }, extra); }
const dom = {
  createDocumentFragment: () => mkNode("frag"),
  createElement: (tag) => mkNode("el", { tag }),
  createTextNode: (text) => mkNode("text", { text }),
  createComment: () => mkNode("comment"),
  appendChild: (p, c) => { p.children.push(c); },
  setAttribute: (el, n, v) => { el.attrs.push([n, v]); },
  childAt: (n, p) => { for (const i of p) n = n.children[i]; return n; },
  createMorphAt: (parent, s, e) => ({ kind: "morph", parent, s, e }),
  createUnsafeMorphAt: (parent, s, e) => ({ kind: "morph", parent, s, e, unsafe: true }),
  createAttrMorph: (el, name) => ({ kind: "attr", el, name }),
  createElementMorph: (el) => ({ kind: "elem", el }),
  insertBoundary() {}, repairClonedNode() {}, detectNamespace() {},
};

function lit(v) { return typeof v === "string" ? JSON.stringify(v) : String(v); }
function expr(e) {
  if (!Array.isArray(e)) return lit(e);
  switch (e[0]) {
    case "get": return e[1];
    case "value": return lit(e[1]);
    case "subexpr": return "(" + [e[1], ...e[2].map(expr), ...hash(e[3])].join(" ") + ")";
    case "concat": return '"' + e[1].map(p => Array.isArray(p) ? "{{" + expr(p) + "}}" : p).join("") + '"';
    default: return "<?" + JSON.stringify(e) + ">";
  }
}
function hash(h) { const o = []; for (let i = 0; h && i < h.length; i += 2) o.push(h[i] + "=" + expr(h[i + 1])); return o; }
function locOf(st) { const l = st.find(x => Array.isArray(x) && x[0] === "loc"); return l ? l[1] : null; }

const M = (n) => "\x01" + n + "\x02";
function render(spec) {
  const frag = spec.buildFragment(dom);
  const morphs = spec.buildRenderNodes(dom, frag, null) || [];
  const byChild = new Map(), attrM = new Map(), elemM = new Map();
  morphs.forEach((m, i) => {
    if (!m) return;
    if (m.kind === "morph") { for (let k = m.s; k <= m.e; k++) byChild.set(m.parent.children[k], i); }
    else if (m.kind === "attr") { if (!attrM.has(m.el)) attrM.set(m.el, []); attrM.get(m.el).push([m.name, i]); }
    else if (m.kind === "elem") { if (!elemM.has(m.el)) elemM.set(m.el, []); elemM.get(m.el).push(i); }
  });
  let out = M(spec.meta.loc.start.line);
  function stmt(i) {
    const st = spec.statements[i]; const loc = locOf(st);
    let pre = loc && loc[1] ? M(loc[1][0]) : "";
    const post = loc && loc[2] ? M(loc[2][0]) : "";
    switch (st[0]) {
      case "content": return pre + "{{" + st[1] + "}}";
      case "inline": return pre + "{{" + [st[1], ...st[2].map(expr), ...hash(st[3])].join(" ") + "}}";
      case "block": {
        const head = [st[1], ...st[2].map(expr), ...hash(st[3])].join(" ");
        const kid = (idx) => { const t = spec.templates[idx]; const as = t.locals && t.locals.length ? " as |" + t.locals.join(" ") + "|" : ""; return { as, body: render(t) }; };
        let s = pre + "{{#" + head;
        const body = st[4] != null ? kid(st[4]) : null;
        s += (body ? body.as : "") + "}}" + (body ? body.body : "");
        if (st[5] != null) s += pre + "{{else}}" + kid(st[5]).body;
        return s + post + "{{/" + st[1] + "}}";
      }
      default: return "{{?" + JSON.stringify(st) + "}}";
    }
  }
  function node(n) {
    if (n.type === "text") { out += n.text; return; }
    if (n.type === "comment") { if (byChild.has(n)) out += stmt(byChild.get(n)); return; }
    if (n.type === "el") {
      let open = "<" + n.tag;
      for (const [k, v] of n.attrs) open += ` ${k}="${v}"`;
      for (const [k, i] of attrM.get(n) || []) { const st = spec.statements[i]; open += ` ${k}=` + (Array.isArray(st[2]) ? (st[2][0] === "concat" ? expr(st[2]) : "{{" + expr(st[2]) + "}}") : lit(st[2])); }
      for (const i of elemM.get(n) || []) { const st = spec.statements[i]; open += " {{" + [st[1], ...st[2].map(expr), ...hash(st[3])].join(" ") + "}}"; }
      out += open + ">";
      n.children.forEach(node);
      out += "</" + n.tag + ">";
      return;
    }
    n.children.forEach(node);
  }
  node(frag);
  return out;
}
function finalize(str) {
  const lines = []; let cur = "", start = null, line = 1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\x01") { const j = str.indexOf("\x02", i); line = +str.slice(i + 1, j); i = j; if (cur === "") start = line; continue; }
    if (ch === "\n") { lines.push((start ?? line) + ": " + cur); cur = ""; start = null; line++; continue; }
    if (cur === "" && start === null) start = line;
    cur += ch;
  }
  if (cur) lines.push((start ?? line) + ": " + cur);
  return lines;
}

function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]); }
let n = 0;
for (const f of walk(TPL).filter(f => f.endsWith(".raw.js"))) {
  let spec = null;
  const define = (name, deps, fn) => { fn({ set default(v) { spec = v; }, get default() { return spec; } }); };
  const exportsObj = {}; globalThis.Ember = { HTMLBars: { template: (s) => s } };
  new Function("define", fs.readFileSync(f, "utf8"))(define);
  if (!spec) throw new Error("no spec in " + f);
  const lines = finalize(render(spec));
  fs.writeFileSync(f.replace(/\.raw\.js$/, ".hbs.txt"), lines.join("\n") + "\n");
  n++;
}
console.error(n + " templates decoded");

