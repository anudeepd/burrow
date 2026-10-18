//! Data-driven route tables: one regex per allowed resource, each carrying its TTL class and what the
//! upstream is expected to return. The same table is the allowlist (no match ⇒ 404) and the cache policy.
//!
//! Pattern syntax: a regular expression over the path *after* the group prefix, implicitly anchored, with
//! the placeholder `{id}` expanding to the validated identifier class `[A-Za-z0-9_:.\-]+` (the contract's
//! `{appId}`/`{attemptId}`/`{containerId}`/`{nodeId}`). Identifiers made only of dots are rejected, so `..`
//! can never reach an upstream path.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use crate::cache::{Expect, TtlPolicy};

pub const ID: &str = r"[A-Za-z0-9_:.\-]+";

#[derive(Debug)]
pub struct Route {
    pub pattern: &'static str,
    pub ttl: TtlPolicy,
    pub expect: Expect,
    /// Upstream path override (default: `base + matched path`). `{0}`.. are not supported; overrides are
    /// only used for fixed paths such as `/conf`.
    pub rewrite: Option<&'static str>,
}

pub const fn secs(s: u64) -> TtlPolicy {
    TtlPolicy::Fixed(Duration::from_secs(s))
}

pub const fn millis(ms: u64) -> TtlPolicy {
    TtlPolicy::Fixed(Duration::from_millis(ms))
}

pub const fn route(pattern: &'static str, ttl: TtlPolicy, expect: Expect) -> Route {
    Route {
        pattern,
        ttl,
        expect,
        rewrite: None,
    }
}

pub const fn rewrite(
    pattern: &'static str,
    to: &'static str,
    ttl: TtlPolicy,
    expect: Expect,
) -> Route {
    Route {
        pattern,
        ttl,
        expect,
        rewrite: Some(to),
    }
}

pub struct Resolved<'a> {
    pub route: &'a Route,
    /// Full upstream path (starts with `/`).
    pub upstream_path: String,
}

pub struct RouteTable {
    base: &'static str,
    routes: &'static [Route],
    compiled: Vec<Regex>,
}

impl RouteTable {
    pub fn new(base: &'static str, routes: &'static [Route]) -> Self {
        let compiled = routes
            .iter()
            .map(|r| {
                let pat = r.pattern.replace("{id}", ID);
                Regex::new(&format!("^(?:{pat})$"))
                    .unwrap_or_else(|e| panic!("bad route pattern {:?}: {e}", r.pattern))
            })
            .collect();
        Self {
            base,
            routes,
            compiled,
        }
    }

    pub fn lookup(&self, path: &str) -> Option<Resolved<'_>> {
        // Any segment consisting only of dots is a traversal attempt, whatever the pattern says.
        if path
            .split('/')
            .any(|s| !s.is_empty() && s.bytes().all(|b| b == b'.'))
        {
            return None;
        }
        self.routes
            .iter()
            .zip(&self.compiled)
            .find(|(_, re)| re.is_match(path))
            .map(|(route, _)| Resolved {
                route,
                upstream_path: match route.rewrite {
                    Some(to) => to.to_string(),
                    None => format!("{}{path}", self.base),
                },
            })
    }

    pub fn routes(&self) -> &'static [Route] {
        self.routes
    }
}

/// Validate a single path segment (file names etc.): the id class minus dot-only values.
pub fn is_safe_segment(s: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("^{ID}$")).unwrap());
    RE.is_match(s) && !s.bytes().all(|b| b == b'.')
}

/// The percent-decoded value of `name` in a raw query string (`+` is a space, as in form encoding).
pub fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query_params(query, name).into_iter().next()
}

/// Every percent-decoded value of `name`, in order (a parameter may be repeated).
pub fn query_params(query: Option<&str>, name: &str) -> Vec<String> {
    query_params_raw(query, name)
        .into_iter()
        .map(|v| percent_decode(&v))
        .collect()
}

/// Every **still-encoded** value of `name`, in order. For callers that must split a value on a delimiter *before*
/// decoding: the events hub separates topics with a literal comma while a comma inside a topic's query is `%2C`, and
/// decoding first would make the two indistinguishable.
pub fn query_params_raw(query: Option<&str>, name: &str) -> Vec<String> {
    let Some(query) = query else {
        return Vec::new();
    };
    query
        .split('&')
        .filter_map(|p| {
            p.split_once('=')
                .filter(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        })
        .collect()
}

pub fn percent_decode(s: &str) -> String {
    if !s.contains('%') && !s.contains('+') {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                match std::str::from_utf8(&b[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                {
                    Some(v) => {
                        out.push(v);
                        i += 3;
                    }
                    None => {
                        out.push(b[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
