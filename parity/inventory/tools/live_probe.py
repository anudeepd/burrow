#!/usr/bin/env python3
"""Probes the live RM/NM daemons with every registered field id (a P1-lite sanity check).

  .venv/bin/python parity/inventory/tools/live_probe.py [--rm http://127.0.0.1:8088] [--all] [--json]

For each `field-ids.yaml` row with `origin: rest` it resolves the row's first `rest` entry against the live daemon
(path parameters substituted from live app/node/attempt ids discovered via /apps and /nodes) and reports whether the
JSON path exists.  It is a *shape* check, not the value-parity harness (PLAN §8 P2): it proves the id paths are real.

Rows are grouped as: `ok` (path resolved), `absent` (the key is legitimately missing for this cluster state, e.g. an
optional/null field), `unreachable` (endpoint 404/500/404-with-{param} that could not be substituted), `nonjson`
(text endpoints) and `skipped` (write endpoints, ATS v2, daemon pages without a JSON body).
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
INV = os.path.abspath(os.path.join(HERE, '..'))

import yaml  # noqa: E402


def load(p):
    with open(p) as f:
        return yaml.safe_load(f)


def get(url, timeout=10):
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    try:
        return json.loads(raw)
    except ValueError:
        return None


def resolve(doc, path):
    """Resolve a jsonPath with '[]' markers (first element) and map 'entry' hops."""
    cur = doc
    for seg in [s for s in path.split('.') if s]:
        if seg.endswith('[]'):
            seg = seg[:-2]
        if isinstance(cur, dict):
            if seg not in cur:
                return False, None
            cur = cur[seg]
        elif isinstance(cur, list):
            if not cur:
                return False, None
            cur = cur[0]
            if not isinstance(cur, dict) or seg not in cur:
                return False, None
            cur = cur[seg]
        else:
            return False, None
        if isinstance(cur, list):
            cur = cur[0] if cur else None
    return True, cur


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rm', default='http://127.0.0.1:8088')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--all', action='store_true', help='also probe write/ats resources')
    args = ap.parse_args()

    reg = load(os.path.join(INV, 'field-ids.yaml'))
    rest = load(os.path.join(INV, 'rest-schema.yaml'))
    resources = {r['id']: r for r in rest['resources']}

    # discover live ids for path-parameter substitution
    subs = {}
    try:
        apps = ((get(args.rm + '/ws/v1/cluster/apps') or {}).get('apps') or {}).get('app') or []
        for a in apps:
            subs.setdefault('appid', a['id'])
            subs.setdefault('appId', a['id'])
        if apps:
            atts = get('%s/ws/v1/cluster/apps/%s/appattempts' % (args.rm, subs['appid']))
            att = ((atts or {}).get('appAttempts') or {}).get('appAttempt') or []
            if att:
                subs['appattemptid'] = subs['appAttemptId'] = att[-1]['appAttemptId']
                subs['attemptId'] = att[-1]['appAttemptId']
        nodes = ((get(args.rm + '/ws/v1/cluster/nodes') or {}).get('nodes') or {}).get('node') or []
        if nodes:
            subs['nodeId'] = nodes[0]['id']
        c = ((get('%s/ws/v1/cluster/apps/%s/appattempts/%s/containers'
                  % (args.rm, subs.get('appid', 'x'), subs.get('appattemptid', 'x'))) or {}) or {}).get('container') or []
        if c:
            subs['containerid'] = subs['containerId'] = c[0]['containerId']
    except Exception as exc:                                    # noqa: BLE001
        print('warning: live id discovery failed: %s' % exc, file=sys.stderr)

    buckets = Counter()
    details = []
    cache = {}

    def fetch(resource, daemon_url=None):
        key = resource['id']
        if key in cache:
            return cache[key]
        path = resource['path']
        for k, v in subs.items():
            path = path.replace('{%s}' % k, str(v))
        url = (daemon_url or args.rm) + path
        if '{' in path:
            cache[key] = ('unresolved-param', None, url)
            return cache[key]
        try:
            doc = get(url)
        except urllib.error.HTTPError as e:
            cache[key] = ('http-%d' % e.code, None, url)
            return cache[key]
        except Exception:                                       # noqa: BLE001
            cache[key] = ('unreachable', None, url)
            return cache[key]
        if doc is None:
            cache[key] = ('nonjson', None, url)
            return cache[key]
        cache[key] = ('ok', doc, url)
        return cache[key]

    for row in reg['fields']:
        if row['origin'] != 'rest' or not row.get('rest'):
            buckets['skipped'] += 1
            continue
        res = resources.get(row['rest'][0]['resource'])
        if res is None:
            buckets['unknown-resource'] += 1
            details.append((row['id'], 'unknown-resource', row['rest'][0]['resource']))
            continue
        if not res['readOnly'] and not args.all:
            buckets['skipped-write'] += 1
            continue
        if res['daemon'] not in ('rm',) and not args.all:
            buckets['skipped-other-daemon'] += 1
            continue
        state, doc, url = fetch(res)
        if state != 'ok':
            buckets[state] += 1
            details.append((row['id'], state, url))
            continue
        present, val = resolve(doc, row['rest'][0]['jsonPath'])
        if present:
            buckets['ok'] += 1
        else:
            buckets['absent'] += 1
            details.append((row['id'], 'absent', row['rest'][0]['jsonPath']))

    if args.json:
        print(json.dumps({'totals': dict(buckets),
                          'failures': [{'id': i, 'state': s, 'where': w} for i, s, w in details]}, indent=1))
    else:
        print('live RM: %s   (ids substituted: %s)' % (args.rm, ', '.join(sorted(subs)) or 'none'))
        for k, v in sorted(buckets.items(), key=lambda kv: -kv[1]):
            print('  %-22s %d' % (k, v))
        real = [(i, s, w) for i, s, w in details if s in ('absent', 'unknown-resource')]
        print('  %-22s %d' % ('--- interesting ---', len(real)))
        for i, s, w in real[:40]:
            print('   %-58s %-16s %s' % (i, s, w))
    return 0


if __name__ == '__main__':
    sys.exit(main())
