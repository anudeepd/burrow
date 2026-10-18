//! The Spark **RDD DAG extractor**: Spark's UI HTML `#dag-viz-metadata` DOT → the `Dag` JSON of
//! `docs/contracts/api.md` §4 (plus the additive fields audited in `docs/spark-rest-and-dag.md` §6).
//!
//! Why HTML at all: Spark's REST API never exposes the RDD operation graph — only the job page
//! (`/jobs/job/?id=N`) and the stage page (`/stages/stage/?id=N&attempt=M`) embed it as Graphviz DOT in
//! `<div id="dag-viz-metadata">`. This module is a 1:1 mirror of the reference implementation
//! `fixtures/spark/tools/dagparse.py`, so every golden `dag-*.json` reproduces exactly:
//!
//! * [`parse`] / [`build_dag`] — page HTML → [`Dag`] (job: every stage of the job incl. skipped; stage:
//!   exactly one). A page without a graph yields `Ok(None)` (skipped stage page, live race); a page with
//!   `#no-info` yields [`DagError::NoInfo`] (unknown job/stage id).
//! * [`rest_fallback_dag`] — the REST-only fallback: `granularity:"stage"`, `edgesInferred:true`, stage
//!   statuses and `rddIds`, edges **inferred** from shuffle metrics (never authoritative).
//! * [`single_stage_fallback`] — a one-stage fallback for a stage whose page has no graph.
//! * [`stage_from_job_dag`] — a SKIPPED stage's DAG recovered from the enclosing job page (the critical
//!   rule: a skipped-stage page renders a placeholder, the job page does not).
//!
//! Lineage: `spark/dag.rs` ↔ `fixtures/spark/tools/dagparse.py`; the fixture goldens are the oracle.
//!
//! Notes on the pipeline (each step is load-bearing):
//! 1. HTML entity decode **once** (Spark's DOT is XML-escaped by a Scala XML literal).
//! 2. Java-`unescape` the DOT attribute (Spark used commons-text `escapeJava`: `\n \t \" \\ \uXXXX`).
//! 3. The node label was built as `javaEscape(name " [id]" flags "<br>" xmlEscape(callsite))`, so the
//!    callsite is XML-unescaped **again** after the last `<br>`.
//!
//! Nothing here forwards HTML: the route layer turns the returned [`Dag`] into JSON.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Largest UI page we will buffer for extraction. The biggest observed job page is ~300 KiB; anything
/// near this cap is a symptom (proxy error page, wrong upstream), not a DAG.
pub const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DagKind {
    Job,
    Stage,
}

impl DagKind {
    /// Page route suffix for this kind (relative to the Spark HTML base).
    pub fn html_path(self) -> &'static str {
        match self {
            Self::Job => "jobs/job/",
            Self::Stage => "stages/stage/",
        }
    }
}

/// `"rdd"` = the DOT operation graph was available; `"stage"` = REST-only fallback (no RDD detail).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Granularity {
    Rdd,
    Stage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Determinism {
    Determinate,
    Unordered,
    Indeterminate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Dag {
    pub kind: DagKind,
    pub granularity: Granularity,
    #[serde(rename = "jobId", default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<i64>,
    #[serde(
        rename = "edgesInferred",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub edges_inferred: Option<bool>,
    pub stages: Vec<DagStage>,
    pub edges: Vec<CrossEdge>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DagStage {
    #[serde(rename = "stageId")]
    pub stage_id: i64,
    pub attempt: i64,
    pub skipped: bool,
    pub label: String,
    pub clusters: Vec<DagCluster>,
    pub nodes: Vec<DagNode>,
    pub edges: Vec<IntraEdge>,
    #[serde(rename = "rddIds", default, skip_serializing_if = "Option::is_none")]
    pub rdd_ids: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DagCluster {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DagNode {
    pub id: i64,
    pub name: String,
    pub callsite: String,
    pub cached: bool,
    pub barrier: bool,
    pub determinism: Determinism,
    #[serde(rename = "clusterId")]
    pub cluster_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntraEdge {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrossEdge {
    pub from: Option<i64>,
    pub to: Option<i64>,
    #[serde(rename = "fromStage")]
    pub from_stage: Option<i64>,
    #[serde(rename = "toStage")]
    pub to_stage: Option<i64>,
}

/// Everything that can go wrong turning a UI page into a [`Dag`]. The route layer maps these onto the
/// contract's error states; the fixture tests assert the variant for the captured error pages.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DagError {
    #[error("the Spark UI page is not valid UTF-8 ({0})")]
    Encoding(String),
    #[error("the Spark UI page is truncated (an element never closes)")]
    Truncated,
    #[error("the Spark UI page says there is no information to display for this job or stage")]
    NoInfo,
    #[error("the Spark DAG metadata is malformed: {0}")]
    Malformed(String),
    #[error("the Spark UI page is {bytes} bytes, above the {cap}-byte extraction cap")]
    TooLarge { bytes: usize, cap: usize },
}

impl DagError {
    /// Contract §1 `hint` for the error state the SPA renders.
    pub fn hint(&self) -> &'static str {
        match self {
            Self::Encoding(_) | Self::Truncated | Self::Malformed(_) => {
                "the Spark UI returned an incomplete page; the DAG is served from Spark's REST API instead"
            }
            Self::NoInfo => "Spark has no information for this job or stage id",
            Self::TooLarge { .. } => {
                "the page is far larger than any Spark DAG page; check the resolved Spark REST base"
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------
// HTML → raw stage-metadata blocks
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    DotFile,
    Incoming,
    Outgoing,
    Cached,
    Barrier,
    Indeterminate,
}

impl Role {
    fn of(class: &str) -> Option<Role> {
        Some(match class {
            "dot-file" => Role::DotFile,
            "incoming-edge" => Role::Incoming,
            "outgoing-edge" => Role::Outgoing,
            "cached-rdd" => Role::Cached,
            "barrier-rdd" => Role::Barrier,
            "indeterminate-rdd" => Role::Indeterminate,
            _ => return None,
        })
    }
}

#[derive(Debug, Default, PartialEq)]
struct StageMeta {
    stage_id: Option<i64>,
    skipped: bool,
    dot: String,
    incoming: Vec<(i64, i64)>,
    outgoing: Vec<(i64, i64)>,
}

#[derive(Debug, Default, PartialEq)]
struct Page {
    kind: Option<DagKind>,
    has_metadata: bool,
    no_info: bool,
    stages: Vec<StageMeta>,
}

struct Tag<'a> {
    name: &'a str,
    closing: bool,
    attrs: &'a str,
    /// Index of `<`.
    start: usize,
    /// Index just past `>`.
    end: usize,
}

/// Iterate tags, skipping comments/doctypes/stray `<`. Stops at the first unterminated tag.
struct Tags<'a> {
    html: &'a str,
    pos: usize,
}

impl<'a> Iterator for Tags<'a> {
    type Item = Tag<'a>;

    fn next(&mut self) -> Option<Tag<'a>> {
        loop {
            let rest = &self.html[self.pos..];
            let lt = rest.find('<')?;
            let at = self.pos + lt;
            let after = &self.html[at + 1..];
            if after.starts_with("!--") {
                let close = self.html[at..].find("-->")?;
                self.pos = at + close + 3;
                continue;
            }
            if after.starts_with('!') || after.starts_with('?') {
                let close = self.html[at..].find('>')?;
                self.pos = at + close + 1;
                continue;
            }
            let closing = after.starts_with('/');
            let name_start = at + 1 + usize::from(closing);
            let name_len = self.html[name_start..]
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == ':'))
                .unwrap_or(self.html.len() - name_start);
            if name_len == 0 {
                self.pos = at + 1; // a stray '<' in text
                continue;
            }
            let name_end = name_start + name_len;
            // Find the closing '>' respecting quoted attribute values.
            let mut i = name_end;
            let mut quote: Option<u8> = None;
            let bytes = self.html.as_bytes();
            while i < bytes.len() {
                let b = bytes[i];
                match quote {
                    Some(q) => {
                        if b == q {
                            quote = None;
                        }
                    }
                    None => {
                        if b == b'"' || b == b'\'' {
                            quote = Some(b);
                        } else if b == b'>' {
                            break;
                        }
                    }
                }
                i += 1;
            }
            if i >= bytes.len() {
                self.pos = bytes.len();
                return None;
            }
            let tag = Tag {
                name: &self.html[name_start..name_end],
                closing,
                attrs: &self.html[name_end..i],
                start: at,
                end: i + 1,
            };
            self.pos = i + 1;
            return Some(tag);
        }
    }
}

fn attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let b = attrs.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && !b[i].is_ascii_alphabetic() {
            i += 1;
        }
        let s = i;
        while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'-' || b[i] == b':') {
            i += 1;
        }
        let key = &attrs[s..i];
        let mut j = i;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < b.len() && b[j] == b'=' {
            j += 1;
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
                let q = b[j];
                j += 1;
                let vs = j;
                while j < b.len() && b[j] != q {
                    j += 1;
                }
                let v = &attrs[vs..j];
                if key == name {
                    return Some(v);
                }
                i = if j < b.len() { j + 1 } else { j };
            } else {
                let vs = j;
                while j < b.len() && !b[j].is_ascii_whitespace() && b[j] != b'>' {
                    j += 1;
                }
                let v = &attrs[vs..j];
                if key == name {
                    return Some(v);
                }
                i = j;
            }
        } else if key == name {
            return Some("");
        }
    }
    None
}

fn has_class(attrs: &str, class: &str) -> bool {
    attr(attrs, "class").is_some_and(|c| c.split_ascii_whitespace().any(|x| x == class))
}

/// Decode the character references an HTML parser would (`&quot; &lt; &gt; &amp;` from Spark's XML
/// literal, plus numeric refs and the handful of named refs HTML templates use). Unknown references are
/// left verbatim, exactly like `html.parser`.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'&' {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        // &#123; / &#x1F600; / &name;
        let rest = &s[i..];
        let semi = rest.find(';').filter(|k| *k <= 12);
        let Some(semi) = semi else {
            out.push('&');
            i += 1;
            continue;
        };
        let body = &rest[1..semi];
        let decoded: Option<char> =
            if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = body.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                match body {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some('\u{a0}'),
                    _ => None,
                }
            };
        match decoded {
            Some(c) => {
                out.push(c);
                i += semi + 1;
            }
            None => {
                out.push('&');
                i += 1;
            }
        }
    }
    out
}

/// Inverse of scala.xml.Utility.escape (`&amp;` last, so `&amp;lt;` → `&lt;`).
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

/// Inverse of commons-text `StringEscapeUtils.escapeJava` (`\n \t \" \\ \uXXXX`, octal, surrogate pairs).
fn java_unescape(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c != '\\' || i + 1 >= chars.len() {
            out.push(c);
            i += 1;
            continue;
        }
        let d = chars[i + 1];
        if d == 'u' {
            let mut j = i + 2;
            while j < chars.len() && chars[j] == 'u' {
                j += 1;
            }
            let hex: String = chars[j..(j + 4).min(chars.len())].iter().collect();
            let code = u32::from_str_radix(&hex, 16).unwrap_or(0xFFFD);
            i = j + 4;
            if (0xD800..=0xDBFF).contains(&code) {
                // High surrogate: recombine with a following `\uDC00..\uDFFF`, else replacement.
                let mut k = i;
                let mut combined = None;
                if k + 1 < chars.len() && chars[k] == '\\' && chars[k + 1] == 'u' {
                    let mut m = k + 2;
                    while m < chars.len() && chars[m] == 'u' {
                        m += 1;
                    }
                    let hex2: String = chars[m..(m + 4).min(chars.len())].iter().collect();
                    if let Ok(low) = u32::from_str_radix(&hex2, 16)
                        && (0xDC00..=0xDFFF).contains(&low)
                    {
                        let cp = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                        combined = char::from_u32(cp);
                        k = m + 4;
                    }
                }
                match combined {
                    Some(ch) => {
                        out.push(ch);
                        i = k;
                    }
                    None => out.push('\u{FFFD}'),
                }
            } else {
                out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
            }
        } else if d == 'b' {
            out.push('\u{8}');
            i += 2;
        } else if d == 't' {
            out.push('\t');
            i += 2;
        } else if d == 'n' {
            out.push('\n');
            i += 2;
        } else if d == 'f' {
            out.push('\u{c}');
            i += 2;
        } else if d == 'r' {
            out.push('\r');
            i += 2;
        } else if d == '"' || d == '\'' || d == '\\' || d == '/' {
            out.push(d);
            i += 2;
        } else if ('0'..='7').contains(&d) {
            let mut j = i + 1;
            while j < chars.len() && j < i + 4 && ('0'..='7').contains(&chars[j]) {
                j += 1;
            }
            let oct: String = chars[i + 1..j].iter().collect();
            out.push(
                char::from_u32(u32::from_str_radix(&oct, 8).unwrap_or(0xFFFD))
                    .unwrap_or('\u{FFFD}'),
            );
            i = j;
        } else {
            out.push(d);
            i += 2;
        }
    }
    out
}

fn extract(html: &str) -> Result<Page, DagError> {
    let mut page = Page {
        kind: if html.contains("id=\"job-dag-viz\"") || html.contains("id='job-dag-viz'") {
            Some(DagKind::Job)
        } else if html.contains("id=\"stage-dag-viz\"") || html.contains("id='stage-dag-viz'") {
            Some(DagKind::Stage)
        } else {
            None
        },
        ..Page::default()
    };
    page.no_info = html.contains("id=\"no-info\"") || html.contains("id='no-info'");

    // Locate `<div id="dag-viz-metadata" …>` without trusting the rest of the page's markup.
    let needle = ["id=\"dag-viz-metadata\"", "id='dag-viz-metadata'"]
        .into_iter()
        .filter_map(|n| html.find(n))
        .min();
    let Some(needle_at) = needle else {
        return Ok(page);
    };
    let Some(gt) = html[needle_at..].find('>') else {
        return Err(DagError::Truncated);
    };
    page.has_metadata = true;

    let mut depth: i32 = 1;
    let mut cur: Option<StageMeta> = None;
    let mut cur_depth: i32 = 0;
    let mut role: Option<(Role, i32, usize)> = None;

    let tags = Tags {
        html,
        pos: needle_at + gt + 1,
    };
    for tag in tags {
        if !tag.name.eq_ignore_ascii_case("div") {
            continue;
        }
        if tag.closing {
            if let Some((r, d, start)) = role
                && d == depth
            {
                let text = &html[start..tag.start];
                if let Some(c) = cur.as_mut() {
                    apply_role(c, r, text)?;
                }
                role = None;
            }
            if cur.is_some() && cur_depth == depth {
                page.stages.push(cur.take().expect("checked"));
            }
            depth -= 1;
            if depth == 0 {
                break;
            }
        } else {
            depth += 1;
            if cur.is_none() && has_class(tag.attrs, "stage-metadata") {
                let stage_id = match attr(tag.attrs, "stage-id") {
                    Some(raw) => Some(raw.trim().parse::<i64>().map_err(|_| {
                        DagError::Malformed(format!("stage-metadata@stage-id={raw:?}"))
                    })?),
                    None => None,
                };
                cur = Some(StageMeta {
                    stage_id,
                    skipped: attr(tag.attrs, "skipped") == Some("true"),
                    ..StageMeta::default()
                });
                cur_depth = depth;
            } else if cur.is_some()
                && role.is_none()
                && let Some(class) = attr(tag.attrs, "class")
                && let Some(r) = class.split_ascii_whitespace().find_map(Role::of)
            {
                role = Some((r, depth, tag.end));
            }
        }
    }
    if depth != 0 {
        return Err(DagError::Truncated);
    }
    Ok(page)
}

fn apply_role(meta: &mut StageMeta, role: Role, raw: &str) -> Result<(), DagError> {
    let text = decode_entities(raw);
    match role {
        Role::DotFile => meta.dot = text,
        Role::Incoming => {
            if let Some(e) = parse_edge(&text)? {
                meta.incoming.push(e);
            }
        }
        Role::Outgoing => {
            if let Some(e) = parse_edge(&text)? {
                meta.outgoing.push(e);
            }
        }
        Role::Cached | Role::Barrier | Role::Indeterminate => {}
    }
    Ok(())
}

/// ``"<from>,<to>"`` (the div's trimmed text). Empty divs are skipped defensively.
fn parse_edge(text: &str) -> Result<Option<(i64, i64)>, DagError> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let (a, b) = t
        .split_once(',')
        .ok_or_else(|| DagError::Malformed(format!("edge div {t:?}")))?;
    let parse = |s: &str| {
        s.trim()
            .parse::<i64>()
            .map_err(|_| DagError::Malformed(format!("edge div {t:?}")))
    };
    Ok(Some((parse(a)?, parse(b)?)))
}

// ------------------------------------------------------------------------------------------------
// DOT dialect parser (only what RDDOperationGraph.makeDotFile emits)
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Arrow,
    Punct(char),
    Str(String),
    Id(String),
}

fn tokenize(dot: &str) -> Result<Vec<Tok>, DagError> {
    let b = dot.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if dot[i..].starts_with("->") {
            out.push(Tok::Arrow);
            i += 2;
        } else if matches!(b[i], b'{' | b'}' | b'[' | b']' | b';' | b'=' | b',') {
            out.push(Tok::Punct(b[i] as char));
            i += 1;
        } else if b[i] == b'"' {
            let mut j = i + 1;
            let mut s = String::new();
            loop {
                if j >= b.len() {
                    return Err(DagError::Malformed("DOT: unterminated string".into()));
                }
                if b[j] == b'\\' {
                    if j + 1 >= b.len() {
                        return Err(DagError::Malformed("DOT: unterminated string".into()));
                    }
                    s.push('\\');
                    let ch = dot[j + 1..].chars().next().expect("in-bounds");
                    s.push(ch);
                    j += 1 + ch.len_utf8();
                } else if b[j] == b'"' {
                    j += 1;
                    break;
                } else {
                    let ch = dot[j..].chars().next().expect("in-bounds");
                    s.push(ch);
                    j += ch.len_utf8();
                }
            }
            out.push(Tok::Str(s));
            i = j;
        } else if b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'.' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'.') {
                i += 1;
            }
            out.push(Tok::Id(dot[start..i].to_string()));
        } else {
            return Err(DagError::Malformed(format!(
                "DOT: unexpected input at {i}: {:?}",
                &dot[i..(i + 40).min(dot.len())]
            )));
        }
    }
    Ok(out)
}

#[derive(Debug, Default)]
struct DotCluster {
    subgraph_name: String,
    attrs: HashMap<String, String>,
    nodes: Vec<(i64, HashMap<String, String>)>,
    children: Vec<DotCluster>,
}

#[derive(Debug, Default)]
struct DotGraph {
    root: Option<DotCluster>,
    edges: Vec<(i64, i64)>,
}

struct P<'a> {
    toks: &'a [Tok],
    i: usize,
}

impl<'a> P<'a> {
    fn peek(&self, k: usize) -> Option<&'a Tok> {
        self.toks.get(self.i + k)
    }

    fn next_tok(&mut self) -> Result<&'a Tok, DagError> {
        let t = self
            .toks
            .get(self.i)
            .ok_or_else(|| DagError::Malformed("DOT: unexpected end of input".into()))?;
        self.i += 1;
        Ok(t)
    }

    fn eat_punct(&mut self, want: char) -> Result<(), DagError> {
        match self.next_tok()? {
            Tok::Punct(c) if *c == want => Ok(()),
            other => Err(DagError::Malformed(format!(
                "DOT: expected {want:?}, got {other:?}"
            ))),
        }
    }

    fn eat_id(&mut self) -> Result<&'a str, DagError> {
        match self.next_tok()? {
            Tok::Id(s) => Ok(s),
            other => Err(DagError::Malformed(format!(
                "DOT: expected an identifier, got {other:?}"
            ))),
        }
    }

    fn eat_str(&mut self) -> Result<&'a str, DagError> {
        match self.next_tok()? {
            Tok::Str(s) => Ok(s),
            other => Err(DagError::Malformed(format!(
                "DOT: expected a string, got {other:?}"
            ))),
        }
    }

    fn eat_int(&mut self) -> Result<i64, DagError> {
        let raw = self.eat_id()?;
        raw.parse::<i64>()
            .map_err(|_| DagError::Malformed(format!("DOT: expected an integer, got {raw:?}")))
    }

    fn attr_list(&mut self) -> Result<HashMap<String, String>, DagError> {
        let mut attrs = HashMap::new();
        self.eat_punct('[')?;
        while self.peek(0) != Some(&Tok::Punct(']')) {
            let k = self.eat_id()?.to_string();
            self.eat_punct('=')?;
            let v = self.eat_str()?.to_string();
            attrs.insert(k, v);
            if self.peek(0) == Some(&Tok::Punct(',')) {
                self.next_tok()?;
            }
        }
        self.eat_punct(']')?;
        Ok(attrs)
    }
}

#[derive(Default)]
struct Body {
    attrs: HashMap<String, String>,
    nodes: Vec<(i64, HashMap<String, String>)>,
    children: Vec<DotCluster>,
    edges: Vec<(i64, i64)>,
}

fn parse_body(p: &mut P<'_>, body: &mut Body) -> Result<(), DagError> {
    while p.peek(0) != Some(&Tok::Punct('}')) {
        let Some(tok) = p.peek(0).cloned() else {
            return Err(DagError::Malformed("DOT: unterminated body".into()));
        };
        let following = p.peek(1).cloned();
        match (tok, following) {
            (Tok::Id(name), _) if name == "subgraph" => {
                p.next_tok()?;
                let name = p.eat_id()?.to_string();
                p.eat_punct('{')?;
                let mut child = DotCluster {
                    subgraph_name: name,
                    ..DotCluster::default()
                };
                let mut child_body = Body::default();
                parse_body(p, &mut child_body)?;
                p.eat_punct('}')?;
                child.attrs = child_body.attrs;
                child.nodes = child_body.nodes;
                child.children = child_body.children;
                body.edges.extend(child_body.edges);
                body.children.push(child);
            }
            (Tok::Id(name), Some(Tok::Punct('='))) => {
                p.next_tok()?;
                p.next_tok()?;
                let v = p.eat_str()?.to_string();
                body.attrs.insert(name, v);
                p.eat_punct(';')?;
            }
            (Tok::Id(_), Some(Tok::Arrow)) => {
                let a = p.eat_int()?;
                p.next_tok()?;
                let b = p.eat_int()?;
                p.eat_punct(';')?;
                body.edges.push((a, b));
            }
            (Tok::Id(_), Some(Tok::Punct('['))) => {
                let id = p.eat_int()?;
                let attrs = p.attr_list()?;
                p.eat_punct(';')?;
                body.nodes.push((id, attrs));
            }
            other => {
                return Err(DagError::Malformed(format!(
                    "DOT: unexpected token {other:?} at {}",
                    p.i
                )));
            }
        }
    }
    Ok(())
}

fn parse_dot(dot: &str) -> Result<DotGraph, DagError> {
    let toks = tokenize(dot.trim())?;
    let mut p = P { toks: &toks, i: 0 };
    match p.next_tok()? {
        Tok::Id(s) if s == "digraph" => {}
        other => {
            return Err(DagError::Malformed(format!(
                "DOT: expected 'digraph', got {other:?}"
            )));
        }
    }
    p.eat_id()?; // G
    p.eat_punct('{')?;
    let mut body = Body::default();
    parse_body(&mut p, &mut body)?;
    p.eat_punct('}')?;
    if !body.nodes.is_empty() {
        return Err(DagError::Malformed("DOT: node outside a cluster".into()));
    }
    if body.children.len() > 1 {
        return Err(DagError::Malformed(
            "DOT: more than one top-level subgraph".into(),
        ));
    }
    let Some(root) = body.children.pop() else {
        return Err(DagError::Malformed("DOT: no root cluster".into()));
    };
    Ok(DotGraph {
        root: Some(root),
        edges: body.edges,
    })
}

// ------------------------------------------------------------------------------------------------
// DOT → Dag JSON
// ------------------------------------------------------------------------------------------------

struct NodeLabel {
    name: String,
    callsite: String,
    cached: bool,
    barrier: bool,
    determinism: Determinism,
}

/// `label := javaEscape(name " [" id "]" [" [Cached]"] [" [Barrier]"] [" [Indeterminate]"|" [Unordered]"]
/// "<br>" xmlEscape(callsite))`
fn parse_node_label(raw: &str, node_id: i64) -> NodeLabel {
    let label = java_unescape(raw);
    let (head, callsite) = match label.rfind("<br>") {
        // The callsite is XML-escaped, so it cannot contain a literal '<': the LAST <br> is the separator.
        Some(k) => (&label[..k], xml_unescape(&label[k + 4..])),
        None => (label.as_str(), String::new()),
    };
    match split_label_head(head, node_id) {
        Some((name, flags)) => NodeLabel {
            name,
            callsite,
            cached: flags.contains("[Cached]"),
            barrier: flags.contains("[Barrier]"),
            determinism: if flags.contains("[Indeterminate]") {
                Determinism::Indeterminate
            } else if flags.contains("[Unordered]") {
                Determinism::Unordered
            } else {
                Determinism::Determinate
            },
        },
        // Defensive: an unknown label shape keeps everything as the name — never drop a node.
        None => NodeLabel {
            name: head.to_string(),
            callsite,
            cached: false,
            barrier: false,
            determinism: Determinism::Determinate,
        },
    }
}

/// `^(.*) \[(\d+)\]( flags)*$` with a greedy name: the **rightmost** `[id]` whose tail is all flags.
fn split_label_head(head: &str, node_id: i64) -> Option<(String, &str)> {
    const FLAGS: [&str; 4] = [
        " [Cached]",
        " [Barrier]",
        " [Indeterminate]",
        " [Unordered]",
    ];
    let bytes = head.as_bytes();
    // Candidate positions: every " [" occurrence, tried right-to-left (greedy name).
    let mut candidates: Vec<usize> = (0..head.len().saturating_sub(1))
        .filter(|&i| bytes[i] == b' ' && bytes[i + 1] == b'[')
        .collect();
    candidates.reverse();
    for at in candidates {
        let tail = &head[at..];
        let Some(close) = tail.find(']') else {
            continue;
        };
        let digits = &tail[2..close];
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(id) = digits.parse::<i64>() else {
            continue;
        };
        let mut rest = &tail[close + 1..];
        let mut ok = true;
        while !rest.is_empty() {
            let Some(f) = FLAGS.iter().find(|f| rest.starts_with(**f)) else {
                ok = false;
                break;
            };
            rest = &rest[f.len()..];
        }
        if ok && id == node_id {
            return Some((head[..at].to_string(), &head[at + close + 1..]));
        }
    }
    None
}

fn parse_stage_label(label: &str) -> Option<(i64, Option<i64>)> {
    let rest = label.strip_prefix("Stage ")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let id = digits.parse::<i64>().ok()?;
    let mut rest = &rest[digits.len()..];
    let mut attempt = None;
    if let Some(r) = rest.strip_prefix(" (attempt ") {
        let d: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
        let r2 = r[d.len()..].strip_prefix(')')?;
        attempt = Some(d.parse::<i64>().ok()?);
        rest = r2;
    }
    if let Some(r) = rest.strip_prefix(" (skipped)") {
        rest = r;
    }
    if !rest.is_empty() {
        return None;
    }
    Some((id, attempt))
}

/// A stage plus the cross-edge lists that only the DOT page carries.
struct StageParts {
    stage: DagStage,
    incoming: Vec<(i64, i64)>,
    outgoing: Vec<(i64, i64)>,
}

fn dot_to_stage(meta: &StageMeta, dot: &DotGraph) -> Result<StageParts, DagError> {
    let root = dot
        .root
        .as_ref()
        .ok_or_else(|| DagError::Malformed("DOT: no root cluster".into()))?;
    let root_label = java_unescape(root.attrs.get("label").map(String::as_str).unwrap_or(""));
    let parsed = parse_stage_label(&root_label);
    let stage_id = meta
        .stage_id
        .or_else(|| parsed.map(|(id, _)| id))
        .unwrap_or(-1);

    let mut clusters = Vec::new();
    let mut nodes = Vec::new();
    walk(root, None, &mut clusters, &mut nodes);

    Ok(StageParts {
        stage: DagStage {
            stage_id,
            attempt: parsed.and_then(|(_, a)| a).unwrap_or(0),
            skipped: meta.skipped,
            label: root_label,
            clusters,
            nodes,
            edges: dot
                .edges
                .iter()
                .map(|(from, to)| IntraEdge {
                    from: *from,
                    to: *to,
                })
                .collect(),
            rdd_ids: None,
            status: None,
        },
        incoming: meta.incoming.clone(),
        outgoing: meta.outgoing.clone(),
    })
}

fn walk(
    c: &DotCluster,
    parent: Option<&str>,
    clusters: &mut Vec<DagCluster>,
    nodes: &mut Vec<DagNode>,
) {
    for (nid, attrs) in &c.nodes {
        let info = parse_node_label(attrs.get("label").map(String::as_str).unwrap_or(""), *nid);
        nodes.push(DagNode {
            id: *nid,
            name: info.name,
            callsite: info.callsite,
            cached: info.cached,
            barrier: info.barrier,
            determinism: info.determinism,
            cluster_id: parent.map(str::to_string),
        });
    }
    for child in &c.children {
        let cid = child
            .attrs
            .get("id")
            .cloned()
            .unwrap_or_else(|| child.subgraph_name.clone());
        clusters.push(DagCluster {
            id: cid.clone(),
            name: java_unescape(child.attrs.get("label").map(String::as_str).unwrap_or("")),
            parent_id: parent.map(str::to_string),
        });
        walk(child, Some(&cid), clusters, nodes);
    }
}

/// Parse a UI page (the `SPARK_LOCAL_IP`-independent, JVM-free half of the DAG route).
///
/// `Ok(None)` = the page carries no graph (a SKIPPED stage page, a live page that raced the UI);
/// [`DagError::NoInfo`] = the page is Spark's "no information to display" placeholder.
pub fn parse(
    bytes: &[u8],
    kind: Option<DagKind>,
    job_id: Option<i64>,
) -> Result<Option<Dag>, DagError> {
    if bytes.len() > MAX_PAGE_BYTES {
        return Err(DagError::TooLarge {
            bytes: bytes.len(),
            cap: MAX_PAGE_BYTES,
        });
    }
    let html = std::str::from_utf8(bytes).map_err(|e| DagError::Encoding(e.to_string()))?;
    build_dag(html, kind, job_id)
}

/// [`parse`] on already-decoded HTML.
pub fn build_dag(
    html: &str,
    kind: Option<DagKind>,
    job_id: Option<i64>,
) -> Result<Option<Dag>, DagError> {
    let page = extract(html)?;
    if page.no_info && !page.has_metadata {
        return Err(DagError::NoInfo);
    }
    if !page.has_metadata || page.stages.is_empty() {
        return Ok(None);
    }
    let kind = kind.or(page.kind).unwrap_or(DagKind::Job);
    let mut parts = Vec::with_capacity(page.stages.len());
    for meta in &page.stages {
        let graph = parse_dot(&meta.dot)?;
        parts.push(dot_to_stage(meta, &graph)?);
    }
    let mut cross: Vec<CrossEdge> = Vec::new();
    for p in &parts {
        for (from, to) in &p.incoming {
            cross.push(CrossEdge {
                from: Some(*from),
                to: Some(*to),
                from_stage: None,
                to_stage: Some(p.stage.stage_id),
            });
        }
        for (from, to) in &p.outgoing {
            cross.push(CrossEdge {
                from: Some(*from),
                to: Some(*to),
                from_stage: Some(p.stage.stage_id),
                to_stage: None,
            });
        }
    }
    if kind == DagKind::Job {
        resolve_stage_endpoints(&parts, &mut cross);
    }
    Ok(Some(Dag {
        kind,
        granularity: Granularity::Rdd,
        job_id: if kind == DagKind::Job { job_id } else { None },
        edges_inferred: None,
        stages: parts.into_iter().map(|p| p.stage).collect(),
        edges: cross,
    }))
}

/// Fill `fromStage`/`toStage` of cross-stage edges.
///
/// The HTML only says "RDD from → RDD to" (`.incoming-edge` lives in the *consuming* stage); RDD ids are
/// not unique across stages (a cached/shared RDD is listed in every stage that pipelines it), so the
/// producing stage is the stage (other than the consumer) that contains `from` as a **sink** (no
/// intra-stage outgoing edge) — the map-stage output. Ties: the lowest stage id (documented ambiguity,
/// mirroring `dagparse._resolve_stage_endpoints`).
fn resolve_stage_endpoints(parts: &[StageParts], cross: &mut [CrossEdge]) {
    for e in cross.iter_mut() {
        if e.from_stage.is_some() && e.to_stage.is_some() {
            continue;
        }
        if e.from_stage.is_none() {
            let from = e.from;
            let to_stage = e.to_stage;
            let mut candidates: Vec<i64> = parts
                .iter()
                .filter(|p| Some(p.stage.stage_id) != to_stage)
                .filter(|p| from.is_some_and(|f| p.stage.nodes.iter().any(|n| n.id == f)))
                .map(|p| p.stage.stage_id)
                .collect();
            let sinks: Vec<i64> = candidates
                .iter()
                .copied()
                .filter(|sid| {
                    let p = parts
                        .iter()
                        .find(|p| p.stage.stage_id == *sid)
                        .expect("known");
                    !from.is_some_and(|f| p.stage.edges.iter().any(|x| x.from == f))
                })
                .collect();
            if !sinks.is_empty() {
                candidates = sinks;
            }
            e.from_stage = candidates.iter().min().copied();
        } else if e.to_stage.is_none() {
            let to = e.to;
            let from_stage = e.from_stage;
            e.to_stage = parts
                .iter()
                .filter(|p| Some(p.stage.stage_id) != from_stage)
                .filter(|p| to.is_some_and(|t| p.stage.nodes.iter().any(|n| n.id == t)))
                .map(|p| p.stage.stage_id)
                .min();
        }
    }
}

/// Re-shape a job-kind DAG into the single-stage DAG of `stage_id`.
///
/// Used for **SKIPPED** stages: their stage page renders a placeholder (no `.stage-metadata`), but the
/// enclosing job page carries the graph. `edges` keeps the job-page cross edges touching this stage (with
/// `fromStage`/`toStage` resolved — strictly more information than a stage page, which only knows the
/// incoming RDD pair).
pub fn stage_from_job_dag(job: &Dag, stage_id: i64) -> Option<Dag> {
    let stage = job.stages.iter().find(|s| s.stage_id == stage_id)?.clone();
    let edges = job
        .edges
        .iter()
        .filter(|e| e.to_stage == Some(stage_id) || e.from_stage == Some(stage_id))
        .cloned()
        .collect();
    Some(Dag {
        kind: DagKind::Stage,
        granularity: Granularity::Rdd,
        job_id: None,
        edges_inferred: None,
        stages: vec![stage],
        edges,
    })
}

// ------------------------------------------------------------------------------------------------
// REST-only fallback (granularity "stage")
// ------------------------------------------------------------------------------------------------

fn vint(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn vstr<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// Stage-level DAG from REST only: `job` = `/jobs/{id}` JSON, `stages` = the `/stages` list.
///
/// What REST gives: `stageIds`, per-stage `status` (`SKIPPED` for never-run stages), `rddIds` (unordered),
/// shuffle read/write bytes. What it never gives: stage parents, RDD names/scopes/callsites. Edges are
/// therefore **inferred** (and flagged `edgesInferred:true`):
///
/// > `A → B` iff `A.id < B.id`, both in the job, `A` produced shuffle output (write bytes/records > 0 or
/// > `A` is SKIPPED) and `B` consumes shuffle input (read bytes/records/blocks > 0, or `B` is
/// > PENDING/SKIPPED with no metrics), and `A` finished before `B` was submitted.
///
/// No transitive reduction is attempted (mirrors `dagparse.rest_fallback_dag`).
pub fn rest_fallback_dag(job: &Value, stages: &[Value]) -> Dag {
    let stage_ids: Vec<i64> = job
        .get("stageIds")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    let in_job = |sid: i64| stage_ids.contains(&sid);

    // Latest attempt wins, keyed by stage id, restricted to this job's stages.
    let mut by_id: std::collections::BTreeMap<i64, &Value> = std::collections::BTreeMap::new();
    for s in stages {
        let sid = vint(s, "stageId");
        if !in_job(sid) {
            continue;
        }
        match by_id.get(&sid) {
            Some(prev) if vint(prev, "attemptId") >= vint(s, "attemptId") => {}
            _ => {
                by_id.insert(sid, s);
            }
        }
    }

    let mut sorted_ids: Vec<i64> = stage_ids.clone();
    sorted_ids.sort_unstable();
    sorted_ids.dedup();
    let mut out_stages = Vec::with_capacity(sorted_ids.len());
    for sid in &sorted_ids {
        let s = by_id.get(sid).copied();
        let status = s.and_then(|s| vstr(s, "status")).unwrap_or("UNKNOWN");
        let mut rdd_ids: Vec<i64> = s
            .and_then(|s| s.get("rddIds"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default();
        rdd_ids.sort_unstable();
        out_stages.push(DagStage {
            stage_id: *sid,
            attempt: s.map(|s| vint(s, "attemptId")).unwrap_or(0),
            skipped: status == "SKIPPED",
            label: format!(
                "Stage {sid}{}",
                if status == "SKIPPED" {
                    " (skipped)"
                } else {
                    ""
                }
            ),
            clusters: Vec::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
            rdd_ids: Some(rdd_ids),
            status: Some(status.to_string()),
        });
    }

    let mut edges = Vec::new();
    for b in &sorted_ids {
        let Some(sb) = by_id.get(b).copied() else {
            continue;
        };
        let consumes = vint(sb, "shuffleReadBytes") != 0
            || vint(sb, "shuffleReadRecords") != 0
            || vint(sb, "shuffleRemoteBlocksFetched") != 0
            || vint(sb, "shuffleLocalBlocksFetched") != 0;
        let sb_status = vstr(sb, "status").unwrap_or("");
        if !consumes && sb_status != "PENDING" && sb_status != "SKIPPED" {
            continue;
        }
        for a in &sorted_ids {
            if a >= b {
                continue;
            }
            let Some(sa) = by_id.get(a).copied() else {
                continue;
            };
            let produces = vint(sa, "shuffleWriteBytes") != 0
                || vint(sa, "shuffleWriteRecords") != 0
                || vstr(sa, "status") == Some("SKIPPED");
            if produces {
                edges.push(CrossEdge {
                    from: None,
                    to: None,
                    from_stage: Some(*a),
                    to_stage: Some(*b),
                });
            }
        }
    }

    Dag {
        kind: DagKind::Job,
        granularity: Granularity::Stage,
        job_id: job.get("jobId").and_then(Value::as_i64),
        edges_inferred: Some(true),
        stages: out_stages,
        edges,
    }
}

/// A one-stage fallback for a single stage attempt whose page carries no graph and which is not part of a
/// job we can read (e.g. a live race while the stage is ACTIVE).
pub fn single_stage_fallback(stage: &Value, stage_id: i64, attempt: i64) -> Dag {
    let status = vstr(stage, "status").unwrap_or("UNKNOWN");
    let mut rdd_ids: Vec<i64> = stage
        .get("rddIds")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    rdd_ids.sort_unstable();
    Dag {
        kind: DagKind::Stage,
        granularity: Granularity::Stage,
        job_id: None,
        edges_inferred: Some(true),
        stages: vec![DagStage {
            stage_id,
            attempt,
            skipped: status == "SKIPPED",
            label: format!(
                "Stage {stage_id}{}",
                if status == "SKIPPED" {
                    " (skipped)"
                } else {
                    ""
                }
            ),
            clusters: Vec::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
            rdd_ids: Some(rdd_ids),
            status: Some(status.to_string()),
        }],
        edges: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_unescape_handles_the_escape_set() {
        assert_eq!(java_unescape(r"a\nb"), "a\nb");
        assert_eq!(java_unescape(r#"a\tb\"c\\d"#), "a\tb\"c\\d");
        assert_eq!(java_unescape(r"\u00e9"), "é");
        // Surrogate pair, as escapeJava writes non-BMP characters.
        assert_eq!(java_unescape(r"\ud83d\ude00"), "😀");
        // Octal escape.
        assert_eq!(java_unescape(r"\101"), "A");
        // A trailing backslash survives.
        assert_eq!(java_unescape("end\\"), "end\\");
    }

    #[test]
    fn entity_decode_is_single_pass() {
        assert_eq!(decode_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_entities("&lt;br&gt;"), "<br>");
        assert_eq!(decode_entities("&#39;"), "'");
        assert_eq!(decode_entities("&#x41;"), "A");
        assert_eq!(decode_entities("&unknown;"), "&unknown;");
    }

    #[test]
    fn node_labels_split_on_the_last_br() {
        let n = parse_node_label(
            "PythonRDD [2] [Cached] [Unordered]<br>collect at Foo.scala:1",
            2,
        );
        assert_eq!(n.name, "PythonRDD");
        assert_eq!(n.callsite, "collect at Foo.scala:1");
        assert!(n.cached);
        assert_eq!(n.determinism, Determinism::Unordered);

        // The `id` in the label must agree with the DOT node id, else the shape is rejected defensively.
        let n = parse_node_label("MapPartitionsRDD [5] [Barrier]<br>x", 6);
        assert_eq!(n.name, "MapPartitionsRDD [5] [Barrier]");
        assert_eq!(n.callsite, "x");
        assert!(!n.barrier);
    }

    #[test]
    fn node_label_keeps_a_bracketed_name() {
        let n = parse_node_label(
            "In-memory table tc [7] [Cached] [Unordered]<br>sql at N.java:0",
            7,
        );
        assert_eq!(n.name, "In-memory table tc");
        assert!(n.cached);
    }

    #[test]
    fn stage_labels_parse_attempt_and_barrier() {
        assert_eq!(parse_stage_label("Stage 11"), Some((11, None)));
        assert_eq!(parse_stage_label("Stage 3 (attempt 1)"), Some((3, Some(1))));
        assert_eq!(parse_stage_label("Stage 2 (skipped)"), Some((2, None)));
        assert_eq!(parse_stage_label("Stage 0\n(barrier mode)"), None);
    }

    #[test]
    fn dot_parses_clusters_attrs_and_edges() {
        let dot = r#"digraph G {
  id="graph_0";
  subgraph graph_stage_0 {
    id="graph_stage_0"; isCluster="true"; label="Stage 0";
    subgraph cluster_1 { id="cluster_1"; isCluster="true"; label="parallelize";
      0 [id="node_0" labelType="html" label="ParallelCollectionRDD [0]<br>rdd at A.scala:1"]; }
    1 [id="node_1" labelType="html" label="PythonRDD [1] [Barrier]<br>collect at B.scala:2"];
  }
  0->1;
}"#;
        let g = parse_dot(dot).unwrap();
        assert_eq!(g.edges, vec![(0, 1)]);
        let root = g.root.unwrap();
        assert_eq!(root.attrs.get("label").map(String::as_str), Some("Stage 0"));
        assert_eq!(root.children.len(), 1);
        assert_eq!(root.nodes.len(), 1);
        assert_eq!(root.children[0].nodes.len(), 1);
    }

    #[test]
    fn malformed_dot_is_rejected() {
        assert!(parse_dot("digraph G { 0->1").is_err());
        assert!(parse_dot("graph G { }").is_err());
        assert!(parse_dot("digraph G { nope; }").is_err());
    }

    #[test]
    fn fallback_infers_stage_edges() {
        let job = serde_json::json!({"jobId": 2, "stageIds": [2, 3, 4]});
        let stages = vec![
            serde_json::json!({"stageId": 2, "attemptId": 0, "status": "SKIPPED", "rddIds": [0, 1]}),
            serde_json::json!({"stageId": 3, "attemptId": 0, "status": "COMPLETE", "rddIds": [4],
                               "shuffleWriteBytes": 1024}),
            serde_json::json!({"stageId": 4, "attemptId": 0, "status": "COMPLETE", "rddIds": [5],
                               "shuffleReadBytes": 1024}),
        ];
        let dag = rest_fallback_dag(&job, &stages);
        assert_eq!(dag.granularity, Granularity::Stage);
        assert_eq!(dag.edges_inferred, Some(true));
        assert!(dag.stages[0].skipped);
        assert_eq!(dag.stages[0].rdd_ids.as_deref(), Some(&[0, 1][..]));
        assert_eq!(dag.stages[2].status.as_deref(), Some("COMPLETE"));
        // Stage 3 neither consumes shuffle input nor is PENDING/SKIPPED, so nothing links into it;
        // stage 4 consumes, and both earlier producers (skipped 2, shuffling 3) are linked.
        assert_eq!(
            dag.edges,
            vec![
                CrossEdge {
                    from: None,
                    to: None,
                    from_stage: Some(2),
                    to_stage: Some(4)
                },
                CrossEdge {
                    from: None,
                    to: None,
                    from_stage: Some(3),
                    to_stage: Some(4)
                },
            ]
        );
    }

    #[test]
    fn pages_without_metadata_are_none_and_no_info_is_an_error() {
        assert_eq!(build_dag("<html></html>", None, None), Ok(None));
        assert_eq!(
            build_dag(r#"<div id="no-info">No information</div>"#, None, None),
            Err(DagError::NoInfo)
        );
        // A metadata div without stage blocks is `None` (mirrors dagparse).
        assert_eq!(
            build_dag(
                r#"<div id="dag-viz-metadata" class="d-none"></div>"#,
                None,
                None
            ),
            Ok(None)
        );
    }

    #[test]
    fn unterminated_metadata_is_truncated() {
        let html = r#"<div id="dag-viz-metadata"><div class="stage-metadata" stage-id="1">"#;
        assert_eq!(extract(html), Err(DagError::Truncated));
    }

    #[test]
    fn invalid_utf8_is_an_encoding_error() {
        assert!(matches!(
            parse(b"\xff\xfe\x00<div id=\"dag-viz-metadata\">", None, None),
            Err(DagError::Encoding(_))
        ));
    }
}
