//! Static asset delivery (contract §7).
//!
//! Two sources, one interface:
//! * **embedded** — `crates/burrow/build.rs` stages `web/dist/client` (or `crates/burrow/assets`)
//!   into `$OUT_DIR/burrow-assets` and precompresses the compressible files, so `rust-embed` bakes the
//!   originals *and* their `.br`/`.gz` variants into the binary and serving picks a variant with no work
//!   at request time;
//! * **directory** (`--assets-dir`) — read from disk, preferring precompressed siblings when present.
//!
//! Only files that exist are served: the SPA fallback (`_shell.html`) and the "assets not built"
//! placeholder are the caller's decision (see [`crate::app`]).

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use burrow_core::config::Config;
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "$OUT_DIR/burrow-assets"]
struct Embedded;

/// The SPA shell TanStack Start's SPA mode emits; `index.html` is accepted as an alias.
const SHELL_NAMES: [&str; 2] = ["_shell.html", "index.html"];
/// A precompressed variant of a file: on-disk suffix vs HTTP `Content-Encoding` token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coding {
    Br,
    Gzip,
}

impl Coding {
    /// Suffix of the sibling file holding the compressed bytes.
    pub fn suffix(self) -> &'static str {
        match self {
            Self::Br => ".br",
            Self::Gzip => ".gz",
        }
    }

    /// The wire token for `Content-Encoding`.
    pub fn http(self) -> &'static str {
        match self {
            Self::Br => "br",
            Self::Gzip => "gzip",
        }
    }
}

const CODINGS: [Coding; 2] = [Coding::Br, Coding::Gzip];

pub const PLACEHOLDER_HTML: &str = r#"<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>burrow — web assets not built</title>
<style>body{font:14px/1.5 ui-monospace,monospace;margin:3rem auto;max-width:44rem;color:#111}
code{background:#f2f2f2;padding:.1rem .3rem;border-radius:3px}</style></head>
<body><h1>burrow: web assets not built</h1>
<p>The server is running, but no web UI is embedded in this binary and none was found on disk.</p>
<ul>
<li>Build the SPA: <code>bun run build</code> in <code>web/</code>, then rebuild the binary (the build
script picks up <code>web/dist/client</code> automatically).</li>
<li>Or point the server at a built SPA: <code>burrow serve --assets-dir web/dist/client</code>.</li>
</ul>
<p>Every <code>/api/*</code> endpoint works regardless — try <code>/api/healthz</code> or
<code>/api/meta</code>.</p></body></html>
"#;

/// One servable file, already chosen for the client's `Accept-Encoding`.
pub struct Asset {
    pub bytes: Cow<'static, [u8]>,
    pub content_type: String,
    /// Set when [`Asset::bytes`] is a precompressed variant (`br` / `gzip`).
    pub encoding: Option<Coding>,
    /// Hashed, content-addressed file ⇒ safe to cache forever.
    pub immutable: bool,
}

enum Source {
    Embedded,
    Dir { root: PathBuf, canonical: PathBuf },
}

pub struct Assets {
    source: Source,
    origin: String,
}

impl Assets {
    /// Embedded assets unless `--assets-dir` was given.
    pub fn from_config(cfg: &Config) -> Self {
        match &cfg.assets_dir {
            Some(dir) => Self::dir(dir.clone()),
            None => Self::embedded(),
        }
    }

    pub fn embedded() -> Self {
        let mut files = 0;
        for path in Embedded::iter() {
            if !is_variant(&path) {
                files += 1;
            }
        }
        Self {
            source: Source::Embedded,
            origin: format!("embedded ({files} files)"),
        }
    }

    pub fn dir(root: PathBuf) -> Self {
        let canonical = root.canonicalize().unwrap_or_else(|_| root.clone());
        let mut files = 0;
        collect_files(&root, &mut files);
        let origin = format!("--assets-dir {} ({files} files)", root.display());
        Self {
            source: Source::Dir { root, canonical },
            origin,
        }
    }

    /// Human description for the startup banner.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// True when a SPA shell is available (otherwise the caller serves the placeholder).
    pub fn has_shell(&self) -> bool {
        SHELL_NAMES.iter().any(|n| self.get(n, None).is_some())
    }

    /// The SPA shell, if present.
    pub fn shell(&self, accept_encoding: Option<&str>) -> Option<Asset> {
        SHELL_NAMES
            .iter()
            .find_map(|name| self.get(name, accept_encoding))
    }

    /// Exact-file lookup. Directories do not match; precompressed variants are chosen by
    /// `accept_encoding` and are never served as themselves.
    pub fn get(&self, path: &str, accept_encoding: Option<&str>) -> Option<Asset> {
        let path = normalize(path)?;
        if is_variant(&path) {
            return None;
        }
        let immutable = path.starts_with("assets/");
        let content_type = content_type_of(&path);
        let (bytes, encoding) = self.read(&path, accept_encoding)?;
        Some(Asset {
            bytes,
            content_type,
            encoding,
            immutable,
        })
    }

    /// Read `path`, preferring a precompressed variant the client accepts. Returns `None` if the file
    /// itself does not exist.
    fn read(
        &self,
        path: &str,
        accept_encoding: Option<&str>,
    ) -> Option<(Cow<'static, [u8]>, Option<Coding>)> {
        match &self.source {
            Source::Embedded => {
                let plain = Embedded::get(path)?;
                let variant = |coding: Coding| Embedded::get(&format!("{path}{}", coding.suffix()));
                let (br, gz) = (variant(Coding::Br), variant(Coding::Gzip));
                match pick_encoding(accept_encoding, br.is_some(), gz.is_some()) {
                    Some(Coding::Br) => br.map(|f| (f.data, Some(Coding::Br))),
                    Some(Coding::Gzip) => gz.map(|f| (f.data, Some(Coding::Gzip))),
                    None => Some((plain.data, None)),
                }
            }
            Source::Dir { root, canonical } => {
                let file = resolve_dir(root, canonical, path)?;
                let plain = std::fs::read(&file).ok()?;
                let variant = |coding: Coding| -> Option<Vec<u8>> {
                    let name = file.file_name()?.to_string_lossy().into_owned();
                    std::fs::read(file.with_file_name(format!("{name}{}", coding.suffix()))).ok()
                };
                let (br, gz) = (variant(Coding::Br), variant(Coding::Gzip));
                match pick_encoding(accept_encoding, br.is_some(), gz.is_some()) {
                    Some(Coding::Br) => Some((Cow::Owned(br?), Some(Coding::Br))),
                    Some(Coding::Gzip) => Some((Cow::Owned(gz?), Some(Coding::Gzip))),
                    None => Some((Cow::Owned(plain), None)),
                }
            }
        }
    }
}

/// The variant a client's `Accept-Encoding` selects, given which variants exist (`None` = identity).
fn pick_encoding(accept: Option<&str>, has_br: bool, has_gz: bool) -> Option<Coding> {
    let accept = accept?;
    let (qbr, qgz) = (quality(accept, "br"), quality(accept, "gzip"));
    if has_br && qbr > 0.0 && qbr >= qgz {
        Some(Coding::Br)
    } else if has_gz && qgz > 0.0 {
        Some(Coding::Gzip)
    } else {
        None
    }
}

/// `q` value for one content-coding (RFC 9110 §12.5.3); `*` fills in for unlisted codings.
fn quality(accept: &str, name: &str) -> f32 {
    let mut explicit = None;
    let mut wildcard = None;
    for part in accept.split(',') {
        let mut fields = part.split(';');
        let token = fields.next().unwrap_or("").trim().to_ascii_lowercase();
        let mut q = 1.0f32;
        for field in fields {
            if let Some(v) = field.trim().strip_prefix("q=") {
                q = v.parse().unwrap_or(1.0);
            }
        }
        if token == name {
            explicit = Some(q);
        } else if token == "*" {
            wildcard = Some(q);
        }
    }
    explicit.or(wildcard).unwrap_or(0.0)
}

fn content_type_of(path: &str) -> String {
    let guessed = mime_guess::from_path(path).first_raw();
    match guessed {
        Some("text/html") => "text/html; charset=utf-8".to_string(),
        Some(m) => m.to_string(),
        None => "application/octet-stream".to_string(),
    }
}

fn is_variant(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    CODINGS.iter().any(|c| lower.ends_with(c.suffix()))
}

/// Reject anything that could escape the asset root or name a directory. The path is percent-decoded
/// first, so `%2e%2e` cannot smuggle a dot segment past the check (the filesystem would happily resolve
/// it); a decoded `/` inside a segment is rejected for the same reason.
fn normalize(path: &str) -> Option<String> {
    let path = path.trim_start_matches('/');
    if path.is_empty() || path.contains('\0') || path.contains('\\') {
        return None;
    }
    let mut out = Vec::new();
    for segment in path.split('/') {
        let segment = percent_decode(segment);
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains('/') {
            return None;
        }
        out.push(segment);
    }
    Some(out.join("/"))
}

/// `%XX` → byte, lossily decoded as UTF-8 (`%zz` is left alone).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn resolve_dir(root: &Path, canonical: &Path, path: &str) -> Option<PathBuf> {
    let full = root.join(path);
    if !full.is_file() {
        return None;
    }
    // Defence in depth: a symlink out of the asset root is not an asset.
    let real = full.canonicalize().ok()?;
    real.starts_with(canonical).then_some(full)
}

fn collect_files(dir: &Path, count: &mut usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_files(&entry.path(), count);
        } else if kind.is_file() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with('.') && !is_variant(&name) {
                *count += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_traversal() {
        assert_eq!(normalize("assets/a.js").as_deref(), Some("assets/a.js"));
        assert_eq!(normalize("/a.js").as_deref(), Some("a.js"));
        assert_eq!(normalize("a//b.js").as_deref(), None);
        assert_eq!(normalize("a/../b").as_deref(), None);
        assert_eq!(normalize("").as_deref(), None);
        assert_eq!(normalize("a\\b").as_deref(), None);
        // Percent-encoded dot segments are decoded *before* the check: the filesystem would resolve
        // `%2e%2e` just like `..`, so it must never reach it.
        assert_eq!(normalize("assets/%2e%2e/_shell.html").as_deref(), None);
        assert_eq!(normalize("%2E%2E/x").as_deref(), None);
        assert_eq!(normalize("a/%2f/b").as_deref(), None);
        // Ordinary escapes are decoded, so files with spaces work.
        assert_eq!(
            normalize("assets/a%20b.js").as_deref(),
            Some("assets/a b.js")
        );
        assert_eq!(percent_decode("%zz%41"), "%zzA");
    }

    #[test]
    fn encoding_negotiation() {
        assert_eq!(
            pick_encoding(Some("gzip, br"), true, true),
            Some(Coding::Br)
        );
        assert_eq!(pick_encoding(Some("gzip"), true, true), Some(Coding::Gzip));
        assert_eq!(
            pick_encoding(Some("br;q=0, gzip"), true, true),
            Some(Coding::Gzip)
        );
        assert_eq!(
            pick_encoding(Some("br;q=0.1, gzip;q=0.9"), true, true),
            Some(Coding::Gzip)
        );
        assert_eq!(pick_encoding(Some("identity"), true, true), None);
        assert_eq!(pick_encoding(Some("*"), true, false), Some(Coding::Br));
        assert_eq!(pick_encoding(None, true, true), None);
        assert_eq!(pick_encoding(Some("gzip"), false, false), None);
        // The wire token must be the standard one, and it must not collide with the file suffix.
        assert_eq!(Coding::Gzip.http(), "gzip");
        assert_eq!(Coding::Gzip.suffix(), ".gz");
        assert_eq!(Coding::Br.http(), "br");
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type_of("_shell.html"), "text/html; charset=utf-8");
        assert_eq!(content_type_of("assets/a.js"), "text/javascript");
        assert_eq!(content_type_of("x.bin"), "application/octet-stream");
    }

    #[test]
    fn variants_are_not_servable() {
        let assets = Assets::dir(PathBuf::from("/nonexistent-burrow-assets"));
        assert!(assets.get("assets/a.js.br", Some("br")).is_none());
        assert!(assets.get("assets/a.js.gz", Some("gzip")).is_none());
        assert!(!assets.has_shell());
    }
}
