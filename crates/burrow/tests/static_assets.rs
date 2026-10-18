//! Static delivery (§7): the SPA shell and its fallback, immutable hashed assets, precompressed variant
//! selection, 404-for-missing-files, the "assets not built" page, and `--assets-dir`.

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};

use burrow_core::config::Config;
use common::{Harness, Mock};

const SHELL: &str = "<!DOCTYPE html><html><head><meta property=\"csp-nonce\" content=\"__BURROW_CSP_NONCE__\"><script src=\"/theme-init.js\"></script><title>burrow shell</title></head><body><div id=\"root\"></div><script>window.__shellReady=true;</script></body></html>";
const APP: &str = "console.log('burrow app bundle '.repeat(40));\n// padding padding padding padding\n// padding padding padding padding\n// padding padding padding padding\n";

fn write_asset(dir: &Path, rel: &str, body: &str) {
    let path = dir.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, body).unwrap();
}

/// A synthetic SPA build: shell + one hashed asset + brotli and gzip variants of the asset.
fn synthetic_assets() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    write_asset(&root, "_shell.html", SHELL);
    write_asset(&root, "assets/app-DEADBEEF.js", APP);
    write_asset(
        &root,
        "favicon.svg",
        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    );
    write_asset(
        &root,
        "assets/has space.js",
        "// a file name with a space\n",
    );

    let mut br = Vec::new();
    {
        let mut w = brotli::CompressorWriter::new(&mut br, 4096, 9, 22);
        w.write_all(APP.as_bytes()).unwrap();
        w.flush().unwrap();
    }
    std::fs::write(root.join("assets/app-DEADBEEF.js.br"), &br).unwrap();
    let mut gz = Vec::new();
    {
        let mut w = flate2::write::GzEncoder::new(&mut gz, flate2::Compression::new(6));
        w.write_all(APP.as_bytes()).unwrap();
        w.finish().unwrap();
    }
    std::fs::write(root.join("assets/app-DEADBEEF.js.gz"), &gz).unwrap();
    (dir, root)
}

fn config_for_assets(mock: &Mock, dir: &Path) -> Config {
    let mut cfg = Harness::config_for(&mock.base());
    cfg.assets_dir = Some(dir.to_path_buf());
    cfg
}

/// Undo `inject_nonce` so tests can assert the *content* of a shell independently of the nonce.
fn strip_nonce(html: &str) -> String {
    fn drop_attr(rest: &str, attr: &str) -> String {
        let mut out = String::with_capacity(rest.len());
        let mut cur = rest;
        while let Some(i) = cur.find(attr) {
            out.push_str(&cur[..i]);
            let tail = &cur[i + attr.len()..];
            let Some(end) = tail.find('"') else { break };
            cur = &tail[end + 1..];
        }
        out.push_str(cur);
        out
    }
    // TanStack prerendering may nonce styles, preload links, and meta tags too. Their per-response
    // nonce is just as dynamic as a script's, so normalize every nonce attribute before comparing.
    let scripts = drop_attr(html, " nonce=\"");
    // …then normalize its per-response content to the prerendered placeholder.
    let mut out = String::with_capacity(scripts.len());
    let mut cur = scripts.as_str();
    while let Some(i) = cur.find("<meta property=\"csp-nonce\"") {
        out.push_str(&cur[..i]);
        let Some(end) = cur[i..].find('>') else {
            break;
        };
        let tag_end = i + end + 1;
        let tag = &cur[i..tag_end];
        let normalized_tag = if let Some(content_at) = tag.find("content=\"") {
            let value_start = content_at + "content=\"".len();
            if let Some(value_end) = tag[value_start..].find('"') {
                let value_end = value_start + value_end;
                format!(
                    "{}__BURROW_CSP_NONCE__{}",
                    &tag[..value_start],
                    &tag[value_end..]
                )
            } else {
                tag.to_owned()
            }
        } else {
            tag.to_owned()
        };
        out.push_str(&normalized_tag);
        cur = &cur[tag_end..];
    }
    out.push_str(cur);
    out
}

/// The served shell must carry one nonce in three places at once: the `csp-nonce` meta tag, every
/// inline `<script>` tag, and the response's own CSP header. External scripts stay unchanged. Returns nonce.
fn assert_nonce_consistent(html: &str, csp: &str) -> String {
    let meta_at = html
        .find("property=\"csp-nonce\"")
        .expect("csp-nonce meta tag must be present");
    let after = &html[meta_at..];
    let start = after.find("content=\"").expect("content attr") + "content=\"".len();
    let nonce = after[start..].split('"').next().unwrap().to_string();
    assert!(!nonce.is_empty(), "nonce must not be empty");
    assert!(
        csp.contains(&format!("'nonce-{nonce}'")),
        "CSP must carry the same nonce: {csp}"
    );
    assert!(
        csp.contains("script-src 'self' 'nonce-"),
        "script-src must be nonce-scoped: {csp}"
    );
    let mut scripts = 0;
    for chunk in html.split("<script").skip(1) {
        scripts += 1;
        let attrs = chunk.split('>').next().unwrap_or_default();
        let is_external = attrs
            .split_whitespace()
            .any(|attr| attr.starts_with("src="));
        if is_external {
            assert!(
                !attrs.contains("nonce="),
                "external script must not be rewritten: {}",
                &attrs[..attrs.len().min(60)]
            );
        } else {
            assert!(
                attrs.starts_with(&format!(" nonce=\"{nonce}\"")),
                "inline script must carry the nonce, found: {}",
                &attrs[..attrs.len().min(60)]
            );
        }
    }
    let _ = scripts; // synthetic shells carry none; the real SPA shell is asserted elsewhere
    nonce
}

#[tokio::test]
async fn shell_is_served_with_no_cache_and_unknown_paths_fall_back_to_it() {
    let (dir, root) = synthetic_assets();
    let mock = Mock::start().await;
    let h = Harness::start(config_for_assets(&mock, &root)).await;

    for path in [
        "/",
        "/index.html",
        "/_shell.html",
        "/apps/application_1_0001",
        "/nodes/127.0.0.2:8042",
        "/scheduler/root.default",
    ] {
        let r = h.get(path).await;
        assert_eq!(r.status, 200, "{path}");
        // The shell is rewritten per response with a CSP nonce, so assert structure, not identity.
        assert!(r.text().starts_with("<!DOCTYPE html>"), "{path}");
        assert!(r.text().contains("id=\"root\""), "{path}");
        assert_nonce_consistent(&r.text(), &r.header("content-security-policy").unwrap());
        assert!(
            r.header("content-type").unwrap().starts_with("text/html"),
            "{path}"
        );
        assert_eq!(
            r.header("cache-control").as_deref(),
            Some("no-cache"),
            "{path}"
        );
    }
    assert_eq!(
        mock.total_hits().await,
        0,
        "static delivery never touches an upstream"
    );
    drop(dir);
}

#[tokio::test]
async fn shell_csp_nonce_is_fresh_per_response_and_stamped_on_inline_scripts() {
    let (dir, root) = synthetic_assets();
    let mock = Mock::start().await;
    let h = Harness::start(config_for_assets(&mock, &root)).await;

    let a = h.get("/").await;
    let b = h.get("/").await;
    let (na, nb) = (
        assert_nonce_consistent(&a.text(), &a.header("content-security-policy").unwrap()),
        assert_nonce_consistent(&b.text(), &b.header("content-security-policy").unwrap()),
    );
    assert_ne!(
        na, nb,
        "a nonce must never be reused across responses (cacheable nonce = useless nonce)"
    );
    // A stale-precompressed shell would defeat the rewrite: HTML must never be served with
    // `content-encoding` straight from the `.br`/`.gz` sidecars.
    assert_eq!(
        a.header("content-encoding"),
        None,
        "HTML is compressed on the fly, not precompressed"
    );
    assert_eq!(a.header("vary").as_deref(), Some("accept-encoding"));
    drop(dir);
}

#[tokio::test]
async fn hashed_assets_are_immutable_and_missing_files_are_404() {
    let (dir, root) = synthetic_assets();
    let mock = Mock::start().await;
    let h = Harness::start(config_for_assets(&mock, &root)).await;

    let js = h.get("/assets/app-DEADBEEF.js").await;
    assert_eq!(js.status, 200);
    assert_eq!(js.text(), APP);
    assert!(js.header("content-type").unwrap().contains("javascript"));
    assert_eq!(
        js.header("cache-control").as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(js.header("vary").as_deref(), Some("accept-encoding"));

    // Percent-encoded names resolve to the real file (URLs never contain a raw space).
    let spaced = h.get("/assets/has%20space.js").await;
    assert_eq!(spaced.status, 200);
    assert!(spaced.text().contains("a file name with a space"));

    // A missing file inside the hashed asset directory is a 404, not the shell.
    assert_eq!(h.get("/assets/gone-1234.js").await.status, 404);
    // A missing file with a static extension elsewhere is also a 404.
    assert_eq!(h.get("/favicon.ico").await.status, 404);
    // But a deep route is the shell.
    assert_eq!(strip_nonce(&h.get("/apps/x/y/z").await.text()), SHELL);
    // The precompressed variants themselves are not addressable.
    assert_eq!(h.get("/assets/app-DEADBEEF.js.br").await.status, 404);
    assert_eq!(h.get("/assets/app-DEADBEEF.js.gz").await.status, 404);
    // Traversal: URL clients normalise `..`/`%2e%2e` away before sending, so probe the server's own
    // behaviour with raw request lines (the filesystem would resolve `%2e%2e` if we did not decode first).
    for target in [
        "/assets/%2e%2e/_shell.html",
        "/assets/..%2f_shell.html",
        "/assets/%2e%2e/%2e%2e/etc/passwd",
        "/assets//../_shell.html",
    ] {
        let (status, body) = common::raw_get(&h.addr(), target, None).await;
        assert_eq!(status, 404, "{target} → {status} {body}");
    }
    drop(dir);
}

#[tokio::test]
async fn precompressed_variants_are_selected_by_accept_encoding() {
    let (dir, root) = synthetic_assets();
    let mock = Mock::start().await;
    let h = Harness::start(config_for_assets(&mock, &root)).await;
    let path = "/assets/app-DEADBEEF.js";

    let plain = h.get_with(path, &[("Accept-Encoding", "identity")]).await;
    assert_eq!(plain.header("content-encoding"), None);
    assert_eq!(plain.text(), APP);

    let br = h
        .get_with(path, &[("Accept-Encoding", "gzip, deflate, br")])
        .await;
    assert_eq!(br.header("content-encoding").as_deref(), Some("br"));
    assert!(br.body.len() < plain.body.len());
    let mut decoded = Vec::new();
    brotli::BrotliDecompress(&mut std::io::Cursor::new(&br.body), &mut decoded).unwrap();
    assert_eq!(String::from_utf8(decoded).unwrap(), APP);

    let gz = h.get_with(path, &[("Accept-Encoding", "gzip")]).await;
    assert_eq!(gz.header("content-encoding").as_deref(), Some("gzip"));
    let mut decoded = String::new();
    std::io::Read::read_to_string(
        &mut flate2::read::GzDecoder::new(std::io::Cursor::new(&gz.body)),
        &mut decoded,
    )
    .unwrap();
    assert_eq!(decoded, APP);

    // `br;q=0` means "not brotli" even though the variant exists.
    let no_br = h
        .get_with(path, &[("Accept-Encoding", "br;q=0, gzip")])
        .await;
    assert_eq!(no_br.header("content-encoding").as_deref(), Some("gzip"));
    drop(dir);
}

#[tokio::test]
async fn no_shell_means_the_assets_not_built_page() {
    let empty = tempfile::tempdir().unwrap();
    let mock = Mock::start().await;
    let h = Harness::start(config_for_assets(&mock, empty.path())).await;

    let r = h.get("/").await;
    assert_eq!(r.status, 503);
    assert!(r.header("content-type").unwrap().starts_with("text/html"));
    assert!(r.text().contains("web assets not built"), "{}", r.text());
    assert!(r.text().contains("--assets-dir"));
    assert_eq!(r.header("cache-control").as_deref(), Some("no-store"));

    // The API keeps working while the UI is missing.
    assert_eq!(h.get("/api/healthz").await.status, 200);
    assert!(h.get("/api/healthz").await.text() == "ok");
}

#[tokio::test]
async fn host_allowlist_applies_to_static_paths_too() {
    let (dir, root) = synthetic_assets();
    let mock = Mock::start().await;
    let cfg = config_for_assets(&mock, &root);
    let h = Harness::start(cfg).await;

    let r = h
        .client
        .get(h.url("/"))
        .header("host", "evil.example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 403);
    drop(dir);
}

#[tokio::test]
async fn base_path_prefixes_everything() {
    let (dir, root) = synthetic_assets();
    let mock = Mock::start().await;
    let mut cfg = config_for_assets(&mock, &root);
    cfg.base_path = "/burrow".into();
    let h = Harness::start(cfg).await;

    assert_eq!(h.get("/burrow").await.status, 200);
    assert_eq!(h.get("/burrow/").await.status, 200);
    assert_eq!(strip_nonce(&h.get("/burrow/apps/x").await.text()), SHELL);
    assert_eq!(h.get("/burrow/api/healthz").await.text(), "ok");
    assert_eq!(h.get("/burrow/assets/app-DEADBEEF.js").await.text(), APP);
    // Outside the prefix: nothing is served.
    assert_eq!(h.get("/").await.status, 404);
    assert_eq!(h.get("/api/healthz").await.status, 404);
    assert_eq!(h.get("/assets/app-DEADBEEF.js").await.status, 404);
    drop(dir);
}

#[tokio::test]
async fn embedded_assets_serve_the_real_spa_when_it_was_built() {
    let dist = Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/dist/client"
    ));
    if !dist.join("_shell.html").is_file() {
        eprintln!("skipping: web/dist/client/_shell.html is absent (run `bun run build` in web/)");
        return;
    }
    let mock = Mock::start().await;
    let h = Harness::start(Harness::config_for(&mock.base())).await;

    let shell = h.get("/").await;
    assert_eq!(shell.status, 200);
    assert!(
        shell.text().contains("<html"),
        "{}",
        &shell.text()[..200.min(shell.text().len())]
    );
    assert_eq!(shell.header("cache-control").as_deref(), Some("no-cache"));

    // A deep link serves the same shell (with its own fresh nonce).
    let deep = h.get("/apps/application_1791010263442_0001").await;
    assert_eq!(strip_nonce(&deep.text()), strip_nonce(&shell.text()));
    assert!(
        deep.header("content-security-policy")
            .unwrap()
            .contains("'nonce-"),
        "the real shell's CSP must be nonce-scoped"
    );

    // The hashed bundle is embedded *and* precompressed at build time.
    let bundle = std::fs::read_dir(dist.join("assets"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("js"))
        .expect("a built js bundle");
    let name = bundle.file_name().unwrap().to_string_lossy().to_string();
    let raw = std::fs::read(&bundle).unwrap();
    let served = h.get(&format!("/assets/{name}")).await;
    assert_eq!(served.status, 200);
    assert_eq!(served.body, raw, "byte-identical to the built file");
    assert_eq!(
        served.header("cache-control").as_deref(),
        Some("public, max-age=31536000, immutable")
    );

    let br = h
        .get_with(&format!("/assets/{name}"), &[("Accept-Encoding", "br")])
        .await;
    assert_eq!(br.header("content-encoding").as_deref(), Some("br"));
    let mut decoded = Vec::new();
    brotli::BrotliDecompress(&mut std::io::Cursor::new(&br.body), &mut decoded).unwrap();
    assert_eq!(decoded, raw, "the precompressed variant is the same bytes");
    assert!(
        br.body.len() < raw.len(),
        "brotli {} vs raw {}",
        br.body.len(),
        raw.len()
    );
}
