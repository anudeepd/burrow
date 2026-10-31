//! Build step for `burrow`: stage the web assets into `$OUT_DIR/burrow-assets` so the binary can embed
//! them with `rust-embed`, and precompress the compressible ones (`.br` + `.gz`) so serving never
//! compresses at request time.
//!
//! Source of truth, in order:
//! 1. `$BURROW_ASSETS_DIR` (explicit override, e.g. a CI artifact),
//! 2. `web/dist/client` — the real TanStack Start SPA build,
//! 3. `crates/burrow/assets` — the checked-in placeholder (only `.gitkeep`), which yields the
//!    "web assets not built" page at runtime.
//!
//! Only dot-files are skipped; everything else is copied verbatim. Precompression is skipped for
//! already-compressed media and for files under 512 bytes.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Extensions worth compressing, and the brotli/gzip levels used for them.
fn compressible(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(
            "html"
                | "htm"
                | "js"
                | "mjs"
                | "css"
                | "json"
                | "map"
                | "svg"
                | "txt"
                | "xml"
                | "webmanifest"
                | "wasm"
        )
    )
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("burrow-assets");
    println!("cargo:rerun-if-env-changed=BURROW_ASSETS_DIR");
    println!("cargo:rerun-if-changed=build.rs");

    let sources = [
        (
            std::env::var_os("BURROW_ASSETS_DIR").map(PathBuf::from),
            "BURROW_ASSETS_DIR",
        ),
        (
            Some(manifest.join("../../web/dist/client")),
            "web/dist/client",
        ),
        (Some(manifest.join("assets")), "crates/burrow/assets"),
    ];
    // Watch candidates even when absent. A first Rust build can precede the web build; creation
    // of web/dist/client must then replace the embedded placeholder on the next Cargo invocation.
    for (candidate, _) in &sources {
        if let Some(path) = candidate {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
    let picked = sources.iter().find_map(|(p, label)| {
        p.as_ref()
            .filter(|p| p.is_dir())
            .map(|p| (p.clone(), *label))
    });

    let _ = fs::remove_dir_all(&out);
    fs::create_dir_all(&out).expect("create OUT_DIR/burrow-assets");

    if let Some((src, _label)) = &picked {
        println!("cargo:rerun-if-changed={}", src.display());
        copy_tree(src, &out, &mut |p| {
            println!("cargo:rerun-if-changed={}", p.display())
        })
        .unwrap_or_else(|e| panic!("cannot stage assets from {}: {e}", src.display()));
    }

    if !out.join("_shell.html").is_file() && !out.join("index.html").is_file() {
        println!(
            "cargo:warning=burrow: no web assets found (looked at BURROW_ASSETS_DIR, web/dist/client, \
             crates/burrow/assets) — run `bun run build` in web/ first; the server will answer with \
             a placeholder page until then"
        );
    }
}

/// Copy `src` into `dst`.
fn copy_tree(src: &Path, dst: &Path, on_file: &mut impl FnMut(&Path)) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let from = entry.path();
        let to = dst.join(name.as_ref());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            fs::create_dir_all(&to)?;
            copy_tree(&from, &to, on_file)?;
            continue;
        }
        if !kind.is_file() {
            continue; // symlinks and specials are never embedded
        }
        on_file(&from);
        let data = fs::read(&from)?;
        fs::write(&to, &data)?;
        if data.len() >= 512 && compressible(&from) {
            fs::write(dst.join(format!("{name}.br")), brotli_bytes(&data)).expect("write .br");
            fs::write(dst.join(format!("{name}.gz")), gzip_bytes(&data)).expect("write .gz");
        }
    }
    Ok(())
}

/// Brotli quality 9 for ordinary assets, 6 for multi-hundred-KB bundles (build time, not size, is the
/// constraint; both are far better than what we would get at request time).
fn brotli_bytes(data: &[u8]) -> Vec<u8> {
    let quality = if data.len() > 256 * 1024 { 6 } else { 9 };
    let mut out = Vec::with_capacity(data.len() / 3);
    {
        let mut w = brotli::CompressorWriter::new(&mut out, 4096, quality, 22);
        w.write_all(data).expect("brotli compress");
        w.flush().expect("brotli flush");
    }
    out
}

fn gzip_bytes(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() / 3);
    {
        let mut w = flate2::write::GzEncoder::new(&mut out, flate2::Compression::new(9));
        w.write_all(data).expect("gzip compress");
        w.finish().expect("gzip finish");
    }
    out
}
