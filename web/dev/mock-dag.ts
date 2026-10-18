/**
 * Dev-mock handler for the DAG review route (`/dag-preview`).
 *
 * It serves the **real goldens** from `fixtures/spark/<version>/<workload>/` (plus the REST stage metrics captured next
 * to them), so the review route and the e2e screenshots exercise actual Spark output rather than invented data. This
 * handler is dev-only: the production binary never serves `/api/dev/*`.
 *
 * Routes (path is the request path with a leading `/api/` stripped):
 *   GET dev/dag/index                       → every golden in both Spark versions, summarised
 *   GET dev/dag/fixture?version=&workload=&file=  → one golden verbatim
 *   GET dev/dag/metrics?version=&workload=  → the captured `/stages?details=true` array (real task/shuffle numbers)
 *   GET dev/dag/sql?version=&workload=&file=      → one captured SQL plan execution
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPARK_DIR = join(ROOT, "fixtures", "spark");

/** Versions are discovered, not hard-coded, so a new capture set shows up without touching this file. */
function versions(): string[] {
  return readdirSync(SPARK_DIR).filter((name) => {
    const full = join(SPARK_DIR, name);
    return statSync(full).isDirectory() && /^\d+\.\d+\.\d+$/.test(name);
  });
}

function workloads(version: string): string[] {
  const base = join(SPARK_DIR, version);
  return readdirSync(base).filter((name) => statSync(join(base, name)).isDirectory());
}

interface GoldenSummary {
  version: string;
  workload: string;
  file: string;
  kind: string;
  granularity: string;
  jobId: number | null;
  stageId: number | null;
  attempt: number | null;
  stages: number;
  nodes: number;
  edges: number;
  skipped: number;
  barrier: boolean;
  cached: boolean;
  inferred: boolean;
  maxClusterDepth: number;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Cluster nesting depth, which is what makes a graph a "clusters-in-clusters" layout case. */
function clusterDepthOf(clusters: { id: string; parentId: string | null }[]): number {
  const byId = new Map(clusters.map((c) => [c.id, c]));
  let depth = 0;
  for (const c of clusters) {
    let d = 1;
    let parentId = c.parentId;
    const seen = new Set<string>([c.id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      d += 1;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    depth = Math.max(depth, d);
  }
  return depth;
}

function summarise(version: string, workload: string, file: string): GoldenSummary | null {
  const body = readJson<{
    kind?: string;
    granularity?: string;
    jobId?: number;
    edgesInferred?: boolean;
    stages?: {
      stageId?: number;
      attempt?: number;
      skipped?: boolean;
      nodes?: { cached?: boolean; barrier?: boolean }[];
      edges?: unknown[];
      clusters?: { id: string; parentId: string | null }[];
    }[];
    edges?: unknown[];
  }>(join(SPARK_DIR, version, workload, file));
  if (!body || !Array.isArray(body.stages)) return null;
  const nodes = body.stages.reduce((a, s) => a + (s.nodes?.length ?? 0), 0);
  const intraEdges = body.stages.reduce((a, s) => a + (s.edges?.length ?? 0), 0);
  const first = body.stages[0];
  return {
    version,
    workload,
    file,
    kind: body.kind ?? "job",
    granularity: body.granularity ?? "rdd",
    jobId: body.jobId ?? null,
    stageId: first?.stageId ?? null,
    attempt: first?.attempt ?? null,
    stages: body.stages.length,
    nodes,
    edges: intraEdges + (body.edges?.length ?? 0),
    skipped: body.stages.filter((s) => s.skipped).length,
    barrier: body.stages.some((s) => (s.nodes ?? []).some((n) => n.barrier)),
    cached: body.stages.some((s) => (s.nodes ?? []).some((n) => n.cached)),
    inferred: body.edgesInferred === true || body.granularity === "stage",
    maxClusterDepth: Math.max(
      0,
      ...body.stages.map((s) => clusterDepthOf((s.clusters ?? []).map((c) => ({ id: c.id, parentId: c.parentId })))),
    ),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-burrow-api": "1",
      "x-burrow-cache": "bypass",
    },
  });
}

function pathIn(version: string, workload: string, file: string): string | null {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (!/^[a-z0-9-]+$/i.test(workload)) return null;
  if (!/^[a-z0-9.\-_/]+$/i.test(file) || file.includes("..")) return null;
  return join(SPARK_DIR, version, workload, file);
}

export async function handleDag(_req: Request, path: string, url: URL): Promise<Response | null> {
  if (!path.startsWith("dev/dag/")) return null;

  if (path === "dev/dag/index") {
    const items: GoldenSummary[] = [];
    for (const version of versions()) {
      for (const workload of workloads(version)) {
        let files: string[] = [];
        try {
          files = readdirSync(join(SPARK_DIR, version, workload));
        } catch {
          continue;
        }
        for (const file of files.filter((f) => f.startsWith("dag-") && f.endsWith(".json")).sort()) {
          const summary = summarise(version, workload, file);
          if (summary) items.push(summary);
        }
      }
    }
    return jsonResponse({ versions: versions(), count: items.length, items });
  }

  if (path === "dev/dag/fixture") {
    const version = url.searchParams.get("version") ?? "";
    const workload = url.searchParams.get("workload") ?? "";
    const file = url.searchParams.get("file") ?? "";
    const full = pathIn(version, workload, file);
    if (!full || !file.startsWith("dag-")) return jsonResponse({ error: "bad fixture reference" }, 400);
    const body = readJson<unknown>(full);
    if (body === null) return jsonResponse({ error: `fixture not found: ${version}/${workload}/${file}` }, 404);
    return jsonResponse(body);
  }

  if (path === "dev/dag/metrics") {
    const version = url.searchParams.get("version") ?? "";
    const workload = url.searchParams.get("workload") ?? "";
    const full = pathIn(version, workload, "rest/final.stages.details.json");
    if (!full) return jsonResponse({ error: "bad metrics reference" }, 400);
    const body = readJson<unknown>(full);
    if (body === null) return jsonResponse({ error: `no captured stages for ${version}/${workload}` }, 404);
    return jsonResponse(body);
  }

  if (path === "dev/dag/sql") {
    const version = url.searchParams.get("version") ?? "";
    const workload = url.searchParams.get("workload") ?? "";
    const file = url.searchParams.get("file") ?? "";
    const full = pathIn(version, workload, file);
    if (!full || !/^rest\/final\.sql(\.details)?(-[0-9]+)?\.json$/.test(file)) {
      return jsonResponse({ error: "bad sql reference" }, 400);
    }
    const body = readJson<unknown>(full);
    if (body === null) return jsonResponse({ error: `sql plan not found: ${version}/${workload}/${file}` }, 404);
    return jsonResponse(body);
  }

  if (path === "dev/dag/sql-index") {
    const out: {
      version: string;
      workload: string;
      file: string;
      id: number;
      status: string;
      description: string;
      nodes: number;
      edges: number;
    }[] = [];
    for (const version of versions()) {
      for (const workload of workloads(version)) {
        const restDir = join(SPARK_DIR, version, workload, "rest");
        let files: string[] = [];
        try {
          files = readdirSync(restDir);
        } catch {
          continue;
        }
        for (const file of files.filter((f) => /^final\.sql-\d+\.json$/.test(f)).sort()) {
          const body = readJson<{ id?: number; status?: string; description?: string; nodes?: unknown[]; edges?: unknown[] }>(
            join(restDir, file),
          );
          if (!body || !Array.isArray(body.nodes)) continue;
          out.push({
            version,
            workload,
            file: `rest/${file}`,
            id: body.id ?? 0,
            status: body.status ?? "",
            description: (body.description ?? "").slice(0, 120),
            nodes: body.nodes.length,
            edges: body.edges?.length ?? 0,
          });
        }
      }
    }
    return jsonResponse({ count: out.length, items: out });
  }

  return null;
}
