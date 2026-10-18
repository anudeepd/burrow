#!/usr/bin/env python
"""dagparse — reference implementation of the burrow Spark DAG extractor.

Spark's REST API does not expose the RDD operation graph; the job page and the stage page embed it, as Graphviz DOT, in
``<div id="dag-viz-metadata">`` (see docs/spark-rest-and-dag.md §3). This module turns that HTML into the ``Dag`` JSON of
docs/contracts/api.md §4 (+ the additive fields listed in the doc), and also contains the REST-only stage-level
fallback (``granularity: "stage"``).

Pure stdlib (``html.parser`` + a ~60-line DOT tokenizer) so it can be mirrored 1:1 in Rust.

CLI::

    dagparse.py job   page.html [--job-id N]        # job page   -> Dag JSON on stdout
    dagparse.py stage page.html [--stage-id N]      # stage page -> Dag JSON on stdout
    dagparse.py regen fixtures/spark/4.2.0          # rewrite every golden dag-*.json next to the raw HTML
    dagparse.py check fixtures/spark/4.2.0          # verify goldens == current parser output (exit 1 on drift)
    dagparse.py verify fixtures/spark/4.2.0         # check + structural validation of every golden (alias --verify)
"""
from __future__ import annotations

import json
import os
import re
import sys
from html.parser import HTMLParser

# ------------------------------------------------------------------------------------------------------------------
# 1. HTML -> raw stage-metadata blocks
# ------------------------------------------------------------------------------------------------------------------


class StageMeta:
    def __init__(self, stage_id: str | None, skipped_attr: str | None):
        self.stage_id = stage_id
        self.skipped_attr = skipped_attr
        self.dot = ""
        self.incoming: list[str] = []
        self.outgoing: list[str] = []
        self.cached: list[str] = []
        self.barrier: list[str] = []
        self.indeterminate: list[str] = []


class _Page:
    def __init__(self):
        self.kind: str | None = None      # "job" | "stage" | None (no DAG block at all)
        self.has_metadata = False         # #dag-viz-metadata present
        self.no_info = False              # <div id="no-info"> present (job page without graph)
        self.stages: list[StageMeta] = []


class _Extract(HTMLParser):
    """Tolerant extraction of ``#dag-viz-metadata > .stage-metadata > .dot-file|.incoming-edge|...``.

    ``convert_charrefs=True`` => text arrives entity-decoded, which is exactly one level of the double escaping (the
    dot text is XML-escaped by Scala's xml literal when Spark writes the page)."""

    VOID = {"br", "hr", "img", "input", "meta", "link"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.page = _Page()
        self.stack: list[tuple[str, str | None]] = []   # (tag, role) for open elements below the metadata root
        self.depth_meta = None                          # nesting depth at which #dag-viz-metadata sits
        self.depth = 0
        self.cur: StageMeta | None = None
        self.role: str | None = None
        self.buf: list[str] = []

    @staticmethod
    def _cls(attrs):
        d = dict(attrs)
        return set((d.get("class") or "").split()), d

    def handle_starttag(self, tag, attrs):
        if tag in self.VOID:
            return
        self.depth += 1
        classes, d = self._cls(attrs)
        if tag == "span" and d.get("id") == "job-dag-viz":
            self.page.kind = "job"
        elif tag == "span" and d.get("id") == "stage-dag-viz":
            self.page.kind = "stage"
        elif tag == "div" and d.get("id") == "no-info":
            self.page.no_info = True
        if tag == "div" and d.get("id") == "dag-viz-metadata":
            self.page.has_metadata = True
            self.depth_meta = self.depth
            return
        if self.depth_meta is None:
            return
        if tag == "div" and "stage-metadata" in classes:
            self.cur = StageMeta(d.get("stage-id"), d.get("skipped"))
            self.page.stages.append(self.cur)
        elif tag == "div" and self.cur is not None:
            for r in ("dot-file", "incoming-edge", "outgoing-edge", "cached-rdd", "barrier-rdd", "indeterminate-rdd"):
                if r in classes:
                    self.role = r
                    self.buf = []

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        if self.role and tag == "div":
            text = "".join(self.buf)
            c = self.cur
            if self.role == "dot-file":
                c.dot = text
            else:
                getattr(c, {"incoming-edge": "incoming", "outgoing-edge": "outgoing", "cached-rdd": "cached",
                            "barrier-rdd": "barrier", "indeterminate-rdd": "indeterminate"}[self.role]).append(text.strip())
            self.role = None
        if self.depth_meta is not None and self.depth == self.depth_meta and tag == "div":
            self.depth_meta = None
            self.cur = None
        self.depth -= 1

    def handle_data(self, data):
        if self.role:
            self.buf.append(data)


def extract_page(html: str) -> _Page:
    p = _Extract()
    p.feed(html)
    p.close()
    return p.page


# ------------------------------------------------------------------------------------------------------------------
# 2. DOT dialect parser (only what RDDOperationGraph.makeDotFile emits)
# ------------------------------------------------------------------------------------------------------------------

_TOKEN = re.compile(r'\s*(?:(?P<arrow>->)|(?P<punct>[{}\[\];=,])|"(?P<str>(?:[^"\\]|\\.)*)"|(?P<id>[A-Za-z0-9_.]+))', re.S)


def tokenize(dot: str):
    pos, n = 0, len(dot)
    while True:
        m = _TOKEN.match(dot, pos)
        if not m:
            if dot[pos:].strip():
                raise ValueError(f"DOT: unexpected input at {pos}: {dot[pos:pos+40]!r}")
            return
        pos = m.end()
        if m.group("arrow"):
            yield ("arrow", "->")
        elif m.group("punct"):
            yield ("punct", m.group("punct"))
        elif m.group("str") is not None:
            yield ("str", m.group("str"))
        else:
            yield ("id", m.group("id"))


_JAVA_ESC = {"b": "\b", "t": "\t", "n": "\n", "f": "\f", "r": "\r", '"': '"', "'": "'", "\\": "\\", "/": "/"}


def java_unescape(s: str) -> str:
    """Inverse of commons-text ``StringEscapeUtils.escapeJava`` (``\\uXXXX`` for non-ASCII, UTF-16 surrogate pairs)."""
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c != "\\" or i + 1 >= n:
            out.append(c)
            i += 1
            continue
        d = s[i + 1]
        if d == "u":
            j = i + 2
            while j < n and s[j] == "u":
                j += 1
            out.append(chr(int(s[j:j + 4], 16)))
            i = j + 4
        elif d in _JAVA_ESC:
            out.append(_JAVA_ESC[d])
            i += 2
        elif d in "01234567":
            j = i + 1
            while j < n and j < i + 4 and s[j] in "01234567":
                j += 1
            out.append(chr(int(s[i + 1:j], 8)))
            i = j
        else:
            out.append(d)
            i += 2
    text = "".join(out)
    # \uD83D\uDE00 style surrogate pairs decode to two lone surrogates; recombine
    return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace") if any(0xD800 <= ord(ch) <= 0xDFFF for ch in text) else text


def xml_unescape(s: str) -> str:
    """Inverse of scala.xml.Utility.escape (&lt; &gt; &amp; &quot;). ``&amp;`` last."""
    return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&amp;", "&")


class DotCluster:
    def __init__(self, name: str):
        self.subgraph_name = name
        self.attrs: dict[str, str] = {}
        self.nodes: list[tuple[int, dict[str, str]]] = []
        self.children: list[DotCluster] = []


class DotGraph:
    def __init__(self):
        self.attrs: dict[str, str] = {}
        self.root: DotCluster | None = None
        self.edges: list[tuple[int, int]] = []


def parse_dot(dot: str) -> DotGraph:
    toks = list(tokenize(dot.strip()))
    i = 0

    def peek(k=0):
        return toks[i + k] if i + k < len(toks) else (None, None)

    def eat(kind=None, val=None):
        nonlocal i
        t = toks[i]
        if (kind and t[0] != kind) or (val and t[1] != val):
            raise ValueError(f"DOT: expected {kind}/{val} got {t} at token {i}")
        i += 1
        return t

    def attr_list():
        attrs = {}
        eat("punct", "[")
        while peek() != ("punct", "]"):
            k = eat("id")[1]
            eat("punct", "=")
            attrs[k] = eat("str")[1]
            if peek() == ("punct", ","):
                eat()
        eat("punct", "]")
        return attrs

    def body(target_attrs, cluster: DotCluster | None, g: DotGraph):
        nonlocal i
        while peek() != ("punct", "}"):
            kind, val = peek()
            if kind == "id" and val == "subgraph":
                eat()
                name = eat("id")[1]
                eat("punct", "{")
                c = DotCluster(name)
                body(c.attrs, c, g)
                eat("punct", "}")
                if cluster is None:
                    if g.root is not None:
                        raise ValueError("DOT: more than one top-level subgraph")
                    g.root = c
                else:
                    cluster.children.append(c)
            elif kind == "id" and peek(1) == ("punct", "="):
                eat()
                eat()
                target_attrs[val] = eat("str")[1]
                eat("punct", ";")
            elif kind == "id" and peek(1) == ("arrow", "->"):
                a = int(eat("id")[1])
                eat()
                b = int(eat("id")[1])
                eat("punct", ";")
                g.edges.append((a, b))
            elif kind == "id" and peek(1) == ("punct", "["):
                nid = int(eat("id")[1])
                attrs = attr_list()
                eat("punct", ";")
                if cluster is None:
                    raise ValueError("DOT: node outside a cluster")
                cluster.nodes.append((nid, attrs))
            else:
                raise ValueError(f"DOT: unexpected token {peek()} at {i}")

    eat("id", "digraph")
    eat("id")  # G
    eat("punct", "{")
    g = DotGraph()
    body(g.attrs, None, g)
    eat("punct", "}")
    if g.root is None:
        raise ValueError("DOT: no root cluster")
    return g


# ------------------------------------------------------------------------------------------------------------------
# 3. DOT -> Dag JSON
# ------------------------------------------------------------------------------------------------------------------

_LABEL_HEAD = re.compile(
    r"^(?P<name>.*) \[(?P<id>\d+)\](?P<flags>(?: \[(?:Cached|Barrier|Indeterminate|Unordered)\])*)$", re.S)
_STAGE_LABEL = re.compile(r"^Stage (\d+)(?: \(attempt (\d+)\))?(?: \(skipped\))?$")


def parse_node_label(raw_label: str, node_id: int) -> dict:
    """label := javaEscape( name " [" id "]" [" [Cached]"] [" [Barrier]"] [" [Indeterminate]"|" [Unordered]"] "<br>" xmlEscape(callsite) )"""
    label = java_unescape(raw_label)
    k = label.rfind("<br>")          # the callsite is XML-escaped so it cannot contain '<': the LAST <br> is the separator
    if k < 0:
        head, callsite = label, ""
    else:
        head, callsite = label[:k], xml_unescape(label[k + 4:])
    m = _LABEL_HEAD.match(head)
    if not m or int(m.group("id")) != node_id:
        # defensive: unknown label shape — keep everything as the name
        return {"name": head, "callsite": callsite, "cached": False, "barrier": False, "determinism": "determinate"}
    flags = m.group("flags")
    det = "indeterminate" if "[Indeterminate]" in flags else "unordered" if "[Unordered]" in flags else "determinate"
    return {"name": m.group("name"), "callsite": callsite, "cached": "[Cached]" in flags,
            "barrier": "[Barrier]" in flags, "determinism": det}


def dot_to_stage(meta: StageMeta, dot: DotGraph) -> dict:
    root = dot.root
    root_label = java_unescape(root.attrs.get("label", ""))
    m = _STAGE_LABEL.match(root_label)
    stage_id = int(meta.stage_id) if meta.stage_id is not None else (int(m.group(1)) if m else -1)
    clusters, nodes = [], []

    def walk(c: DotCluster, parent_id: str | None):
        for nid, attrs in c.nodes:
            info = parse_node_label(attrs.get("label", ""), nid)
            nodes.append({"id": nid, **info, "clusterId": parent_id})
        for ch in c.children:
            cid = ch.attrs.get("id", ch.subgraph_name)
            clusters.append({"id": cid, "name": java_unescape(ch.attrs.get("label", "")), "parentId": parent_id})
            walk(ch, cid)

    walk(root, None)
    return {
        "stageId": stage_id,
        "attempt": int(m.group(2)) if m and m.group(2) else 0,
        "skipped": meta.skipped_attr == "true",
        "label": root_label,
        "clusters": clusters,
        "nodes": nodes,
        "edges": [{"from": a, "to": b} for a, b in dot.edges],
        "incoming": [_edge(x) for x in meta.incoming],
        "outgoing": [_edge(x) for x in meta.outgoing],
    }


def _edge(text: str) -> dict:
    a, b = text.split(",")
    return {"from": int(a), "to": int(b)}


def build_dag(html: str, *, kind: str | None = None, job_id: int | None = None) -> dict | None:
    """Parse a job page / stage page. Returns None if the page carries no graph (skipped-stage page, 404 page,
    job page with ``#no-info``)."""
    page = extract_page(html)
    if not page.has_metadata or not page.stages:
        return None
    kind = kind or page.kind or "job"
    stages = []
    for meta in page.stages:
        stages.append(dot_to_stage(meta, parse_dot(meta.dot)))
    cross = []
    for st in stages:
        for e in st["incoming"]:
            cross.append({"from": e["from"], "to": e["to"], "fromStage": None, "toStage": st["stageId"]})
        for e in st["outgoing"]:   # never emitted by Spark 3.5.9 / 4.2.0, handled for completeness
            cross.append({"from": e["from"], "to": e["to"], "fromStage": st["stageId"], "toStage": None})
    if kind == "job":
        _resolve_stage_endpoints(stages, cross)
    dag = {"kind": kind, "granularity": "rdd"}
    if job_id is not None:
        dag["jobId"] = job_id
    dag["stages"] = [{k: v for k, v in st.items() if k not in ("incoming", "outgoing")} for st in stages]
    dag["edges"] = cross
    return dag


def _resolve_stage_endpoints(stages: list[dict], cross: list[dict]) -> None:
    """Fill ``fromStage`` / ``toStage`` of cross-stage edges.

    The HTML only says "RDD from -> RDD to" (``incoming-edge`` lives in the *consuming* stage). RDD ids are not unique
    across stages (a cached/shared RDD is listed in every stage that pipelines it), so the producing stage is the stage
    (other than the consumer) that contains ``from`` as a *sink* (no intra-stage outgoing edge) – the map-stage output.
    Ties: the lowest stage id (documented ambiguity)."""
    by_id = {s["stageId"]: s for s in stages}
    for e in cross:
        if e["fromStage"] is not None and e["toStage"] is not None:
            continue
        if e["fromStage"] is None:
            cands = [s for s in stages if s["stageId"] != e["toStage"] and any(n["id"] == e["from"] for n in s["nodes"])]
            sinks = [s for s in cands if not any(x["from"] == e["from"] for x in s["edges"])]
            pick = sinks or cands
            e["fromStage"] = min(s["stageId"] for s in pick) if pick else None
        elif e["toStage"] is None:
            cands = [s for s in stages if s["stageId"] != e["fromStage"] and any(n["id"] == e["to"] for n in s["nodes"])]
            e["toStage"] = min(s["stageId"] for s in cands) if cands else None
    _ = by_id


# ------------------------------------------------------------------------------------------------------------------
# 4. REST-only fallback (granularity "stage")
# ------------------------------------------------------------------------------------------------------------------


def rest_fallback_dag(job: dict, stages: list[dict]) -> dict:
    """Stage-level DAG from REST only: ``job`` = ``/jobs/{id}`` JSON, ``stages`` = ``/stages`` list (any variant).

    What REST *does* give: the job's ``stageIds``, per-stage status (``SKIPPED`` for never-run stages of a finished job),
    ``rddIds`` (the RDD ids that belong to the stage; unordered), shuffle read/write bytes, submission/completion times.
    What REST does NOT give: stage parent ids, RDD names/scopes/callsites/parents. Edges are therefore *inferred*:

      A -> B  iff  A.id < B.id, both in the job, A produced shuffle output (shuffleWriteBytes>0 or shuffleWriteRecords>0,
                   or A is SKIPPED) and B consumes shuffle input (shuffleReadBytes>0 / records>0 / fetched blocks>0 /
                   B.status in PENDING|SKIPPED with no metrics), and A finished before B was submitted.

    Only the *nearest* qualifying producers are linked (transitive reduction by 'most recent finished producer before B
    started that has not already been consumed by an intermediate stage' is NOT attempted – see doc for measured accuracy)."""
    sid_set = set(job.get("stageIds", []))
    by_id = {}
    for s in stages:
        if s["stageId"] in sid_set:
            prev = by_id.get(s["stageId"])
            if prev is None or s["attemptId"] > prev["attemptId"]:
                by_id[s["stageId"]] = s
    out_stages = []
    for sid in sorted(sid_set):
        s = by_id.get(sid)
        status = s["status"] if s else "UNKNOWN"
        out_stages.append({
            "stageId": sid,
            "attempt": s["attemptId"] if s else 0,
            "skipped": status == "SKIPPED",
            "label": f"Stage {sid}" + (" (skipped)" if status == "SKIPPED" else ""),
            "clusters": [], "nodes": [], "edges": [],
            "rddIds": sorted(s.get("rddIds", [])) if s else [],
            "status": status,
        })
    edges = []
    ids = sorted(by_id)
    for b in ids:
        sb = by_id[b]
        consumes = (sb.get("shuffleReadBytes", 0) or sb.get("shuffleReadRecords", 0) or sb.get("shuffleRemoteBlocksFetched", 0)
                    or sb.get("shuffleLocalBlocksFetched", 0))
        if not consumes and sb["status"] not in ("PENDING", "SKIPPED"):
            continue
        # nearest earlier producers
        prods = []
        for a in ids:
            if a >= b:
                continue
            sa = by_id[a]
            produces = sa.get("shuffleWriteBytes", 0) or sa.get("shuffleWriteRecords", 0) or sa["status"] == "SKIPPED"
            if produces:
                prods.append(a)
        for a in prods:
            edges.append({"from": None, "to": None, "fromStage": a, "toStage": b})
    return {"kind": "job", "granularity": "stage", "jobId": job["jobId"], "edgesInferred": True,
            "stages": out_stages, "edges": edges}


# ------------------------------------------------------------------------------------------------------------------
# 5. fixtures: regen / check
# ------------------------------------------------------------------------------------------------------------------

_JOB = re.compile(r"^(?P<phase>[^.]+)\.job-(?P<id>\d+)\.html$")
_STAGE = re.compile(r"^(?P<phase>[^.]+)\.stage-(?P<id>\d+)-(?P<att>\d+)\.html$")


def golden_name(phase: str, kind: str, ids: str) -> str:
    return f"dag-{kind}-{ids}.json" if phase == "final" else f"dag-{phase}-{kind}-{ids}.json"


def iter_goldens(workload_dir: str):
    """Yield (golden_filename, dag_dict_or_None, source_html_relpath) for every job/stage page in a workload dir."""
    hd = os.path.join(workload_dir, "html")
    if not os.path.isdir(hd):
        return
    for fn in sorted(os.listdir(hd)):
        m = _JOB.match(fn)
        s = _STAGE.match(fn)
        if not (m or s):
            continue
        with open(os.path.join(hd, fn), encoding="utf-8") as f:
            html = f.read()
        if m:
            jid = int(m.group("id"))
            dag = build_dag(html, kind="job", job_id=jid)
            yield golden_name(m.group("phase"), "job", str(jid)), dag, f"html/{fn}"
        else:
            sid = int(s.group("id"))
            dag = build_dag(html, kind="stage")
            yield golden_name(s.group("phase"), "stage", f"{sid}-{s.group('att')}"), dag, f"html/{fn}"


def dump(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def regen(version_dir: str, check: bool = False) -> int:
    bad = 0
    n = 0
    for w in sorted(os.listdir(version_dir)):
        wd = os.path.join(version_dir, w)
        if not os.path.isdir(os.path.join(wd, "html")):
            continue
        if not check:
            for old in os.listdir(wd):
                if old.startswith("dag-") and old.endswith(".json"):
                    os.remove(os.path.join(wd, old))
        for name, dag, _src in iter_goldens(wd):
            if dag is None:
                continue          # pages without a graph produce no golden
            text = dump(dag)
            path = os.path.join(wd, name)
            n += 1
            if check:
                if not os.path.exists(path) or open(path, encoding="utf-8").read() != text:
                    print("DRIFT", path)
                    bad += 1
            else:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
        for name, dag in iter_fallback_goldens(wd):
            text = dump(dag)
            path = os.path.join(wd, name)
            n += 1
            if check:
                if not os.path.exists(path) or open(path, encoding="utf-8").read() != text:
                    print("DRIFT", path)
                    bad += 1
            else:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
    print(("checked" if check else "wrote"), n, "golden files;", bad, "drift")
    return 1 if bad else 0


def iter_fallback_goldens(workload_dir: str):
    """REST-only fallback goldens for the final phase: dag-fallback-job-N.json from rest/final.{job-N,stages}.json."""
    rd = os.path.join(workload_dir, "rest")
    sp = os.path.join(rd, "final.stages.json")
    if not os.path.exists(sp):
        return
    stages = json.load(open(sp, encoding="utf-8"))
    for fn in sorted(os.listdir(rd)):
        m = re.match(r"^final\.job-(\d+)\.json$", fn)
        if m:
            job = json.load(open(os.path.join(rd, fn), encoding="utf-8"))
            yield f"dag-fallback-job-{int(m.group(1))}.json", rest_fallback_dag(job, stages)


# ------------------------------------------------------------------------------------------------------------------
# 6. structural validation + --verify (self-check over a whole version dir)
# ------------------------------------------------------------------------------------------------------------------


def validate_dag(dag: object, where: str) -> list[str]:
    """Structural check of a ``Dag`` against docs/contracts/api.md §4 (+ additive fields in the doc).

    Additive keys are allowed; only the *required* keys/relations are checked. Relations checked that the contract
    implies but does not spell out: cluster ``parentId`` resolves; node ``clusterId`` resolves; intra-stage edge
    endpoints resolve to node ids; a ``stage``-kind DAG has exactly one stage."""
    errs: list[str] = []

    def need(cond: bool, msg: str) -> None:
        if not cond:
            errs.append(f"{where}: {msg}")

    if not isinstance(dag, dict):
        return [f"{where}: not a JSON object"]
    need(dag.get("kind") in ("job", "stage"), f"kind={dag.get('kind')!r}")
    need(dag.get("granularity") in ("rdd", "stage"), f"granularity={dag.get('granularity')!r}")
    if dag.get("kind") == "job":
        need(isinstance(dag.get("jobId"), int), f"jobId={dag.get('jobId')!r} (job kind)")
    stages = dag.get("stages")
    need(isinstance(stages, list) and len(stages) > 0, "stages must be a non-empty list")
    if dag.get("kind") == "stage" and isinstance(stages, list):
        need(len(stages) == 1, f"stage kind had {len(stages)} stages")
    for st in stages if isinstance(stages, list) else []:
        sid = st.get("stageId")
        tag = f"stage {sid!r}"
        need(isinstance(sid, int), f"{tag}: stageId not int")
        need(isinstance(st.get("skipped"), bool), f"{tag}: skipped not bool")
        need(isinstance(st.get("label"), str), f"{tag}: label not str")
        need(isinstance(st.get("clusters"), list), f"{tag}: clusters not list")
        need(isinstance(st.get("nodes"), list), f"{tag}: nodes not list")
        need(isinstance(st.get("edges"), list), f"{tag}: edges not list")
        cids = set()
        for c in st.get("clusters", []) if isinstance(st.get("clusters"), list) else []:
            need(isinstance(c.get("id"), str) and c.get("id") != "", f"{tag}: cluster.id not a non-empty str")
            need(isinstance(c.get("name"), str), f"{tag}: cluster.name not str")
            need(c.get("parentId") is None or isinstance(c.get("parentId"), str), f"{tag}: cluster.parentId type")
            if isinstance(c.get("id"), str):
                cids.add(c["id"])
        for c in st.get("clusters", []) if isinstance(st.get("clusters"), list) else []:
            need(c.get("parentId") is None or c.get("parentId") in cids,
                 f"{tag}: cluster {c.get('id')!r} parentId {c.get('parentId')!r} unresolved")
        nids = set()
        for n in st.get("nodes", []) if isinstance(st.get("nodes"), list) else []:
            need(isinstance(n.get("id"), int), f"{tag}: node.id not int")
            need(isinstance(n.get("name"), str), f"{tag}: node.name not str")
            need(isinstance(n.get("callsite"), str), f"{tag}: node.callsite not str")
            need(isinstance(n.get("cached"), bool), f"{tag}: node.cached not bool")
            need(n.get("clusterId") is None or isinstance(n.get("clusterId"), str), f"{tag}: node.clusterId type")
            if isinstance(n.get("id"), int):
                nids.add(n["id"])
        for n in st.get("nodes", []) if isinstance(st.get("nodes"), list) else []:
            cid = n.get("clusterId")
            need(cid is None or cid in cids, f"{tag}: node {n.get('id')} clusterId {cid!r} unresolved")
        for e in st.get("edges", []) if isinstance(st.get("edges"), list) else []:
            need(e.get("from") in nids and e.get("to") in nids,
                 f"{tag}: intra-stage edge {e.get('from')}->{e.get('to')} endpoint not a node id")
    for i, e in enumerate(dag.get("edges", []) if isinstance(dag.get("edges"), list) else []):
        ok = all(e.get(k) is None or isinstance(e.get(k), int) for k in ("from", "to", "fromStage", "toStage"))
        need(ok, f"cross edge #{i} {e!r}: from/to/fromStage/toStage must be int-or-null")
    return errs


def verify(version_dir: str) -> int:
    """``--verify``: reparse every captured HTML page and (a) confirm the golden on disk is byte-identical to the fresh
    parse, (b) structurally validate every golden JSON. Exit 0 iff a whole version dir is clean."""
    drift = regen(version_dir, check=True)
    n = 0
    errs: list[str] = []
    for w in sorted(os.listdir(version_dir)):
        wd = os.path.join(version_dir, w)
        if not os.path.isdir(wd):
            continue
        for fn in sorted(os.listdir(wd)):
            if not (fn.startswith("dag-") and fn.endswith(".json")):
                continue
            n += 1
            try:
                with open(os.path.join(wd, fn), encoding="utf-8") as f:
                    dag = json.load(f)
            except Exception as e:  # noqa: BLE001
                errs.append(f"{w}/{fn}: unreadable JSON: {e}")
                continue
            errs.extend(validate_dag(dag, f"{w}/{fn}"))
    for e in errs:
        print("INVALID", e)
    print(f"verify: {n} goldens validated, {len(errs)} invalid, {drift} drifted")
    return 1 if (drift or errs) else 0


def main(argv):
    if len(argv) > 1 and argv[1] == "--verify":
        argv = ["dagparse", "verify"] + argv[2:]
    if len(argv) < 3 or argv[1] not in ("job", "stage", "regen", "check", "verify"):
        print(__doc__)
        return 2
    cmd, target = argv[1], argv[2]
    if cmd == "verify":
        return verify(target)
    if cmd in ("regen", "check"):
        return regen(target, check=(cmd == "check"))
    html = open(target, encoding="utf-8").read()
    jid = None
    if "--job-id" in argv:
        jid = int(argv[argv.index("--job-id") + 1])
    dag = build_dag(html, kind=cmd, job_id=jid)
    sys.stdout.write(dump(dag))
    return 0 if dag else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
