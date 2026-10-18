//! Fixture-oracle test for the Spark DAG extractor (no JVM, no network).
//!
//! `fixtures/spark/{4.2.0,3.5.9}/<workload>/html/*.html` are real captured Spark UI pages, and
//! `dag-*.json` next to them are the reference parser's output
//! (`fixtures/spark/tools/dagparse.py`, itself machine-checked by `--verify`). This test reparses every
//! captured job/stage page with `burrow_core::spark::dag` and asserts the produced JSON **deep-equals**
//! the golden (structure-equal; key order and number formatting are irrelevant).
//!
//! Expected inventory per Spark version (verified against the fixtures, 2026-10-03):
//! * 361 job/stage HTML pages, of which **276 carry a graph** and 85 are placeholders (`#no-info` for an
//!   unknown id, or the "No tasks have started yet" page of a SKIPPED stage) ⇒ no golden;
//! * **90** REST-only fallback goldens (`dag-fallback-job-N.json`, built from `rest/final.{job-N,stages}.json`)
//!   ⇒ **366 goldens per version**, exactly the number `dagparse.py --verify` reports.
//!
//! Error shapes are pinned too: unknown stage / unknown job, a missing-metadata placeholder, truncated HTML
//! and HTML that is not valid UTF-8 (a "foreign charset" capture) must never yield a silent partial DAG.

use std::path::{Path, PathBuf};

use burrow_core::spark::dag::{self, DagError, DagKind};
use serde_json::Value;

fn fixtures_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/spark")
}

enum PageName {
    Job {
        phase: String,
        id: i64,
    },
    Stage {
        phase: String,
        id: i64,
        attempt: i64,
    },
}

fn parse_page_name(file: &str) -> Option<PageName> {
    let stem = file.strip_suffix(".html")?;
    let (phase, rest) = stem.split_once('.')?;
    if let Some(id) = rest.strip_prefix("job-") {
        return Some(PageName::Job {
            phase: phase.to_string(),
            id: id.parse().ok()?,
        });
    }
    let (id, attempt) = rest.strip_prefix("stage-")?.split_once('-')?;
    Some(PageName::Stage {
        phase: phase.to_string(),
        id: id.parse().ok()?,
        attempt: attempt.parse().ok()?,
    })
}

fn golden_name(name: &PageName) -> String {
    match name {
        PageName::Job { phase, id } if phase == "final" => format!("dag-job-{id}.json"),
        PageName::Job { phase, id } => format!("dag-{phase}-job-{id}.json"),
        PageName::Stage { phase, id, attempt } if phase == "final" => {
            format!("dag-stage-{id}-{attempt}.json")
        }
        PageName::Stage { phase, id, attempt } => format!("dag-{phase}-stage-{id}-{attempt}.json"),
    }
}

fn read(dir: &Path, file: &str) -> Vec<u8> {
    std::fs::read(dir.join(file))
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.join(file).display()))
}

fn workloads(version: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(fixtures_root().join(version))
        .expect("version dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.join("html").is_dir())
        .collect();
    out.sort();
    out
}

#[derive(Default)]
struct Tally {
    pages: usize,
    goldens: usize,
    no_graph: usize,
    fallback_goldens: usize,
    mismatches: Vec<String>,
    max_stages: usize,
    max_nodes: usize,
    max_edges: usize,
}

fn check_version(version: &str, t: &mut Tally) {
    for workload in workloads(version) {
        let html_dir = workload.join("html");
        let mut files: Vec<String> = std::fs::read_dir(&html_dir)
            .expect("html dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        files.sort();

        for file in &files {
            let Some(name) = parse_page_name(file) else {
                continue;
            };
            t.pages += 1;
            let bytes = read(&html_dir, file);
            let (kind, job_id) = match &name {
                PageName::Job { id, .. } => (Some(DagKind::Job), Some(*id)),
                PageName::Stage { .. } => (Some(DagKind::Stage), None),
            };
            let golden = workload.join(golden_name(&name));
            let parsed = dag::parse(&bytes, kind, job_id);
            if !golden.exists() {
                t.no_graph += 1;
                // Mirrors `dagparse.iter_goldens` yielding `None`: no graph on the page.
                let ok = matches!(parsed, Ok(None) | Err(DagError::NoInfo));
                if !ok {
                    t.mismatches.push(format!(
                        "{version}/{}: expected no graph, got {parsed:?}",
                        workload.file_name().unwrap().to_string_lossy(),
                    ));
                }
                continue;
            }
            t.goldens += 1;
            let actual = match parsed {
                Ok(Some(dag)) => serde_json::to_value(&dag).expect("serialise Dag"),
                other => {
                    t.mismatches.push(format!(
                        "{version}/{}: expected a DAG, got {other:?}",
                        workload.file_name().unwrap().to_string_lossy()
                    ));
                    continue;
                }
            };
            let expected: Value =
                serde_json::from_slice(&std::fs::read(&golden).expect("read golden"))
                    .expect("golden JSON");
            if actual != expected {
                t.mismatches.push(format!(
                    "{version}/{}: DAG differs from {}\n  first difference: {}",
                    workload.file_name().unwrap().to_string_lossy(),
                    golden.display(),
                    first_difference(&expected, &actual)
                ));
            }
            record_extremes(&expected, t);
        }

        // REST-only fallback goldens: job + stages REST documents → the inferred stage-level DAG.
        let rest_dir = workload.join("rest");
        let stages_path = rest_dir.join("final.stages.json");
        if !stages_path.exists() {
            continue;
        }
        let stages: Vec<Value> =
            serde_json::from_slice(&std::fs::read(&stages_path).expect("stages"))
                .expect("stages JSON");
        let mut rest_files: Vec<String> = std::fs::read_dir(&rest_dir)
            .expect("rest dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|f| f.starts_with("final.job-") && f.ends_with(".json"))
            .collect();
        rest_files.sort();
        for file in rest_files {
            let job_id: i64 = file
                .trim_start_matches("final.job-")
                .trim_end_matches(".json")
                .parse()
                .expect("job id");
            let job: Value = serde_json::from_slice(&read(&rest_dir, &file)).expect("job JSON");
            let golden = workload.join(format!("dag-fallback-job-{job_id}.json"));
            t.fallback_goldens += 1;
            let actual =
                serde_json::to_value(dag::rest_fallback_dag(&job, &stages)).expect("serialise");
            let expected: Value = serde_json::from_slice(
                &std::fs::read(&golden)
                    .unwrap_or_else(|e| panic!("read {}: {e}", golden.display())),
            )
            .expect("golden JSON");
            if actual != expected {
                t.mismatches.push(format!(
                    "{version}/{}: fallback DAG differs from {}\n  first difference: {}",
                    workload.file_name().unwrap().to_string_lossy(),
                    golden.display(),
                    first_difference(&expected, &actual)
                ));
            }
        }
    }
}

fn record_extremes(golden: &Value, t: &mut Tally) {
    let stages = golden["stages"].as_array().map(Vec::len).unwrap_or(0);
    let nodes: usize = golden["stages"]
        .as_array()
        .map(|s| {
            s.iter()
                .map(|s| s["nodes"].as_array().map(Vec::len).unwrap_or(0))
                .sum()
        })
        .unwrap_or(0);
    let edges: usize = golden["stages"]
        .as_array()
        .map(|s| {
            s.iter()
                .map(|s| s["edges"].as_array().map(Vec::len).unwrap_or(0))
                .sum::<usize>()
        })
        .unwrap_or(0)
        + golden["edges"].as_array().map(Vec::len).unwrap_or(0);
    t.max_stages = t.max_stages.max(stages);
    t.max_nodes = t.max_nodes.max(nodes);
    t.max_edges = t.max_edges.max(edges);
}

/// First structural difference, for an actionable failure message.
fn first_difference(expected: &Value, actual: &Value) -> String {
    fn walk(path: &str, a: &Value, b: &Value) -> Option<String> {
        match (a, b) {
            (Value::Object(a), Value::Object(b)) => {
                let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
                keys.sort();
                keys.dedup();
                for k in keys {
                    match (a.get(k), b.get(k)) {
                        (Some(x), Some(y)) => {
                            if let Some(d) = walk(&format!("{path}.{k}"), x, y) {
                                return Some(d);
                            }
                        }
                        (x, y) => {
                            return Some(format!(
                                "{path}.{k}: expected {}, got {}",
                                short(x),
                                short(y)
                            ));
                        }
                    }
                }
                None
            }
            (Value::Array(a), Value::Array(b)) => {
                if a.len() != b.len() {
                    return Some(format!(
                        "{path}: expected {} items, got {}",
                        a.len(),
                        b.len()
                    ));
                }
                for (i, (x, y)) in a.iter().zip(b).enumerate() {
                    if let Some(d) = walk(&format!("{path}[{i}]"), x, y) {
                        return Some(d);
                    }
                }
                None
            }
            (x, y) if x == y => None,
            (x, y) => Some(format!(
                "{path}: expected {}, got {}",
                short(Some(x)),
                short(Some(y))
            )),
        }
    }
    fn short(v: Option<&Value>) -> String {
        match v {
            None => "<absent>".into(),
            Some(v) => {
                let s = v.to_string();
                if s.len() > 120 {
                    format!("{}…", &s[..120])
                } else {
                    s
                }
            }
        }
    }
    walk("$", expected, actual).unwrap_or_else(|| "none".into())
}

#[test]
fn every_captured_page_reproduces_its_golden() {
    let mut t = Tally::default();
    for version in ["4.2.0", "3.5.9"] {
        check_version(version, &mut t);
    }
    println!(
        "spark fixtures: pages={} goldens(rdd)={} placeholder-pages={} goldens(fallback)={} \
         mismatches={} | largest DAG: {} stages / {} nodes / {} edges",
        t.pages,
        t.goldens,
        t.no_graph,
        t.fallback_goldens,
        t.mismatches.len(),
        t.max_stages,
        t.max_nodes,
        t.max_edges
    );
    assert!(
        t.mismatches.is_empty(),
        "{} DAG mismatch(es):\n{}",
        t.mismatches.len(),
        t.mismatches.join("\n")
    );
    // Two versions: 361 pages, 276 RDD goldens, 85 placeholders, 90 fallback goldens each ⇒ 366 goldens.
    assert_eq!(t.pages, 722);
    assert_eq!(t.goldens, 552);
    assert_eq!(t.no_graph, 170);
    assert_eq!(t.fallback_goldens, 180);
    assert_eq!(t.goldens + t.fallback_goldens, 732, "366 per Spark version");
}

#[test]
fn skipped_stage_page_and_unknown_ids_are_pinned() {
    let root = fixtures_root().join("4.2.0/rdd-wordcount/html");
    // SKIPPED stage page: a real placeholder, no `#dag-viz-metadata` ⇒ "no graph" (dagparse yields None).
    let skipped = read(&root, "final.stage-2-0.html");
    assert_eq!(dag::parse(&skipped, Some(DagKind::Stage), None), Ok(None));
    // Unknown job / stage ids: Spark still answers 200 with `#no-info`.
    for (file, kind, id) in [
        ("final.job-9999.html", DagKind::Job, Some(9999i64)),
        ("final.stage-9999-0.html", DagKind::Stage, None),
    ] {
        assert_eq!(
            dag::parse(&read(&root, file), Some(kind), id),
            Err(DagError::NoInfo),
            "{file}"
        );
    }
}

#[test]
fn missing_metadata_is_not_a_dag() {
    // A page with the job-dag-viz span but no metadata block at all.
    let html = "<span id=\"job-dag-viz\"></span><div>nothing</div>";
    assert_eq!(dag::build_dag(html, Some(DagKind::Job), Some(1)), Ok(None));
    // Metadata present but no stage blocks (mirrors `dagparse.build_dag`'s `not page.stages`).
    let html = "<div id=\"dag-viz-metadata\" class=\"d-none\"><div class=\"d-none\"></div></div>";
    assert_eq!(dag::build_dag(html, Some(DagKind::Job), Some(1)), Ok(None));
}

#[test]
fn truncated_html_errors_instead_of_a_partial_dag() {
    let page = read(
        &fixtures_root().join("4.2.0/rdd-wordcount/html"),
        "final.job-1.html",
    );
    let at = page
        .windows(16)
        .position(|w| w == b"dag-viz-metadata")
        .expect("metadata marker");
    for cut in [at + 120, at + 400, at + 2000] {
        let truncated = &page[..cut.min(page.len())];
        let got = dag::parse(truncated, Some(DagKind::Job), Some(1));
        assert!(
            matches!(got, Err(DagError::Truncated) | Err(DagError::Malformed(_))),
            "cut at {cut} produced {got:?}"
        );
    }
}

#[test]
fn non_utf8_html_is_an_encoding_error_not_a_silent_dag() {
    let page = read(
        &fixtures_root().join("4.2.0/rdd-wordcount/html"),
        "final.job-1.html",
    );
    let at = page
        .windows(16)
        .position(|w| w == b"dag-viz-metadata")
        .expect("metadata marker");
    // A latin-1 byte inside the DAG region: what a "foreign charset" capture looks like in practice.
    let mut latin1 = page.clone();
    latin1.splice(at + 200..at + 200, [0xE9u8]);
    let got = dag::parse(&latin1, Some(DagKind::Job), Some(1));
    assert!(matches!(got, Err(DagError::Encoding(_))), "{got:?}");
    // Even a declared foreign charset must not be treated as UTF-8 without checking.
    let mut declared = b"<meta charset=\"iso-8859-1\">".to_vec();
    declared.extend_from_slice(&latin1);
    let got = dag::parse(&declared, Some(DagKind::Job), Some(1));
    assert!(matches!(got, Err(DagError::Encoding(_))), "{got:?}");
}

#[test]
fn oversized_pages_are_rejected() {
    let big = vec![b' '; dag::MAX_PAGE_BYTES + 1];
    assert!(matches!(
        dag::parse(&big, Some(DagKind::Job), Some(1)),
        Err(DagError::TooLarge { .. })
    ));
}

#[test]
fn stage_from_job_dag_recovers_a_skipped_stage() {
    // sql-cache-union job 2 contains skipped stage 3 with a resolved cross-stage edge 3 -> 4.
    let dir = fixtures_root().join("4.2.0/sql-cache-union");
    let golden: Value =
        serde_json::from_slice(&std::fs::read(dir.join("dag-job-2.json")).expect("golden"))
            .expect("json");
    let dag: burrow_core::spark::dag::Dag = serde_json::from_value(golden).expect("Dag");
    assert!(dag.stages.iter().any(|s| s.skipped));
    let stage = dag::stage_from_job_dag(&dag, 3).expect("stage 3 is in job 2");
    assert_eq!(stage.kind, DagKind::Stage);
    assert_eq!(stage.stages.len(), 1);
    assert_eq!(stage.stages[0].stage_id, 3);
    assert!(!stage.stages[0].nodes.is_empty());
    assert_eq!(
        stage.edges.len(),
        1,
        "the skipped stage keeps the job page's cross-stage edge"
    );
    assert_eq!(stage.edges[0].from_stage, Some(3));
    assert_eq!(stage.edges[0].to_stage, Some(4));
    assert!(dag::stage_from_job_dag(&dag, 999).is_none());
}

#[test]
fn fallback_dag_shape_matches_the_contract() {
    let dir = fixtures_root().join("4.2.0/big-dag");
    let stages: Vec<Value> =
        serde_json::from_slice(&std::fs::read(dir.join("rest/final.stages.json")).expect("stages"))
            .expect("json");
    let job: Value =
        serde_json::from_slice(&std::fs::read(dir.join("rest/final.job-2.json")).expect("job"))
            .expect("json");
    let dag = dag::rest_fallback_dag(&job, &stages);
    assert_eq!(dag.kind, DagKind::Job);
    assert_eq!(dag.granularity, burrow_core::spark::dag::Granularity::Stage);
    assert_eq!(dag.edges_inferred, Some(true));
    assert_eq!(dag.job_id, Some(2));
    assert!(
        dag.stages
            .iter()
            .all(|s| s.nodes.is_empty() && s.status.is_some())
    );
    assert!(dag.stages.iter().any(|s| s.skipped));
    assert!(dag.edges.iter().all(|e| e.from.is_none() && e.to.is_none()));
    assert!(
        dag.edges
            .iter()
            .all(|e| e.from_stage.is_some() && e.to_stage.is_some())
    );
    println!(
        "big-dag fallback: {} stages, {} inferred edges",
        dag.stages.len(),
        dag.edges.len()
    );
}
