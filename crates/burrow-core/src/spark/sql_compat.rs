//! Spark 2.x SQL compatibility adapter.
//!
//! Spark 2.4 records SQL executions in its SQL listener and renders them in the Spark UI, but does not
//! expose the later SQL REST resource. The same information is present in /SQL/ and /SQL/execution/?id=…;
//! this module translates those pages into the SQL REST shape the web client already consumes. It parses
//! only Spark-owned page fragments, never forwards HTML to the browser, and leaves unavailable fields absent.

use std::{collections::HashMap, sync::LazyLock};

use regex::Regex;
use serde_json::{Value, json};

static RE_TABLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<table\b([^>]*)>(.*?)</table\s*>").unwrap());
static RE_ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<tr\b([^>]*)>(.*?)</tr\s*>").unwrap());
static RE_CELL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<t[dh]\b([^>]*)>(.*?)</t[dh]\s*>").unwrap());
static RE_ANCHOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<a\b([^>]*)>(.*?)</a\s*>").unwrap());
static RE_ATTR_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
});
static RE_HREF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
});
static RE_SORT_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:^|\s)sorttable_customkey\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)
        .unwrap()
});
static RE_EXECUTION_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:[?&])id=(\d+)").unwrap());
static RE_JOB_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[(\d+)\]").unwrap());
static RE_DURATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\s*$")
        .unwrap()
});
static RE_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<[^>]*>").unwrap());
static RE_OPEN_ELEMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<([a-z][a-z0-9]*)\b([^>]*)>").unwrap());
static RE_CLASS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
});
static RE_PRE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<pre\b[^>]*>(.*?)</pre\s*>").unwrap());
static RE_DOT_NODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*(\d+)\s+\[label="((?:\\.|[^"\\])*)"\]\s*;?\s*$"#).unwrap());
static RE_DOT_EDGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(\d+)\s*->\s*(\d+)\s*;\s*$").unwrap());
static RE_CLUSTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*subgraph\s+cluster(\d+)\s*\{\s*$").unwrap());
static RE_DOT_LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*label="((?:\\.|[^"\\])*)"\s*;\s*$"#).unwrap());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TableStatus {
    Running,
    Completed,
    Failed,
}

impl TableStatus {
    fn from_table_id(id: &str) -> Option<Self> {
        match id {
            "running-execution-table" => Some(Self::Running),
            "completed-execution-table" => Some(Self::Completed),
            "failed-execution-table" => Some(Self::Failed),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "RUNNING",
            Self::Completed => "COMPLETED",
            Self::Failed => "FAILED",
        }
    }
}

/// Parse the execution tables emitted by Spark 2.4's AllExecutionsPage.
/// None means a non-SQL/unrecognized page; an empty vector is a valid SQL page with no retained rows.
pub fn parse_list(html: &str) -> Option<Vec<Value>> {
    let mut recognized = false;
    let mut rows = Vec::new();
    for table in RE_TABLE.captures_iter(html) {
        let Some(table_id) = attr(&RE_ATTR_ID, &table[1]) else {
            continue;
        };
        let Some(status) = TableStatus::from_table_id(&table_id) else {
            continue;
        };
        recognized = true;
        for row in RE_ROW.captures_iter(&table[2]) {
            let cells: Vec<(String, String)> = RE_CELL
                .captures_iter(&row[2])
                .map(|cell| (cell[1].to_string(), cell[2].to_string()))
                .collect();
            if cells.len() < 4 {
                continue;
            }
            let id = text(&cells[0].1).parse::<i64>().ok().or_else(|| {
                RE_ANCHOR.captures_iter(&cells[1].1).find_map(|anchor| {
                    attr(&RE_HREF, &anchor[1]).and_then(|href| {
                        RE_EXECUTION_ID
                            .captures(&href)
                            .and_then(|m| m[1].parse::<i64>().ok())
                    })
                })
            });
            let Some(id) = id else { continue };

            let description = RE_ANCHOR
                .captures_iter(&cells[1].1)
                .find_map(|anchor| {
                    attr(&RE_HREF, &anchor[1])
                        .filter(|href| RE_EXECUTION_ID.is_match(href))
                        .map(|_| text(&anchor[2]))
                })
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    let value = text(&cells[1].1);
                    (!value.is_empty()).then_some(value)
                });

            let submission_time = sort_key(&cells[2].0)
                .and_then(|s| s.parse::<i64>().ok())
                .map(|n| n.to_string());
            let duration = sort_key(&cells[3].0)
                .and_then(|s| s.parse::<i64>().ok())
                .or_else(|| parse_duration_ms(&text(&cells[3].1)));

            let mut running = Vec::new();
            let mut succeeded = Vec::new();
            let mut failed = Vec::new();
            match status {
                TableStatus::Running => {
                    read_jobs(cells.get(4), &mut running);
                    read_jobs(cells.get(5), &mut succeeded);
                    read_jobs(cells.get(6), &mut failed);
                }
                TableStatus::Completed => read_jobs(cells.get(4), &mut succeeded),
                TableStatus::Failed => {
                    read_jobs(cells.get(4), &mut succeeded);
                    read_jobs(cells.get(5), &mut failed);
                }
            }

            let completion_time = match (status, submission_time.as_deref(), duration) {
                (TableStatus::Running, _, _) => None,
                (_, Some(submitted), Some(duration)) => submitted
                    .parse::<i64>()
                    .ok()
                    .map(|submitted| (submitted + duration).to_string()),
                _ => None,
            };
            rows.push(json!({
                "id": id,
                "status": status.as_str(),
                "description": description,
                "submissionTime": submission_time,
                "completionTime": completion_time,
                "duration": duration,
                "runningJobIds": running,
                "successJobIds": succeeded,
                "failedJobIds": failed,
            }));
        }
    }
    if !recognized && !has_sql_title(html) {
        return None;
    }
    rows.sort_by_key(|row| row["id"].as_i64().unwrap_or_default());
    Some(rows)
}

/// Merge list metadata with the rendered details page for one SQL execution.
pub fn parse_detail(html: &str, execution_id: i64, mut execution: Value) -> Option<Value> {
    if html.contains(&format!(
        "No information to display for query {execution_id}"
    )) {
        return None;
    }
    if !has_sql_title(html) && !html.contains("plan-viz-metadata") {
        return None;
    }
    let dot = element_by_class(html, "dot-file").map(|s| decode_entities(&strip_tags(s)));
    let (mut nodes, edges) = dot.map_or_else(|| (Vec::new(), Vec::new()), |s| parse_dot_plan(&s));
    let plan_lines = plan_metadata(html);
    for node in &mut nodes {
        let Some(node_id) = node["nodeId"].as_i64() else {
            continue;
        };
        if let Some(line) = plan_lines.get(&node_id) {
            node["planLine"] = json!(line);
        }
    }
    let physical_plan = element_by_id(html, "physical-plan-details")
        .and_then(|inner| RE_PRE.captures(inner).map(|m| decode_entities(&m[1])));
    if let Some(object) = execution.as_object_mut() {
        object.insert("planDescription".into(), json!(physical_plan));
        object.insert("nodes".into(), json!(nodes));
        object.insert("edges".into(), json!(edges));
    }
    Some(execution)
}

/// Apply the offset/length query supported by the later REST endpoint, after ordering by execution id.
pub fn page(rows: Vec<Value>, query: Option<&str>) -> Vec<Value> {
    let Some(query) = query else { return rows };
    let value = |name: &str| {
        query
            .split('&')
            .filter_map(|part| part.split_once('='))
            .find_map(|(key, value)| (key == name).then(|| value.parse::<usize>().ok()).flatten())
    };
    let offset = value("offset").unwrap_or(0).min(rows.len());
    let length = value("length").unwrap_or(rows.len());
    rows.into_iter().skip(offset).take(length).collect()
}

fn has_sql_title(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    lower.contains(" - sql</title>") || lower.contains("<title>sql</title>")
}

fn attr(re: &Regex, attrs: &str) -> Option<String> {
    re.captures(attrs).and_then(|m| {
        (1..=3)
            .find_map(|i| m.get(i))
            .map(|m| m.as_str().to_string())
    })
}

fn sort_key(attrs: &str) -> Option<String> {
    attr(&RE_SORT_KEY, attrs)
}

fn text(fragment: &str) -> String {
    decode_entities(&RE_TAG.replace_all(fragment, " "))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_tags(fragment: &str) -> String {
    RE_TAG.replace_all(fragment, "").to_string()
}

fn decode_entities(s: &str) -> String {
    static RE_ENTITY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"&(#(?:x[0-9a-fA-F]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);").unwrap()
    });
    RE_ENTITY
        .replace_all(s, |caps: &regex::Captures<'_>| {
            let entity = &caps[1];
            match entity {
                "amp" => "&".into(),
                "lt" => "<".into(),
                "gt" => ">".into(),
                "quot" => "\"".into(),
                "apos" => "'".into(),
                "nbsp" => " ".into(),
                _ if entity.starts_with("#x") => u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
                    .map_or_else(|| caps[0].to_string(), |c| c.to_string()),
                _ if entity.starts_with('#') => entity[1..]
                    .parse::<u32>()
                    .ok()
                    .and_then(char::from_u32)
                    .map_or_else(|| caps[0].to_string(), |c| c.to_string()),
                _ => caps[0].to_string(),
            }
        })
        .into_owned()
}

fn read_jobs(cell: Option<&(String, String)>, out: &mut Vec<i64>) {
    if let Some((_, html)) = cell {
        for anchor in RE_ANCHOR.captures_iter(html) {
            let id = attr(&RE_HREF, &anchor[1])
                .and_then(|href| {
                    RE_EXECUTION_ID
                        .captures(&href)
                        .and_then(|m| m[1].parse().ok())
                })
                .or_else(|| {
                    RE_JOB_ID
                        .captures(&anchor[2])
                        .and_then(|m| m[1].parse().ok())
                });
            if let Some(id) = id {
                out.push(id);
            }
        }
        out.sort_unstable();
        out.dedup();
    }
}

fn parse_duration_ms(value: &str) -> Option<i64> {
    let c = RE_DURATION.captures(value)?;
    let n = c[1].parse::<f64>().ok()?;
    let unit = c[2].to_ascii_lowercase();
    let factor = match unit.as_str() {
        "ms" | "millisecond" | "milliseconds" => 1.0,
        "s" | "sec" | "secs" | "second" | "seconds" => 1000.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60_000.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600_000.0,
        "d" | "day" | "days" => 86_400_000.0,
        _ => return None,
    };
    let millis = n * factor;
    millis.is_finite().then_some(millis.round() as i64)
}

fn element_by_class<'a>(html: &'a str, class: &str) -> Option<&'a str> {
    RE_OPEN_ELEMENT.captures_iter(html).find_map(|m| {
        let classes = attr(&RE_CLASS, &m[2])?;
        if !classes.split_ascii_whitespace().any(|s| s == class) {
            return None;
        }
        element_inner(html, &m, &m[1])
    })
}

fn element_by_id<'a>(html: &'a str, id: &str) -> Option<&'a str> {
    RE_OPEN_ELEMENT.captures_iter(html).find_map(|m| {
        (attr(&RE_ATTR_ID, &m[2]).as_deref() == Some(id))
            .then(|| element_inner(html, &m, &m[1]))
            .flatten()
    })
}

/// Spark 2.4 stores the text shown when hovering a SQL plan operator in one hidden element per DOT node.
fn plan_metadata(html: &str) -> HashMap<i64, String> {
    RE_OPEN_ELEMENT
        .captures_iter(html)
        .filter_map(|open| {
            let id = attr(&RE_ATTR_ID, &open[2])?;
            let node_id = id.strip_prefix("plan-meta-data-")?.parse::<i64>().ok()?;
            let value = text(element_inner(html, &open, &open[1])?);
            (!value.is_empty()).then_some((node_id, value))
        })
        .collect()
}

fn element_inner<'a>(html: &'a str, open: &regex::Captures<'_>, tag: &str) -> Option<&'a str> {
    let start = open.get(0)?.end();
    let close_tag = format!("</{tag}");
    let tail = &html[start..];
    let end = tail
        .to_ascii_lowercase()
        .find(&close_tag.to_ascii_lowercase())?;
    Some(&tail[..end])
}

fn java_unescape(s: &str) -> String {
    let mut chars = s.chars();
    let mut out = String::with_capacity(s.len());
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                if let Ok(code) = u32::from_str_radix(&hex, 16)
                    && let Some(decoded) = char::from_u32(code)
                {
                    out.push(decoded);
                } else {
                    out.push_str("\\u");
                    out.push_str(&hex);
                }
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn label_parts(encoded: &str) -> (String, Vec<Value>) {
    let label = java_unescape(encoded);
    let mut lines = label.lines().map(str::trim);
    let name = lines.next().unwrap_or("").to_string();
    let mut metrics = Vec::new();
    while let Some(line) = lines.next() {
        if line.is_empty() {
            continue;
        }
        if let Some(metric_name) = line.strip_suffix(':') {
            let value = lines.next().unwrap_or("");
            metrics.push(json!({"name": metric_name.trim(), "value": value.trim()}));
        } else if let Some((metric_name, value)) = line.split_once(": ") {
            metrics.push(json!({"name": metric_name.trim(), "value": value.trim()}));
        } else {
            metrics.push(json!({"name": "duration", "value": line}));
        }
    }
    (name, metrics)
}

fn parse_dot_plan(dot: &str) -> (Vec<Value>, Vec<Value>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut group = None;
    for line in dot.lines() {
        if let Some(c) = RE_CLUSTER.captures(line) {
            if let Ok(id) = c[1].parse::<i64>() {
                group = Some(id);
            }
            continue;
        }
        if line.trim() == "}" {
            group = None;
            continue;
        }
        if let Some(c) = RE_DOT_LABEL.captures(line) {
            if let Some(id) = group {
                let (name, metrics) = label_parts(&c[1]);
                nodes.push(json!({"nodeId": id, "nodeName": name, "metrics": metrics}));
            }
            continue;
        }
        if let Some(c) = RE_DOT_NODE.captures(line) {
            let Ok(id) = c[1].parse::<i64>() else {
                continue;
            };
            let (name, metrics) = label_parts(&c[2]);
            nodes.push(json!({
                "nodeId": id,
                "nodeName": name,
                "wholeStageCodegenId": group,
                "metrics": metrics,
            }));
            continue;
        }
        if let Some(c) = RE_DOT_EDGE.captures(line)
            && let (Ok(from), Ok(to)) = (c[1].parse::<i64>(), c[2].parse::<i64>())
        {
            edges.push(json!({"fromId": from, "toId": to}));
        }
    }
    (nodes, edges)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = r#"<!DOCTYPE html><html><head><title>sql-demo - SQL</title></head><body>
      <table id="running-execution-table"><thead><tr><th>ID</th><th>Description</th><th>Submitted</th><th>Duration</th><th>Running Job IDs</th><th>Succeeded Job IDs</th><th>Failed Job IDs</th></tr></thead><tbody>
        <tr><td>9</td><td><a href="/SQL/execution/?id=9">select &quot;k&quot;, sum(v) from t group by k</a></td><td sorttable_customkey="1000">now</td><td sorttable_customkey="2500">2.5 s</td><td><a href="/jobs/job/?id=4">[4]</a></td><td></td><td></td></tr>
      </tbody></table>
      <table id="completed-execution-table"><tr><th>ID</th><th>Description</th><th>Submitted</th><th>Duration</th><th>Job IDs</th></tr>
        <tr><td>8</td><td><a href="/SQL/execution/?id=8">count(*)</a></td><td sorttable_customkey="500">then</td><td sorttable_customkey="250">250 ms</td><td><a href="/jobs/job/?id=3">[3]</a></td></tr>
      </table>
      <table id="failed-execution-table"><tr><th>ID</th><th>Description</th><th>Submitted</th><th>Duration</th><th>Succeeded Job IDs</th><th>Failed Job IDs</th></tr>
        <tr><td>7</td><td><a href="/SQL/execution/?id=7">bad query</a></td><td sorttable_customkey="100">earlier</td><td sorttable_customkey="500">0.5 s</td><td></td><td><a href="/jobs/job/?id=2">[2]</a></td></tr>
      </table></body></html>"#;

    #[test]
    fn parses_spark_24_execution_tables_and_status_job_ids() {
        let rows = parse_list(LIST).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["id"], 7);
        assert_eq!(rows[0]["status"], "FAILED");
        assert_eq!(rows[0]["failedJobIds"][0], 2);
        assert_eq!(rows[1]["status"], "COMPLETED");
        assert_eq!(rows[1]["submissionTime"], "500");
        assert_eq!(rows[1]["completionTime"], "750");
        assert_eq!(rows[1]["successJobIds"][0], 3);
        assert_eq!(rows[2]["status"], "RUNNING");
        assert_eq!(rows[2]["duration"], 2500);
        assert_eq!(rows[2]["completionTime"], Value::Null);
        assert_eq!(rows[2]["runningJobIds"][0], 4);
        assert_eq!(
            rows[2]["description"],
            "select \"k\", sum(v) from t group by k"
        );
    }

    #[test]
    fn parses_sql_execution_graph_metrics_and_whole_stage_membership() {
        let html = r#"<!DOCTYPE html><html><head><title>sql-demo - SQL</title></head><body>
          <div id="plan-viz-metadata"><div class="dot-file">digraph G {
            subgraph cluster3 {
              label=&quot;WholeStageCodegen\n\n14 ms&quot;;
              0 [label=&quot;HashAggregate\n \nnumber of output rows: 10&quot;];
              1 [label=&quot;Project\n \nnumber of output rows: 10&quot;];
            }
            1-&gt;0;
          }</div></div>
          <div id="physical-plan-details"><pre>== Physical Plan ==
HashAggregate
+- Project
</pre></div>
        </body></html>"#;
        let execution = json!({"id": 3, "status": "COMPLETED"});
        let parsed = parse_detail(html, 3, execution).unwrap();
        assert_eq!(
            parsed["planDescription"],
            "== Physical Plan ==\nHashAggregate\n+- Project\n"
        );
        assert_eq!(parsed["nodes"].as_array().unwrap().len(), 3);
        assert_eq!(parsed["nodes"][0]["nodeName"], "WholeStageCodegen");
        assert_eq!(parsed["nodes"][1]["wholeStageCodegenId"], 3);
        assert_eq!(
            parsed["nodes"][1]["metrics"][0]["name"],
            "number of output rows"
        );
        assert_eq!(parsed["nodes"][1]["metrics"][0]["value"], "10");
        assert_eq!(parsed["nodes"][0]["metrics"][0]["value"], "14 ms");
        assert_eq!(parsed["edges"][0], json!({"fromId": 1, "toId": 0}));
    }

    #[test]
    fn invalid_or_missing_sql_page_is_not_misread_as_an_empty_query_list() {
        assert!(parse_list("<html><title>Spark Jobs</title></html>").is_none());
        assert_eq!(
            parse_list("<html><title>app - SQL</title></html>"),
            Some(vec![])
        );
        assert!(parse_detail(
            "<html><title>app - SQL</title><body>No information to display for query 2</body></html>",
            2,
            json!({"id": 2})
        )
        .is_none());
    }

    #[test]
    fn applies_rest_style_server_paging_after_execution_id_ordering() {
        let rows = parse_list(LIST).unwrap();
        let page = page(rows, Some("offset=1&length=1"));
        assert_eq!(page.len(), 1);
        assert_eq!(page[0]["id"], 8);
    }

    #[test]
    fn parses_captured_spark_24_sql_pages_from_yarn() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/spark/2.4.0/sql-demo");
        let list = std::fs::read_to_string(root.join("sql.html")).unwrap();
        let detail = std::fs::read_to_string(root.join("execution-2.html")).unwrap();
        let rows = parse_list(&list).unwrap();
        let execution = rows
            .into_iter()
            .find(|row| row["id"].as_i64() == Some(2))
            .unwrap();
        assert_eq!(execution["status"], "COMPLETED");
        assert_eq!(execution["successJobIds"].as_array().unwrap().len(), 3);
        assert!(
            execution["description"]
                .as_str()
                .unwrap()
                .contains("collect")
        );

        let parsed = parse_detail(&detail, 2, execution).unwrap();
        let nodes = parsed["nodes"].as_array().unwrap();
        let edges = parsed["edges"].as_array().unwrap();
        assert!(nodes.len() >= 15, "parsed only {} nodes", nodes.len());
        assert!(edges.len() >= 12, "parsed only {} edges", edges.len());
        assert!(nodes.iter().any(|n| n["nodeName"] == "BroadcastHashJoin"));
        assert_eq!(
            nodes.iter().find(|n| n["nodeId"] == 12).unwrap()["planLine"],
            "Range (0, 20000, step=1, splits=4)"
        );
        assert_eq!(
            nodes.iter().find(|n| n["nodeId"] == 9).unwrap()["planLine"],
            "BroadcastHashJoin [customer_id#2], [customer_id#9], Inner, BuildRight"
        );
        assert!(
            nodes
                .iter()
                .any(|n| n["wholeStageCodegenId"].as_i64().is_some())
        );
        assert!(
            nodes
                .iter()
                .flat_map(|n| n["metrics"].as_array().into_iter().flatten())
                .any(|m| m["name"] == "time to collect (ms)" && m["value"] == "926")
        );
        assert!(
            parsed["planDescription"]
                .as_str()
                .is_some_and(|s| s.contains("== Physical Plan =="))
        );
    }
}
