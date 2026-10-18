//! Parsers for the **HTML log pages** Hadoop's NodeManager and JobHistoryServer serve.
//!
//! Neither daemon exposes a raw-text log endpoint on Hadoop 3.4.3 (verified live; see the module docs in
//! [`crate::logs`]). A file read is always an HTML page whose content sits inside one `<pre>` element,
//! HTML-escaped; a directory listing is an HTML page with anchors of the form
//! `name : Total file length is N bytes.` (NodeManager) or one `Log Type: name` / `Log Length: N` section
//! per file (JobHistoryServer). burrow extracts the text and **never forwards the page**.

use std::sync::LazyLock;

use regex::Regex;

static RE_PRE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<pre\b[^>]*>(.*?)</pre\s*>").unwrap());
static RE_ANCHOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>(.*?)</a\s*>"#).unwrap()
});
static RE_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
static RE_WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static RE_TOTAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)Total file length is\s*([\d,]+)\s*bytes").unwrap());
static RE_JHS_SECTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)^Log Type:\s*(?P<name>.+?)\s+Log Upload Time:\s*(?P<time>.+?)\s+Log Length:\s*(?P<size>[\d,]+)",
    )
    .unwrap()
});
static RE_LOG_TYPE_MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Log Type:").unwrap());
static RE_AGGREGATED_H2: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<h2[^>]*>\s*Aggregated Logs").unwrap());
static RE_PAGE_TOTAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:of\s+([\d,]+)\s+total|Log Length:\s*([\d,]+))").unwrap());
static RE_NO_LOGS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<h1[^>]*>\s*(No logs available[^<]*|Cannot find[^<]*)</h1\s*>").unwrap()
});

/// HTML-unescape the entity set Hadoop's `HtmlQuoting` emits (`&amp; &lt; &gt; &quot; &#39;`) plus numeric
/// references, so a log line that literally contained `&lt;` round-trips exactly once.
pub fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            let ch = s[i..].chars().next().expect("valid utf-8");
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let rest = &s[i..];
        let semi = rest[..rest.len().min(12)].find(';');
        let decoded = semi.and_then(|end| {
            let name = &rest[1..end];
            match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" | "#x27" | "#X27" => Some('\''),
                "nbsp" => Some(' '),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                    .and_then(char::from_u32),
            }
        });
        match (decoded, semi) {
            (Some(c), Some(end)) => {
                out.push(c);
                i += end + 1;
            }
            _ => {
                out.push('&');
                i += 1;
            }
        }
    }
    out
}

/// Strip tags and unescape — the visible text of an HTML fragment, single-spaced.
pub fn text_of(fragment: &str) -> String {
    RE_WS
        .replace_all(&unescape(&RE_TAG.replace_all(fragment, " ")), " ")
        .trim()
        .to_string()
}

/// Every `<pre>` block on the page, unescaped, in document order.
pub fn pre_blocks(html: &str) -> Vec<String> {
    RE_PRE
        .captures_iter(html)
        .map(|c| unescape(&c[1]))
        .collect()
}

/// The log text of a single-file page: the concatenation of its `<pre>` blocks (there is exactly one).
pub fn log_text(html: &str) -> String {
    pre_blocks(html).concat()
}

/// The file length a page reports, if it reports one.
pub fn page_total_len(html: &str) -> Option<u64> {
    RE_PAGE_TOTAL.captures(html).and_then(|c| {
        c.get(1)
            .or_else(|| c.get(2))
            .and_then(|m| m.as_str().replace(',', "").parse().ok())
    })
}

/// `Some(reason)` when the page is Hadoop's "no logs here" page rather than a listing.
pub fn no_logs_reason(html: &str) -> Option<String> {
    RE_NO_LOGS
        .captures(html)
        .map(|c| text_of(&c[1]))
        .filter(|s| !s.is_empty())
}

/// `Some(reason)` when a file read page reports that the file could not be read.
pub fn read_error(html: &str) -> Option<String> {
    if !pre_blocks(html).is_empty() {
        return None;
    }
    let text = text_of(html);
    for needle in [
        "Cannot find this log",
        "Unknown container",
        "not authorized to view the logs",
        "Invalid start and end values",
        "No logs available",
        "Unable to locate",
    ] {
        if let Some(pos) = text.find(needle) {
            return Some(text[pos..].chars().take(200).collect());
        }
    }
    None
}

/// One file as the NodeManager's local-log listing prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedFile {
    pub name: String,
    pub size: u64,
    pub modified: Option<i64>,
}

/// Parse the NodeManager's `Local Logs:` section (`<p><a …>name : Total file length is N bytes.</a></p>`).
///
/// The optional `Aggregated Logs:` section that follows (files already uploaded, whose names carry a
/// timestamp suffix) is ignored: those are served by the JobHistoryServer, not by this NodeManager path.
pub fn nm_listing(html: &str) -> Vec<ListedFile> {
    let local = match RE_AGGREGATED_H2.find(html) {
        Some(m) => &html[..m.start()],
        None => html,
    };
    let mut files = Vec::new();
    for cap in RE_ANCHOR.captures_iter(local) {
        let text = text_of(&cap[2]);
        let Some(total) = RE_TOTAL.captures(&text) else {
            continue;
        };
        let name = text
            .split(':')
            .next()
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let size = total[1].replace(',', "").parse().unwrap_or(0);
        files.push(ListedFile {
            name,
            size,
            modified: None,
        });
    }
    files
}

/// Parse the JobHistoryServer's aggregated-log listing.
///
/// The page renders one section per file as three `<p>` paragraphs (`Log Type:`, `Log Upload Time:`,
/// `Log Length:`) followed by the `<pre>` holding that file's tail — so the metadata is parsed from the
/// *tag-stripped text of each section*, not from the raw markup, and the section is bounded by the next
/// `Log Type:` marker so a log line that itself contains the words cannot invent a file.
pub fn jhs_listing(html: &str) -> Vec<ListedFile> {
    let starts: Vec<usize> = RE_LOG_TYPE_MARK
        .find_iter(html)
        .map(|m| m.start())
        .collect();
    let mut files = Vec::new();
    for (i, &start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(html.len());
        let section = text_of(&html[start..end]);
        let Some(cap) = RE_JHS_SECTION.captures(&section) else {
            continue;
        };
        let name = cap.name("name").map(|m| m.as_str().trim()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let size = cap
            .name("size")
            .map(|m| m.as_str().replace(',', ""))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let modified = cap.name("time").and_then(|m| java_date_epoch(m.as_str()));
        files.push(ListedFile {
            name: name.to_string(),
            size,
            modified,
        });
    }
    files
}

/// Parse a Java `Date.toString()` stamp (`Sat Oct 03 12:38:56 +0530 2026`) to epoch seconds.
pub fn java_date_epoch(s: &str) -> Option<i64> {
    let mut it = s.split_whitespace();
    let _dow = it.next()?;
    let mon = match it.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let day: i64 = it.next()?.parse().ok()?;
    let mut hms = it.next()?.split(':');
    let h: i64 = hms.next()?.parse().ok()?;
    let mi: i64 = hms.next()?.parse().ok()?;
    let sec: i64 = hms.next()?.parse().ok()?;
    let tz = it.next()?;
    let year: i64 = it.next()?.parse().ok()?;
    let (sign, rest) = match tz.as_bytes().first()? {
        b'+' => (1i64, &tz[1..]),
        b'-' => (-1i64, &tz[1..]),
        _ => return None,
    };
    if rest.len() != 4 {
        return None;
    }
    let off = sign * (rest[..2].parse::<i64>().ok()? * 3600 + rest[2..].parse::<i64>().ok()? * 60);
    Some(days_from_civil(year, mon, day) * 86_400 + h * 3600 + mi * 60 + sec - off)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    const NM_LISTING: &str = r#"<html><body><h2>Local Logs:</h2>
<p><a href="/node/containerlogs/c/alice/directory.info/?start=-4096">directory.info : Total file length is 4414 bytes.</a></p>
<p><a href="/node/containerlogs/c/alice/launch_container.sh/?start=-4096">launch_container.sh : Total file length is 8156 bytes.</a></p>
<p><a href="/node/containerlogs/c/alice/prelaunch.err/?start=-4096">prelaunch.err : Total file length is 0 bytes.</a></p>
<h2>Aggregated Logs:</h2>
<p><a href="/node/containerlogs/c/alice/stdout/?start=-4096&amp;log.aggregation.type=remote">stdout_2026-10-03 12:38:56 : Total file length is 1789 bytes.</a></p>
</body></html>"#;

    #[test]
    fn nm_listing_reads_names_and_sizes_and_skips_the_aggregated_section() {
        let files = nm_listing(NM_LISTING);
        assert_eq!(
            files,
            vec![
                ListedFile {
                    name: "directory.info".into(),
                    size: 4414,
                    modified: None
                },
                ListedFile {
                    name: "launch_container.sh".into(),
                    size: 8156,
                    modified: None
                },
                ListedFile {
                    name: "prelaunch.err".into(),
                    size: 0,
                    modified: None
                },
            ]
        );
    }

    #[test]
    fn nm_file_page_yields_the_escaped_pre_content() {
        let page = r#"<html><body><p>Showing 20 bytes. Click <a href="x">here</a> for full log</p>
<pre>a &lt;tag&gt; and &quot;quotes&quot; &amp; an &#39;apostrophe&#39;</pre></body></html>"#;
        assert_eq!(log_text(page), "a <tag> and \"quotes\" & an 'apostrophe'");
    }

    #[test]
    fn double_escaped_entities_round_trip_once() {
        // The daemon escapes the log's literal `&lt;` to `&amp;lt;`; we must give back `&lt;`.
        let page = "<pre>&amp;lt;not a tag&amp;gt;</pre>";
        assert_eq!(log_text(page), "&lt;not a tag&gt;");
    }

    #[test]
    fn jhs_sections_carry_name_size_and_upload_time() {
        // Verbatim shape of the Hadoop 3.4.3 page: three <p> paragraphs per file, then the tail <pre>.
        let page = r#"<html><body><td class="content">
          <p>
            Log Type: directory.info
          <p>
            Log Upload Time: Sat Oct 03 12:38:56 +0530 2026
          <p>
            Log Length: 2512
          <p>
            Showing 4096 bytes of 2512 total. Click
            <a href="/jobhistory/logs/n/c/c/alice/directory.info/?start=0&amp;start.time=0">here</a>
          <pre>ls -l</pre>
          <p>
            Log Type: syslog
          <p>
            Log Upload Time: Sat Oct 03 12:38:56 +0530 2026
          <p>
            Log Length: 84941
          <p>
            Showing 4096 bytes of 84941 total.
          <pre>Log Type: not a real section</pre>
        </td></body></html>"#;
        let files = jhs_listing(page);
        assert_eq!(files.len(), 2, "{files:?}");
        assert_eq!(files[0].name, "directory.info");
        assert_eq!(files[0].size, 2512);
        assert_eq!(files[1].name, "syslog");
        assert_eq!(files[1].size, 84941);
        // 2026-10-03 12:38:56 +0530 == 2026-10-03 07:08:56Z
        assert_eq!(files[1].modified, Some(1_791_011_336));
    }

    #[test]
    fn java_date_parsing_handles_offsets_and_padding() {
        assert_eq!(
            java_date_epoch("Sat Oct 03 12:38:56 +0530 2026"),
            Some(1_791_011_336)
        );
        assert_eq!(java_date_epoch("Thu Jan 01 00:00:00 +0000 1970"), Some(0));
        assert_eq!(java_date_epoch("Thu Jan 01 05:30:00 +0530 1970"), Some(0));
        assert_eq!(java_date_epoch("Wed Dec 31 19:00:00 -0500 1969"), Some(0));
        assert_eq!(java_date_epoch("nonsense"), None);
    }

    #[test]
    fn page_total_and_error_detection() {
        assert_eq!(
            page_total_len("<p>Showing 4096 bytes of 84941 total.</p>"),
            Some(84941)
        );
        assert_eq!(page_total_len("<p>Log Length: 7</p>"), Some(7));
        assert_eq!(page_total_len("<p>nothing here</p>"), None);
        assert_eq!(
            read_error("<html><h1>Cannot find this log on the local disk.</h1></html>").as_deref(),
            Some("Cannot find this log on the local disk.")
        );
        assert_eq!(read_error("<html><pre>ok</pre></html>"), None);
        assert!(no_logs_reason("<h1>No logs available for container c</h1>").is_some());
    }
}
