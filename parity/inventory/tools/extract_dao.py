#!/usr/bin/env python3
"""Minimal Java/JAXB DAO field extractor used by build_rest_rm.py.

It is NOT a Java parser: it tokenises class bodies at brace depth 1 and returns, per (possibly nested) class,
  * class annotations (XmlRootElement/XmlAccessorType/XmlType/XmlSeeAlso/...),
  * `extends` parent simple name,
  * every field declaration (modifiers, annotations, generic type, name, line) in declaration order,
  * every method (name, return type, params, annotations, line) -- needed only for PROPERTY / PUBLIC_MEMBER access.
JAXB visibility rules are applied by `json_fields()`:
  FIELD        -> every non-static, non-@XmlTransient field (any visibility)  [@XmlElement/@XmlAttribute on getters ignored here]
  NONE         -> only members carrying an explicit JAXB annotation (@XmlElement ...)
  PUBLIC_MEMBER (default) -> public fields + public getter/setter pairs (+ explicitly annotated members)
Source line numbers are 1-based into the original file (comments are blanked in place, never removed).
"""
import re, os, sys, json

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '.cluster', 'src-extract')
ROOT = os.path.normpath(ROOT)


def blank_comments(src):
    """Replace comments (and string-literal contents) by spaces, keeping newlines so line numbers are stable."""
    out = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if src.startswith('//', i):
            j = src.find('\n', i)
            j = n if j < 0 else j
            out.append(' ' * (j - i))
            i = j
        elif src.startswith('/*', i):
            j = src.find('*/', i + 2)
            j = n if j < 0 else j + 2
            seg = src[i:j]
            out.append(''.join('\n' if ch == '\n' else ' ' for ch in seg))
            i = j
        elif c == '"':
            j = i + 1
            while j < n and src[j] != '"':
                if src[j] == '\\':
                    j += 1
                j += 1
            # keep the literal (needed for @XmlElement(name = "x")) but neutralise braces/semicolons inside
            lit = src[i:j + 1]
            out.append(lit.replace('{', '\x01').replace('}', '\x02').replace(';', '\x03'))
            i = j + 1
        elif c == "'":
            j = i + 1
            while j < n and src[j] != "'":
                if src[j] == '\\':
                    j += 1
                j += 1
            out.append(' ' * (j + 1 - i))
            i = j + 1
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def unmask(s):
    return s.replace('\x01', '{').replace('\x02', '}').replace('\x03', ';')


def match_brace(s, i):
    """s[i] == '{' -> index of matching '}'."""
    depth = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError('unbalanced')


ANN_RE = re.compile(r'@(\w+(?:\.\w+)*)\s*(\((?:[^()]|\([^()]*\))*\))?')


def parse_annotations(header):
    anns = []
    for m in ANN_RE.finditer(header):
        name = m.group(1).split('.')[-1]
        args = m.group(2)[1:-1].strip() if m.group(2) else ''
        anns.append({'name': name, 'args': args})
    return anns


def strip_annotations(header):
    return ANN_RE.sub(' ', header)


def ann_arg(ann, key='name'):
    m = re.search(r'\b' + key + r'\s*=\s*"([^"]*)"', unmask(ann['args']))
    return m.group(1) if m else None


def find_ann(anns, name):
    for a in anns:
        if a['name'] == name:
            return a
    return None


def line_of(src, idx):
    return src.count('\n', 0, idx) + 1


def parse_body(src, start, end, classes, outer=None):
    """Parse members of the class body src[start:end] (exclusive of braces)."""
    i = start
    member_start = start
    while i < end:
        ch = src[i]
        if ch in ';{':
            header = src[member_start:i]
            hstrip = strip_annotations(header).strip()
            if ch == '{':
                close = match_brace(src, i)
                is_type = re.search(r'\b(class|enum|interface)\s+(\w+)', hstrip)
                if is_type and '=' not in hstrip.split(is_type.group(1))[0] and '(' not in hstrip.split(is_type.group(1))[0]:
                    parse_class(src, member_start, i, close, classes, outer)
                elif '(' in hstrip and '=' not in hstrip.split('(')[0]:
                    # method / constructor
                    m = re.match(r'(?P<mods>(?:\b(?:public|protected|private|static|final|abstract|synchronized|native)\b\s*)*)'
                                 r'(?:<[^>]*>\s*)?(?P<ret>[\w.<>\[\],? ]+?\s+)?(?P<name>\w+)\s*\((?P<params>.*)$', hstrip, re.S)
                    if m:
                        classes[-1].setdefault('methods', []) if False else None
                        cur = current_class(classes, outer)
                        if cur is not None:
                            cur['methods'].append({
                                'name': m.group('name'),
                                'ret': (m.group('ret') or '').strip(),
                                'mods': m.group('mods').split(),
                                'params': unmask(m.group('params')).rsplit(')', 1)[0].strip(),
                                'anns': parse_annotations(header),
                                'line': line_of(src, member_start + len(header) - len(header.lstrip())),
                                'body': unmask(src[i:close + 1]),
                            })
                else:
                    # initializer block or field initialiser containing braces ( = new X() {..}; ) -> skip to ';'
                    j = close + 1
                    if '=' in hstrip:
                        k = src.find(';', j)
                        close = k if k >= 0 else j
                        header = src[member_start:close]
                        add_field(src, header, member_start, classes, outer)
                i = close + 1
                member_start = i
                continue
            else:  # ';'
                if hstrip:
                    add_field(src, header, member_start, classes, outer)
                i += 1
                member_start = i
                continue
        i += 1


def current_class(classes, outer):
    return classes[outer] if outer is not None else classes[-1]


def add_field(src, header, member_start, classes, outer):
    cur = current_class(classes, outer)
    if cur is None:
        return
    if cur.get('kind') == 'enum':
        return
    anns = parse_annotations(header)
    h = strip_annotations(header).strip()
    if '(' in h.split('=')[0]:
        return  # abstract method decl / something else
    decl = h.split('=')[0].strip()
    m = re.match(r'(?P<mods>(?:\b(?:public|protected|private|static|final|transient|volatile)\b\s*)*)(?P<type>.+?)\s+(?P<name>\w+)\s*$', decl, re.S)
    if not m:
        return
    first_code = member_start + (len(header) - len(header.lstrip()))
    # line of the field name: search from the declaration start
    off = header.find(m.group('name'), len(header) - len(header.rstrip()) if False else 0)
    # robust: line of the last occurrence of name before '=' / end
    pos = member_start
    seg = src[member_start:member_start + len(header)]
    ni = seg.split('=')[0].rstrip().rfind(m.group('name'))
    ln = line_of(src, member_start + ni)
    cur['fields'].append({
        'name': m.group('name'),
        'type': re.sub(r'\s+', ' ', unmask(m.group('type')).strip()),
        'mods': m.group('mods').split(),
        'anns': [{'name': a['name'], 'args': unmask(a['args'])} for a in anns],
        'init': unmask(h.split('=', 1)[1].strip()) if '=' in h else None,
        'line': ln,
    })


def parse_class(src, hstart, bopen, bclose, classes, outer):
    header = src[hstart:bopen]
    anns = parse_annotations(header)
    h = strip_annotations(header).strip()
    m = re.search(r'\b(class|enum|interface)\s+(\w+)(?:\s*<[^>{]*>)?(?:\s+extends\s+([\w.<>, ?]+?))?(?:\s+implements\s+[\w.<>, ?]+?)?\s*$', h, re.S)
    if not m:
        return
    kind, name, ext = m.group(1), m.group(2), m.group(3)
    cls = {'name': name, 'kind': kind, 'extends': (ext or '').split('<')[0].split('.')[-1].strip() or None,
           'anns': [{'name': a['name'], 'args': unmask(a['args'])} for a in anns],
           'fields': [], 'methods': [], 'line': line_of(src, bopen), 'outer': classes[outer]['name'] if outer is not None else None}
    classes.append(cls)
    idx = len(classes) - 1
    if kind == 'enum':
        body = src[bopen + 1:bclose]
        cls['enum_values'] = enum_constants(body)
        return
    parse_body(src, bopen + 1, bclose, classes, idx)


def enum_constants(body):
    depth = 0
    buf = ''
    for ch in body:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if depth == 0 and ch in ';':
            break
        buf += ch
    out = []
    depth = 0
    cur = ''
    for ch in buf + ',':
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            t = ANN_RE.sub('', cur).strip()
            m = re.match(r'(\w+)', t)
            if m:
                out.append(m.group(1))
            cur = ''
        else:
            cur += ch
    return out


def parse_file(path):
    raw = open(path, encoding='utf-8').read()
    src = blank_comments(raw)
    classes = []
    i = 0
    n = len(src)
    # top level: find type declarations
    pos = 0
    for m in re.finditer(r'(?m)^(?:[ \t]*@[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?[ \t]*\n)*[ \t]*(?:public\s+|final\s+|abstract\s+)*(?:class|enum|interface)\s+\w+', src):
        if m.start() < pos:
            continue
        bo = src.find('{', m.end())
        bc = match_brace(src, bo)
        parse_class(src, m.start(), bo, bc, classes, None)
        pos = bc
    return classes


def simple(t):
    return t.split('.')[-1]


def getter_prop(m):
    """JAXB property name for a getter method (java.beans decapitalize semantics used by the RI)."""
    n = m['name']
    for p in ('get', 'is'):
        if n.startswith(p) and len(n) > len(p):
            base = n[len(p):]
            if len(base) > 1 and base[0].isupper() and base[1].isupper():
                return base
            return base[0].lower() + base[1:]
    return None


def json_fields(cls, access):
    """Return [(jsonName, field_dict_or_method_dict, origin)] for a class given the effective XmlAccessType."""
    out = []
    byname = {f['name']: f for f in cls['fields']}
    for f in cls['fields']:
        anns = {a['name']: a for a in f['anns']}
        if 'static' in f['mods'] or 'XmlTransient' in anns:
            continue
        explicit = any(k in anns for k in ('XmlElement', 'XmlAttribute', 'XmlElementWrapper', 'XmlElements', 'XmlValue'))
        if access == 'FIELD' or explicit or (access == 'PUBLIC_MEMBER' and 'public' in f['mods']):
            nm = None
            for k in ('XmlElement', 'XmlAttribute', 'XmlElementWrapper'):
                if k in anns:
                    v = ann_arg(anns[k], 'name')
                    if v:
                        nm = v
                        break
            out.append((nm or f['name'], f, 'field'))
    if access in ('PUBLIC_MEMBER', 'PROPERTY'):
        setters = {m['name'] for m in cls['methods'] if m['name'].startswith('set')}
        for m in cls['methods']:
            p = getter_prop(m)
            if p and 'public' in m['mods'] and 'static' not in m['mods'] and m['params'] == '':
                has_set = ('set' + m['name'][3 if m['name'].startswith('get') else 2:]) in setters
                if has_set:
                    out.append((p, m, 'getter'))
    return out


def effective_access(cls, by_name):
    c = cls
    while c is not None:
        a = [x for x in c['anns'] if x['name'] == 'XmlAccessorType']
        if a:
            m = re.search(r'XmlAccessType\.(\w+)', a[0]['args'])
            return m.group(1)
        c = by_name.get(c['extends']) if c['extends'] else None
    return 'PUBLIC_MEMBER'


if __name__ == '__main__':
    for c in parse_file(sys.argv[1]):
        print(json.dumps(c, indent=1)[:3000])
