#!/usr/bin/env python3
"""Split the UI2 (Ember 2.8) bundle `assets/yarn-ui.js` into one beautified file per AMD module.

Usage:  .venv/bin/python parity/inventory/tools/ui2_extract.py
Input : .cluster/hadoop/share/hadoop/yarn/webapps/ui2/assets/yarn-ui.js   (+ config/configs.env, index.html copied verbatim)
Output: .cluster/src-extract/ui2/<module-path>.js          for every non-template module
        .cluster/src-extract/ui2/templates/**/*.raw.js     (compiled HTMLBars, beautified; use ui2_decode_templates.js for the readable form;\n                                                           vendor addon templates em-table/em-helpers go to templates/vendor/<addon>/)
        .cluster/src-extract/ui2/_modules.txt              `<module>\t<bundle>\t<lines in beautified file>`
Requires `jsbeautifier` (uv pip install --python .venv/bin/python jsbeautifier).

The bundle is minified ES5 produced by ember-cli (`define("yarn-ui/<kind>/<name>",[deps],function(exports,...){...});`),
so a module ends where the next `define(` begins.  Line numbers quoted in ui2.yaml `source:` fields refer to the beautified
files this script writes (`<module>.js:<line>`); for templates the number is the *.hbs line (see ui2_decode_templates.js).
"""
import re, os, shutil, sys
import jsbeautifier

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
UI2 = os.path.join(ROOT, ".cluster/hadoop/share/hadoop/yarn/webapps/ui2")
OUT = os.path.join(ROOT, ".cluster/src-extract/ui2")

pat = re.compile(r"define\((['\"])([^'\"]+)\1\s*,")
opts = jsbeautifier.default_options()
opts.indent_size = 2
opts.preserve_newlines = False
index = []
os.makedirs(OUT, exist_ok=True)
# (bundle, module-name filter).  vendor.js is filtered to the UI-relevant addons whose templates carry user-visible chrome
# (em-table = every list's search box/pager/facets/column chooser; em-helpers = breadcrumbs/progress).
BUNDLES = [("assets/yarn-ui.js", lambda n: True),
           ("assets/vendor.js", lambda n: n.startswith(("em-table/", "em-helpers/")))]
for bundle, keep in BUNDLES:
    src = open(os.path.join(UI2, bundle), encoding="utf-8").read()
    ms = list(pat.finditer(src))
    for i, m in enumerate(ms):
        name = m.group(2)
        if not keep(name):
            continue
        end = ms[i + 1].start() if i + 1 < len(ms) else len(src)
        body = src[m.start():end]
        if "/templates/" in name:
            head, tail = name.split("/templates/", 1)
            rel = "templates/" + ("vendor/" + head + "/" if head != "yarn-ui" else "") + tail + ".raw.js"
        else:
            rel = name + ".js"
        path = os.path.join(OUT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        text = jsbeautifier.beautify(body, opts)
        open(path, "w", encoding="utf-8").write(text + "\n")
        index.append((name, bundle, text.count("\n") + 1))
with open(os.path.join(OUT, "_modules.txt"), "w") as f:
    for n, o, l in index:
        f.write(f"{n}\t{o}\t{l}\n")
for extra in ("config/configs.env", "index.html"):
    d = os.path.join(OUT, extra)
    os.makedirs(os.path.dirname(d), exist_ok=True)
    shutil.copy(os.path.join(UI2, extra), d)
print(f"{len(index)} modules -> {OUT}", file=sys.stderr)
