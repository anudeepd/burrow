//! Small HTML helpers: detecting HTML masquerading as an API response, turning HTML error pages into a
//! one-line message for the error envelope, and converting the RM's `/logs/` directory listing to JSON.

use std::sync::LazyLock;

use http::header::HeaderValue;
use regex::Regex;
use serde::Serialize;

static RE_HIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<(script|style|head)\b.*?</(script|style|head)\s*>").unwrap()
});
static RE_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
static RE_WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static RE_ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<tr\b[^>]*>(.*?)</tr\s*>").unwrap());
static RE_CELL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<td\b[^>]*>(.*?)</td\s*>").unwrap());
static RE_HREF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\b[^>]*?href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>"#).unwrap()
});
static RE_TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title\s*>").unwrap());
static RE_SIZE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*([\d,\.]+)\s*bytes?\s*$").unwrap());

/// True when the response is (or starts like) an HTML document.
pub fn looks_like_html(content_type: Option<&HeaderValue>, body: &[u8]) -> bool {
    if let Some(ct) = content_type.and_then(|v| v.to_str().ok()) {
        let ct = ct.to_ascii_lowercase();
        if ct.contains("text/html") || ct.contains("application/xhtml") {
            return true;
        }
        if ct.contains("json") || ct.contains("xml") || ct.starts_with("text/plain") {
            return false;
        }
    }
    let head: Vec<u8> = body
        .iter()
        .copied()
        .skip_while(u8::is_ascii_whitespace)
        .take(15)
        .map(|b| b.to_ascii_lowercase())
        .collect();
    head.starts_with(b"<!doctype html") || head.starts_with(b"<html")
}

fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&amp;", "&")
}

fn text_of(fragment: &str) -> String {
    let t = RE_TAG.replace_all(fragment, " ");
    RE_WS
        .replace_all(&decode_entities(&t), " ")
        .trim()
        .to_string()
}

/// One-line, length-bounded description of an HTML error page.
pub fn html_error_message(body: &[u8]) -> String {
    let html = String::from_utf8_lossy(&body[..body.len().min(64 * 1024)]);
    let title = RE_TITLE
        .captures(&html)
        .map(|c| text_of(&c[1]))
        .filter(|t| !t.is_empty());
    let stripped = RE_HIDDEN.replace_all(&html, " ");
    let text = text_of(&stripped);
    let mut msg = match (&title, text.is_empty()) {
        (Some(t), true) => t.clone(),
        (Some(t), false) if !text.starts_with(t.as_str()) => format!("{t}: {text}"),
        (_, false) => text,
        (None, true) => "upstream returned an empty HTML page".to_string(),
    };
    if msg.chars().count() > 300 {
        msg = msg.chars().take(300).collect::<String>() + "…";
    }
    msg
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    /// File size in bytes; `0` when the listing prints none (directories and blank cells). `is_dir`
    /// disambiguates. Deliberately a plain number: the wire shape the SPA consumes.
    pub size: u64,
    /// Modification time **exactly as the daemon printed it**. Jetty's listing carries no timezone, so
    /// this is never converted to an epoch — an epoch would be an invention (see the logs FE handshake).
    pub modified: Option<String>,
    pub is_dir: bool,
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Some(v) = std::str::from_utf8(&b[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn entry_name(href: &str) -> Option<(String, bool)> {
    let href = href.split(['?', '#']).next().unwrap_or(href);
    let is_dir = href.ends_with('/');
    let last = href.trim_end_matches('/').rsplit('/').next()?;
    let name = percent_decode(last);
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    Some((name, is_dir))
}

static RE_CLASS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)class\s*=\s*["']?([A-Za-z0-9_ \-]+)"#).unwrap());

fn class_of(attrs: &str) -> Option<String> {
    RE_CLASS.captures(attrs).map(|c| c[1].to_ascii_lowercase())
}

fn parse_bytes(text: &str) -> Option<u64> {
    RE_SIZE
        .captures(text)
        .map(|c| c[1].replace([',', '.'], ""))
        .and_then(|n| n.parse::<u64>().ok())
}

/// Convert the Jetty directory listing served at `/logs/` into structured entries.
///
/// Two layouts are handled: Jetty ≥ 9 (cells carry `class="name"|"lastmodified"|"size"`) and the classic
/// Hadoop listing (name, then `"<n> bytes"`, then the date, with no classes).
pub fn parse_logs_listing(html: &str) -> Vec<LogFile> {
    let mut files = Vec::new();
    for row in RE_ROW.captures_iter(html) {
        let cells: Vec<(String, String)> = RE_CELL
            .captures_iter(&row[1])
            .map(|c| {
                let attrs = c.get(0).map(|m| m.as_str()).unwrap_or("");
                (attrs.to_string(), c[1].to_string())
            })
            .collect();
        let Some((first_attrs, first_inner)) = cells.first() else {
            continue;
        };
        let Some(href) = RE_HREF.captures(first_inner).map(|c| c[1].to_string()) else {
            continue;
        };
        let _ = first_attrs;
        if text_of(first_inner).eq_ignore_ascii_case("parent directory") {
            continue;
        }
        let Some((name, is_dir)) = entry_name(&href) else {
            continue;
        };
        let mut size = 0;
        let mut size_at = None;
        let mut modified = None;
        for (idx, (attrs, inner)) in cells.iter().enumerate().skip(1) {
            let class = class_of(attrs);
            let text = text_of(inner);
            let bytes = parse_bytes(&text);
            if class.as_deref() == Some("size") || (class.is_none() && bytes.is_some()) {
                if size_at.is_none() {
                    size = bytes.unwrap_or(0);
                    size_at = Some(idx);
                }
                continue;
            }
            let is_date = class
                .as_deref()
                .is_some_and(|c| c.contains("modified") || c.contains("date"));
            if modified.is_none()
                && !text.is_empty()
                && (is_date || size_at.is_some_and(|s| idx == s + 1))
            {
                modified = Some(text);
            }
        }
        files.push(LogFile {
            name,
            size,
            modified,
            is_dir,
        });
    }
    if files.is_empty() {
        // Different Jetty layout: fall back to bare anchors.
        for c in RE_HREF.captures_iter(html) {
            if let Some((name, is_dir)) = entry_name(&c[1])
                && !c[1].starts_with("http")
                && !c[1].starts_with('/')
                && !c[1].ends_with(".css")
            {
                files.push(LogFile {
                    name,
                    size: 0,
                    modified: None,
                    is_dir,
                });
            }
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_html() {
        let h = |s: &str| HeaderValue::from_str(s).unwrap();
        assert!(looks_like_html(Some(&h("text/html;charset=utf-8")), b"x"));
        assert!(!looks_like_html(Some(&h("application/json")), b"<html>"));
        assert!(looks_like_html(None, b"  \n<!DOCTYPE html><html>"));
        assert!(!looks_like_html(None, b"{\"a\":1}"));
        assert!(looks_like_html(None, b"<HTML><BODY>"));
    }

    #[test]
    fn error_page_message() {
        let page = br#"<html><head><title>Error 404 Not Found</title><style>x{}</style></head>
            <body><h2>HTTP ERROR 404</h2><p>Problem accessing /nope. Reason:<pre>    Not Found</pre></p></body></html>"#;
        let m = html_error_message(page);
        assert!(m.starts_with("Error 404 Not Found"), "{m}");
        assert!(m.contains("Problem accessing /nope"), "{m}");
        assert!(!m.contains('<'));
        assert!(html_error_message(b"").contains("empty"));
    }

    #[test]
    fn jetty_listing() {
        let html = r#"<HTML><HEAD><link href="jetty-dir.css" rel="stylesheet" type="text/css"/><TITLE>Directory: /logs/</TITLE></HEAD><BODY>
<H1>Directory: /logs/</H1><TABLE BORDER=0>
<TR><TD><A HREF="/">Parent Directory</A></TD><TD></TD><TD></TD></TR>
<TR class="even"><TD><A HREF="hadoop-u-resourcemanager-h.log">hadoop-u-resourcemanager-h.log</A>&nbsp;</TD><TD ALIGN=right>1,234 bytes&nbsp;</TD><TD>Oct 3, 2026 12:02:00 PM</TD></TR>
<TR class="odd"><TD><A HREF="userlogs/">userlogs/</A>&nbsp;</TD><TD ALIGN=right>&nbsp;</TD><TD>Oct 3, 2026 11:00:00 AM</TD></TR>
<TR><TD><A HREF="a%20b.out">a b.out</A></TD><TD ALIGN=right>0 bytes</TD><TD></TD></TR>
</TABLE></BODY></HTML>"#;
        let f = parse_logs_listing(html);
        assert_eq!(f.len(), 3);
        assert_eq!(f[0].name, "hadoop-u-resourcemanager-h.log");
        assert_eq!(f[0].size, 1234);
        assert_eq!(f[0].modified.as_deref(), Some("Oct 3, 2026 12:02:00 PM"));
        assert!(!f[0].is_dir);
        assert!(f[1].is_dir);
        assert_eq!(f[1].name, "userlogs");
        assert_eq!(f[1].size, 0);
        assert_eq!(f[2].name, "a b.out");
        assert_eq!(f[2].size, 0);
        assert_eq!(f[2].modified, None);
    }

    #[test]
    fn jetty12_listing_with_classes() {
        // Verbatim shape of Hadoop 3.4.3's RM `/logs/` page (Jetty 12): name, lastmodified, size.
        let html = r#"<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><link href="jetty-dir.css" rel="stylesheet" /><title>Directory: /logs/</title></head>
<body><h1 class="title">Directory: /logs/</h1>
<table class="listing">
<thead><tr><th class="name"><a href="?C=N&O=D">Name&nbsp; &#8679;</a></th><th class="lastmodified"><a href="?C=M&O=A">Last Modified</a></th><th class="size"><a href="?C=S&O=A">Size</a></th></tr></thead>
<tbody>
<tr><td class="name"><a href="/logs/resourcemanager.log">resourcemanager.log&nbsp;</a></td><td class="lastmodified">Oct 3, 2026, 12:26:50 PM&nbsp;</td><td class="size">135,064 bytes&nbsp;</td></tr>
<tr><td class="name"><a href="/logs/rm.out">rm.out&nbsp;</a></td><td class="lastmodified">Oct 3, 2026, 12:21:03 PM&nbsp;</td><td class="size">1,712 bytes&nbsp;</td></tr>
</tbody></table></body></html>"#;
        let f = parse_logs_listing(html);
        assert_eq!(f.len(), 2, "{f:?}");
        assert_eq!(f[0].name, "resourcemanager.log");
        assert_eq!(f[0].size, 135_064);
        assert_eq!(f[0].modified.as_deref(), Some("Oct 3, 2026, 12:26:50 PM"));
        assert!(!f[0].is_dir);
        assert_eq!(f[1].name, "rm.out");
        assert_eq!(f[1].size, 1_712);
    }

    #[test]
    fn anchors_only_fallback() {
        let f = parse_logs_listing(
            r#"<ul><li><a href="x.log">x.log</a></li><li><a href="../">up</a></li></ul>"#,
        );
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].name, "x.log");
    }
}
