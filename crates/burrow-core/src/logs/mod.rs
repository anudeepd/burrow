//! Container logs (contract §5): source selection, ranged reads, and live follow.
//!
//! ```text
//! GET /api/logs/containers/{containerId}?node&user&app                  → {source, node, files[]}
//! GET /api/logs/containers/{containerId}/files/{name}?offset&length&tail → text/plain byte window
//! GET /api/logs/containers/{containerId}/files/{name}/stream?offset=    → text/event-stream tail
//! ```
//!
//! # What Hadoop 3.4.3 actually serves (verified against the live test cluster)
//!
//! There is **no raw-text log endpoint** on either daemon. Every read is an HTML page whose content sits in
//! a single `<pre>` element, HTML-escaped; burrow extracts the text and never forwards the page.
//!
//! **NodeManager** (live evidence, `127.0.0.4:8042`):
//!
//! ```text
//! $ curl -s 127.0.0.4:8042/ws/v1/node/containers/container_…_0033_01_000001
//! {"container":{"id":"…","state":"RUNNING","user":"alice",
//!   "containerLogsLink":"http://127.0.0.4:8042/node/containerlogs/…/alice",
//!   "containerLogFiles":["prelaunch.out","prelaunch.err","launch_container.sh","directory.info","stdout","stderr"], …}}
//!
//! $ curl -s 127.0.0.4:8042/node/containerlogs/container_…_0033_01_000001/alice/
//! 200 text/html  →  <p><a href="…/stdout/?start=-4096">stdout : Total file length is 1789 bytes.</a></p> …
//!
//! $ curl -s '127.0.0.4:8042/node/containerlogs/…/alice/stdout/?start=0'
//! 200 text/html  →  …<pre>…the log, &lt;escaped&gt;…</pre>
//! ```
//!
//! `?start=` is a byte offset (negative = from the end, default `-4096`), `?end=` is a byte offset (default
//! = file length); `Range:` is **ignored**. Once the application has left the NodeManager (or
//! `log.aggregation.type=remote` is asked for) and `yarn.log-aggregation-enable=true` with
//! `yarn.log.server.url` set, the NodeManager answers **307** with a `Location` pointing at the
//! JobHistoryServer — observed verbatim:
//!
//! ```text
//! $ curl -si 127.0.0.4:8042/node/containerlogs/container_…_0033_01_000001/alice/
//! HTTP/1.1 307 Temporary Redirect
//! Location: http://127.0.0.1:19888/jobhistory/logs/127.0.0.4:8041/container_…_0033_01_000001/container_…_0033_01_000001/alice
//! ```
//!
//! burrow refuses upstream redirects (SSRF/credential hazard), so it recognises the terminal application
//! state and addresses the JobHistoryServer directly instead of replaying the redirect.
//!
//! **JobHistoryServer** (`127.0.0.1:19888`, `yarn.log.server.url=http://127.0.0.1:19888/jobhistory/logs`):
//!
//! ```text
//! $ curl -s 127.0.0.1:19888/jobhistory/logs/127.0.0.4:8041/container_…_0005_01_000001/container_…_0005_01_000001/alice/
//! 200 text/html  →  Log Type: syslog / Log Upload Time: Sat Oct 03 12:38:56 +0530 2026 / Log Length: 84941
//!                   …<pre>…</pre>   (one section per file; the tail 4096 bytes by default)
//!
//! $ curl -s '127.0.0.1:19888/jobhistory/logs/…/alice/syslog/?start=0&end=100'
//! 200 text/html  →  Log Length: 84941 … <pre>exactly the first 100 bytes</pre>
//! ```
//!
//! `start`/`end` are honoured exactly on the JobHistoryServer, and the page reports the file's full length,
//! which is what `x-burrow-log-size` is taken from.
//!
//! **ATS**: the contract lists `ats` as a possible source, but the Timeline Service v1/v2 does not serve log
//! *content* at all (only container metadata) and this cluster runs with `yarn.timeline-service.enabled=false`.
//! burrow therefore reports `nm` or `jhs` and documents the absence rather than inventing an `ats` path.
//!
//! # Caching
//!
//! * The listing page is fetched with a short TTL ([`source::LISTING_TTL`]) — files appear and disappear as
//!   containers run and aggregate — and the synthesized JSON listing reports the upstream cache source in
//!   `x-burrow-cache`.
//! * Log **bodies** are never cached (`TtlPolicy::None`): every read is a real byte window.

pub mod page;
pub mod source;
pub mod tail;

pub use page::ListedFile;
pub use source::{
    DEFAULT_WINDOW, HARD_CAP, LISTING_TTL, LogFileEntry, LogLocation, LogQuery, LogSourceKind,
    Resolved, Window, resolve, window,
};
pub use tail::{TailEvent, TailSpec};
