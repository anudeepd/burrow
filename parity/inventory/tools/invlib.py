"""Shared helpers for gen_rest_nm.py / gen_rest_daemon.py / gen_legacy_other.py.

Source pointers are relative to .cluster/src-extract/ (see FORMAT.md).  Aliases below keep the
generator scripts short; `S("nm:dao/NodeInfo.java", 33)` -> full relative path + ":33".
"""
import os
import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUT = os.path.join(ROOT, "parity", "inventory", "src")

ALIAS = {
    "nm": "hadoop-yarn-server-nodemanager/org/apache/hadoop/yarn/server/nodemanager/webapp/",
    "nmr": "hadoop-yarn-server-nodemanager/org/apache/hadoop/yarn/server/nodemanager/",
    "sc": "hadoop-yarn-server-common/org/apache/hadoop/yarn/server/webapp/",
    "ahs": "hadoop-yarn-server-applicationhistoryservice/org/apache/hadoop/yarn/server/applicationhistoryservice/webapp/",
    "tl": "hadoop-yarn-server-applicationhistoryservice/org/apache/hadoop/yarn/server/timeline/webapp/",
    "hs": "hadoop-mapreduce-client-hs/org/apache/hadoop/mapreduce/v2/hs/webapp/",
    "px": "hadoop-yarn-server-web-proxy/org/apache/hadoop/yarn/server/webproxy/",
    "yc": "hadoop-yarn-common/org/apache/hadoop/yarn/",
    "hc": "hadoop-common/org/apache/hadoop/",
    "api": "hadoop-yarn-api/org/apache/hadoop/yarn/api/records/",
    "x": "",
}


def S(spec, line):
    k, _, rest = spec.partition(":")
    return "%s%s:%d" % (ALIAS[k], rest, line)


def JAVA(spec):
    k, _, rest = spec.partition(":")
    p = ALIAS[k] + rest
    if p.endswith(".java"):
        p = p[:-5]
    parts = p.split("/")
    i = next((j for j, x in enumerate(parts) if x == "org"), 0)
    return ".".join(parts[i:])


def F(name, type="string", line=None, file=None, array=False, ref=None, values=None,
      nullable=False, when=None, unit=None, note=""):
    d = {
        "name": name, "type": type, "array": array, "ref": ref, "values": values or [],
        "nullable": nullable, "when": when or [],
    }
    if unit:
        d["unit"] = unit
    d["source"] = S(file, line) if file and line else None
    d["note"] = note
    return d


def OBJ(objects, name, file, line, fields, xml_root=None, extends=None, note=None, java=None):
    o = {"java": java or JAVA(file), "source": S(file, line), "extends": extends,
         "xmlRoot": xml_root, "fields": fields}
    if note:
        o["note"] = note
    assert name not in objects, name
    objects[name] = o


def P(name, where="query", type="string", required=False, values=None, doc="", src=None, default=None):
    d = {"name": name, "in": where, "type": type, "required": required,
         "values": values or [], "doc": doc, "source": src}
    if default is not None:
        d["default"] = default
    return d


def RES(id, daemon, method, path, *, contract=None, allow=False, ro=True, params=None,
        produces=None, response=None, errors=None, when=None, acl="", src=None, note=""):
    return {
        "id": id, "daemon": daemon, "method": method, "path": path, "contractPath": contract,
        "allowlist": allow, "readOnly": ro, "params": params or [], "produces": produces or [],
        "response": response, "errors": errors or [], "when": when or [], "acl": acl,
        "source": src, "note": note,
    }


def resp(obj=None, root=None, shape="", ctype="application/json"):
    return {"object": obj, "jsonRoot": root, "shape": shape, "contentType": ctype}


def dump(fname, data, header):
    path = os.path.join(OUT, fname)
    with open(path, "w") as f:
        f.write(header)
        yaml.safe_dump(data, f, sort_keys=False, width=100000, allow_unicode=True)
    # reload check
    with open(path) as f:
        yaml.safe_load(f)
    return path
