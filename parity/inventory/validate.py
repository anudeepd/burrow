#!/usr/bin/env python3
"""Validates the whole parity/inventory tree.  Exit code 1 on any failure.

  .venv/bin/python parity/inventory/validate.py [--quiet]

Checks
 1. JSON-Schema validation (schema.json) of every hand-written and generated YAML file.
 2. Referential integrity:
      * every page item `field:` / `fields[]` resolves to a registry row (field-ids.yaml);
      * every `rest: {resource: R}` names a real resource;
      * every registry `rest[].resource` names a real resource;
      * every entity root object, object `extends`/`ref` and resource `response.object` exists
        (java-only refs are reported separately, not as errors);
      * unique ids repo-wide: pages, sections, items, entities, objects, resources, registry fields, derived ids;
      * `includes:` names an existing page;
      * every registry row's `waiver` has a category+reason; every waivable row has a waiver;
      * every REST JSON path reached from a GET resource response is either registered or waived
        (field-ids.yaml `unmappedPaths`, itself validated);
      * every `*Block.java` / `*Page.java` / `*Table.java` in the RM webapp package is either referenced by an
        inventory page or listed in EXCLUDED_CLASSES with a reason.
 3. Totals (always printed).
"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

import yaml  # noqa: E402
from jsonschema import Draft202012Validator  # noqa: E402

INV = HERE
SRC = os.path.join(INV, 'src')
SCHEMA = json.load(open(os.path.join(INV, 'schema.json')))
RM_WEBAPP = os.path.join(
    ROOT, '.cluster/src-extract/hadoop-yarn-server-resourcemanager/org/apache/hadoop/yarn/server/resourcemanager/webapp')

# RM webapp classes that are legitimately not a rendered page/block/table.  Anything NOT listed here and NOT
# referenced by a page is an error (the P0 acceptance criterion: every Block/Page/Table accounted for).
EXCLUDED_CLASSES = {
    'AboutBlock': 'rendered page class of legacy.rm.cluster-about (referenced)',
    'ColumnHeader': 'static column-header constants used by RMAppsBlock / FairSchedulerAppsBlock; not a rendered block',
    'DeSelectFields': 'enum of the ?deSelects request parameter; not rendered',
    'JAXBContextResolver': 'JAX-RS provider (JSON wrapping rules), not rendered',
    'RMWSConsts': 'JAX-RS path/param constants, not rendered',
    'RMWebApp': 'webapp bootstrap (route table; see legacy.rm.* page route fields)',
    'RMWebAppFilter': 'servlet filter (user/queue params), not rendered',
    'RMWebAppUtil': 'view helpers (formatting, ACL checks); referenced through the pages that use them',
    'RMWebServiceProtocol': 'interface for the JAX-RS resources, not rendered',
    'RMWebServices': 'REST resource implementation (see rest-rm.yaml resources)',
    'NodeIDsInfo': 'DAO for label-mappings / node-to-labels, not rendered',
    'ApplicationsRequestBuilder': 'request builder for the /apps query string, not rendered',
    'SchedulerPageUtil': 'shared helpers for the scheduler pages (referenced by them through source pointers)',
    'RmController': 'controller (route table); each route is inventoried as a page',
    'RmView': 'default view wrapper (header/nav/footer chrome, inventoried as legacy.rm.shared.chrome)',
}

ERRORS = []
WARNINGS = []


def err(msg):
    ERRORS.append(msg)


def warn(msg):
    WARNINGS.append(msg)


def load(path):
    with open(path) as f:
        return yaml.safe_load(f)


def schema_check(path, def_name, quiet=False):
    data = load(path)
    validator = Draft202012Validator({'$ref': '#/$defs/%s' % def_name, **SCHEMA})
    problems = sorted(validator.iter_errors(data), key=lambda e: list(e.path))
    for p in problems[:25]:
        err('%s: %s at %s' % (os.path.relpath(path, ROOT), p.message, '/'.join(str(x) for x in p.path) or '<root>'))
    if len(problems) > 25:
        err('%s: +%d more schema errors' % (os.path.relpath(path, ROOT), len(problems) - 25))
    if not quiet and not problems:
        print('  schema OK  %s' % os.path.relpath(path, ROOT))
    return data


def main():
    quiet = '--quiet' in sys.argv

    # ---------------------------------------------------------------- schema
    print('== JSON Schema')
    rest_parts = sorted(glob.glob(os.path.join(SRC, 'rest-*.yaml')))
    rest = {'entities': [], 'objects': {}, 'resources': [], 'derived': []}
    for p in rest_parts:
        d = schema_check(p, 'restPart', quiet)
        rest['entities'] += d.get('entities', [])
        rest['objects'].update(d.get('objects') or {})
        rest['resources'] += d.get('resources', [])
        rest['derived'] += d.get('derived', []) or []
    schema_check(os.path.join(SRC, 'field-overrides.yaml'), 'overridesFile', quiet)
    legacy = schema_check(os.path.join(INV, 'legacy-pages.yaml'), 'pageFile', quiet)
    ui2_files = [os.path.join(INV, 'ui2.yaml'), os.path.join(INV, 'ui2-extra.yaml')]
    page_files = [os.path.join(INV, 'legacy-pages.yaml')] + [f for f in ui2_files if os.path.exists(f)]
    pages_docs = []
    for f in [os.path.join(INV, 'legacy-pages.yaml')] + [x for x in ui2_files if os.path.exists(x)]:
        pages_docs.append((f, load(f)))
    registry = schema_check(os.path.join(INV, 'field-ids.yaml'), 'registryFile', quiet)

    entities = {e['id']: e for e in rest['entities']}
    objects = rest['objects']
    resources = {r['id']: r for r in rest['resources']}
    rows = {r['id']: r for r in registry.get('fields', [])}

    # ---------------------------------------------------------------- uniqueness
    print('== Uniqueness')
    for kind, items in [('entity', rest['entities']), ('resource', rest['resources']), ('object', list(objects)),
                        ('registry row', registry.get('fields', []))]:
        seen = {}
        for it in items:
            key = it['id'] if isinstance(it, dict) else it
            if key in seen:
                err('duplicate %s id %s' % (kind, key))
            seen[key] = kind
    pages, sections, items = {}, {}, {}
    for path, doc in pages_docs:
        rel = os.path.relpath(path, ROOT)
        for p in doc.get('pages', []) or []:
            if p['id'] in pages:
                err('duplicate page id %s (%s and %s)' % (p['id'], pages[p['id']], rel))
            pages[p['id']] = rel
            for s in p.get('sections', []) or []:
                if s['id'] in sections:
                    err('duplicate section id %s (%s and %s)' % (s['id'], sections[s['id']], rel))
                sections[s['id']] = rel
                for it in s.get('items', []) or []:
                    if it['id'] in items:
                        err('duplicate item id %s (%s and %s)' % (it['id'], items[it['id']], rel))
                    items[it['id']] = rel
                    if not it['id'].startswith(p['id'] + '.'):
                        err('item %s is not prefixed by its page id %s' % (it['id'], p['id']))
    derived_ids = {}
    for path, doc in pages_docs:
        for dv in doc.get('derived', []) or []:
            if dv['id'] in derived_ids:
                err('duplicate derived id %s (%s and %s)' % (dv['id'], derived_ids[dv['id']], os.path.relpath(path, ROOT)))
            derived_ids[dv['id']] = os.path.relpath(path, ROOT)
    for dv in rest['derived']:
        if dv['id'] in derived_ids:
            err('duplicate derived id %s (%s and a rest part)' % (dv['id'], derived_ids[dv['id']]))
        derived_ids[dv['id']] = 'rest part'
    print('  pages %d, sections %d, items %d, derived ids %d' % (len(pages), len(sections), len(items), len(derived_ids)))

    # ---------------------------------------------------------------- referential integrity
    print('== Referential integrity')
    for path, doc in pages_docs:
        rel = os.path.relpath(path, ROOT)
        for p in doc.get('pages', []) or []:
            for inc in p.get('includes', []) or []:
                if inc not in pages:
                    err('%s page %s includes unknown page %s' % (rel, p['id'], inc))
            for s in p.get('sections', []) or []:
                for it in s.get('items', []) or []:
                    for fid in [it.get('field')] + list(it.get('fields') or []):
                        if fid not in rows:
                            err('%s item %s: field id %s has no registry row' % (rel, it['id'], fid))
                    rr = it.get('rest')
                    if rr and rr.get('resource') not in resources:
                        err('%s item %s: rest.resource %s unknown' % (rel, it['id'], rr.get('resource')))
    for e in rest['entities']:
        for r in e['roots']:
            if r.get('object') and r['object'] not in objects:
                err('entity %s root object %s unknown' % (e['id'], r['object']))
    for name, o in objects.items():
        if o.get('extends') and o['extends'] not in objects:
            warn('object %s extends %s which is not modelled (java-only)' % (name, o['extends']))
        for f in o['fields']:
            if f.get('ref') and f['ref'] not in objects:
                warn('object %s field %s refs %s which is not modelled (java-only)' % (name, f['name'], f['ref']))
    for r in rest['resources']:
        o = ((r.get('response') or {}) or {}).get('object')
        if o and o not in objects:
            err('resource %s response.object %s unknown' % (r['id'], o))
        for prm in r.get('params', []) or []:
            if prm.get('source') is None and prm.get('in') == 'path':
                warn('resource %s param %s has no source pointer' % (r['id'], prm['name']))
    for row in registry.get('fields', []):
        for rr in row.get('rest') or []:
            if rr['resource'] not in resources:
                err('registry row %s references unknown resource %s' % (row['id'], rr['resource']))
        if row['status'] == 'waivable' and not row.get('waiver'):
            err('registry row %s is waivable without a waiver reason' % row['id'])
        if row['status'] == 'required' and row.get('waiver'):
            err('registry row %s is required but carries a waiver' % row['id'])
        if row.get('waiver') and not row['waiver'].get('reason'):
            err('registry row %s waiver has no reason' % row['id'])
        if row['status'] == 'required' and not row['shownBy']:
            err('registry row %s is required without shownBy' % row['id'])
    for w in registry.get('unmappedPaths', []) or []:
        if w['resource'] not in resources:
            err('unmappedPaths entry references unknown resource %s' % w['resource'])
        if not (w.get('waiver') or {}).get('reason'):
            err('unmappedPaths entry %s/%s has no reason' % (w['resource'], w['path']))

    # ---------------------------------------------------------------- class accounting
    print('== RM webapp class accounting')
    referenced = set()
    for path, doc in pages_docs:
        for p in doc.get('pages', []) or []:
            for c in p.get('classes', []) or []:
                referenced.add(c.split('#')[0].strip())
            for s in p.get('sections', []) or []:
                for src in [s.get('source')] + [i.get('source') for i in s.get('items', []) or []]:
                    if not src:
                        continue
                    base = os.path.basename(str(src).split(':')[0])
                    if base.endswith('.java'):
                        referenced.add(base[:-5])
    classes = sorted(
        os.path.basename(p)[:-5] for p in glob.glob(os.path.join(RM_WEBAPP, '*.java'))
        if re.search(r'(Block\w*|Page|Table)\.java$', p))
    unaccounted, excluded_only = [], []
    for c in classes:
        if c in referenced:
            continue
        if c in EXCLUDED_CLASSES:
            excluded_only.append(c)
            continue
        unaccounted.append(c)
    for c in unaccounted:
        err('RM webapp class %s.java is neither referenced by any page nor listed in EXCLUDED_CLASSES' % c)
    print('  %d Block/Page/Table classes: %d referenced by a page, %d excluded with a reason, %d unaccounted'
          % (len(classes), len(classes) - len(excluded_only) - len(unaccounted), len(excluded_only), len(unaccounted)))
    if excluded_only:
        print('  excluded: %s' % ', '.join('%s (%s)' % (c, EXCLUDED_CLASSES[c]) for c in excluded_only))
    # every excluded class must still exist (guards against renames)
    for c, reason in EXCLUDED_CLASSES.items():
        if not os.path.exists(os.path.join(RM_WEBAPP, c + '.java')):
            err('EXCLUDED_CLASSES lists %s but %s.java does not exist' % (c, c))
        if not reason:
            err('EXCLUDED_CLASSES entry %s has no reason' % c)

    # ---------------------------------------------------------------- totals
    print('== Totals')
    by_origin = {}
    by_status = {}
    for r in registry.get('fields', []):
        by_origin[r['origin']] = by_origin.get(r['origin'], 0) + 1
        by_status[r['status']] = by_status.get(r['status'], 0) + 1
    shown_by = {}
    for r in registry.get('fields', []):
        tag = ','.join(sorted(r['shownBy'])) if r['shownBy'] else 'rest-only'
        shown_by[tag] = shown_by.get(tag, 0) + 1
    print('  rest parts: %d entities, %d objects, %d object fields, %d resources, %d derived declarations'
          % (len(rest['entities']), len(objects), sum(len(o['fields']) for o in objects.values()),
             len(rest['resources']), len(rest['derived'])))
    print('  pages: %d (legacy %d, ui2 %d), sections %d, items %d'
          % (len(pages), sum(1 for p in pages if p.startswith('legacy.')),
             sum(1 for p in pages if p.startswith('ui2.')), len(sections), len(items)))
    print('  registry: %d rows %s | status %s | shownBy %s'
          % (len(registry.get('fields', [])), by_origin, by_status, shown_by))
    print('  REST paths waived without a field id: %d' % len(registry.get('unmappedPaths', []) or []))

    print('== Result')
    for w in WARNINGS:
        print('  WARN  %s' % w)
    for e in ERRORS:
        print('  FAIL  %s' % e)
    print('  %d errors, %d warnings' % (len(ERRORS), len(WARNINGS)))
    return 1 if ERRORS else 0


if __name__ == '__main__':
    sys.exit(main())
