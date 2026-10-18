/**
 * Dev-mock handlers for the container-log routes (contract §5) — the slice that `/apps/$appId/logs` reads.
 *
 * The bytes are the REAL captured logs (`fixtures/rm/logs/<containerId>/**`): a 5.2 MB cluster-mode Spark AM stdout
 * plus its stderr, a live-container userlog directory with all six NM files, and a second container reported as an
 * aggregated (JHS) source. Byte-range reads, `tail`, and the SSE follow stream behave like the Rust backend: the same
 * `x-burrow-log-*` headers, the same chunked `event: chunk` / `event: eof` sequence, the same 1 MiB default / 8 MiB cap.
 *
 * Paths arrive with `/api/` stripped (see `dev/mock-api.ts`). Return `null` to fall through.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import containersFixture from "../../fixtures/rm/logs/containers.json";

const WINDOW_BYTES = 1024 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const STREAM_CHUNK = 256 * 1024;

interface FixtureFile {
  name: string;
  size: number;
  lastModified: number;
}
interface FixtureContainer {
  source: string;
  node: string | null;
  app?: string;
  user?: string;
  containerId?: string;
  files: FixtureFile[];
}

const CONTAINERS = containersFixture as Record<string, FixtureContainer>;

const fixturePath = (containerId: string, name: string) =>
  fileURLToPath(new URL(`../../fixtures/rm/logs/${containerId}/${name}`, import.meta.url));

/** Bytes are read once and cached: the big fixture is 5 MB and every ranged request would otherwise re-read it. */
const cache = new Map<string, Buffer>();
function fileBytes(containerId: string, name: string): Buffer | null {
  const key = `${containerId}/${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const buf = readFileSync(fixturePath(containerId, name));
    cache.set(key, buf);
    return buf;
  } catch {
    return null;
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "x-burrow-api": "1", "x-burrow-cache": "hit" };

const notFound = (message: string, hint?: string) =>
  new Response(JSON.stringify({ error: { code: "not_found", message, ...(hint ? { hint } : {}) } }), {
    status: 404,
    headers: JSON_HEADERS,
  });

function filesResponse(containerId: string): Response | null {
  const entry = CONTAINERS[containerId];
  if (!entry) return null;
  const body = {
    source: entry.source,
    node: entry.node,
    files: entry.files.map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified })),
  };
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}

function rangeResponse(containerId: string, name: string, url: URL): Response | null {
  const bytes = fileBytes(containerId, name);
  if (!bytes) return null;
  const size = bytes.length;
  let start = 0;
  let end = size;
  const tail = url.searchParams.get("tail");
  if (tail != null) {
    const n = Math.max(1, Number(tail) || 1);
    start = Math.max(0, size - n);
  } else {
    const off = url.searchParams.get("offset");
    const len = url.searchParams.get("length");
    start = off != null ? Math.max(0, Math.min(size, Number(off) || 0)) : 0;
    const requested = len != null ? Math.max(0, Number(len) || 0) : WINDOW_BYTES;
    end = Math.min(size, start + Math.min(requested || WINDOW_BYTES, MAX_BYTES));
  }
  const text = bytes.subarray(start, end).toString("utf8");
  return new Response(text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-burrow-api": "1",
      "x-burrow-cache": "hit",
      "x-burrow-log-size": String(size),
      "x-burrow-log-start": String(start),
      "x-burrow-log-end": String(end),
      "x-burrow-log-source": CONTAINERS[containerId]?.source ?? "nm",
    },
  });
}

/**
 * SSE follow: replay the captured bytes from `offset` in 256 KiB chunks, then `event: eof`. A finished container's
 * stream ends; a real backend streaming a live container would keep the connection open — the mock's honest contract is
 * "here are the captured bytes, then the stream is done".
 */
function streamResponse(containerId: string, name: string, url: URL): Response | null {
  const bytes = fileBytes(containerId, name);
  if (!bytes) return null;
  const requested = Number(url.searchParams.get("offset") ?? 0);
  let pos = Number.isFinite(requested) ? Math.max(0, Math.min(bytes.length, requested)) : 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pos >= bytes.length) {
        controller.enqueue(encoder.encode("event: eof\ndata: {}\n\n"));
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, pos + STREAM_CHUNK);
      const text = bytes.subarray(pos, end).toString("utf8");
      controller.enqueue(encoder.encode(`event: chunk\ndata: ${JSON.stringify({ start: pos, end, text })}\n\n`));
      pos = end;
      await new Promise((resolve) => setTimeout(resolve, 15));
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-burrow-api": "1",
    },
  });
}

export async function handleLogs(_req: Request, path: string, url: URL): Promise<Response | null> {
  if (!path.startsWith("logs/containers/")) return null;
  const rest = path.slice("logs/containers/".length);
  const segments = rest.split("/").map(decodeURIComponent);
  const containerId = segments[0];
  if (!containerId) return null;

  // logs/containers/{containerId}
  if (segments.length === 1) {
    return (
      filesResponse(containerId) ??
      notFound(`No captured container ${containerId}`, "The dev mock replays fixtures/rm/logs/containers.json.")
    );
  }

  // logs/containers/{containerId}/files/{name}[/stream]
  if (segments[1] === "files" && segments[2]) {
    const name = segments[2];
    if (segments[3] === "stream") return streamResponse(containerId, name, url) ?? notFound(`No file ${name} for ${containerId}`);
    if (segments.length === 3) return rangeResponse(containerId, name, url) ?? notFound(`No file ${name} for ${containerId}`);
  }

  return notFound(`Unsupported log path /api/${path}`);
}
