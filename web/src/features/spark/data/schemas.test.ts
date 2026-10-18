// @vitest-environment node
/**
 * Schema conformance against the recorded Spark REST fixtures.
 *
 * The P1 gate intends STRICT schemas everywhere (`vitest.setup.ts` enables `__BURROW_STRICT_SCHEMAS__`), but the *product*
 * runs in LOOSE mode: a newer Spark that adds a field must never break the UI. So the binding assertion here is that
 * every captured payload parses in loose (production) mode — strictness would flag the very drift the product tolerates.
 *
 * We therefore:
 *   1. re-import `./schemas` with the flag OFF (`vi.resetModules()` so `~/api/schemas/_base` re-evaluates too) and assert
 *      every `fixtures/spark/**\/rest/*.json` (status 200) and every `dag-*.json` parses;
 *   2. re-import with the flag ON and print an informational unknown-key census per endpoint (never fails the build —
 *      that is P1's gate; the Spark key census lives in `fixtures/spark/4.2.0/rest-keys.json`).
 *
 * The endpoint → schema choice comes from each workload's `MANIFEST.json` (the recorded request path), never from the
 * file name, so a renamed capture is still checked against the right schema.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ZodType } from "zod";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { listOf } from "~/api/schemas/_base";

const SPARK_ROOT = fileURLToPath(new URL("../../../../../fixtures/spark/", import.meta.url));

/** Structural view of `./schemas` — declared here so the loose/strict passes share one signature without a static import. */
interface SchemasModule {
  SparkApplicationsSchema: ZodType;
  SparkApplicationSchema: ZodType;
  SparkJobsSchema: ZodType;
  SparkJobSchema: ZodType;
  SparkStagesSchema: ZodType;
  SparkTaskSummarySchema: ZodType;
  SparkTasksSchema: ZodType;
  SparkStageSchema: ZodType;
  SparkExecutorsSchema: ZodType;
  SparkRddsSchema: ZodType;
  SparkRddResponseSchema: ZodType;
  SparkRddSchema: ZodType;
  SparkEnvironmentSchema: ZodType;
  SparkSqlExecutionsSchema: ZodType;
  SparkSqlExecutionSchema: ZodType;
  SparkStreamingStatisticsSchema: ZodType;
  SparkStreamingReceiverSchema: ZodType;
  SparkStreamingBatchSchema: ZodType;
  SparkDagSchema: ZodType;
}

interface ZodIssueLike {
  code?: string;
  path?: PropertyKey[];
  keys?: string[];
  message?: string;
}
interface NamedSchema {
  name: string;
  schema: ZodType;
  /** What entity/array the endpoint returns — for the census header. */
  target: string;
}

/** Map a recorded Spark REST request path (no query) to the schema that models it. `null` = not a Spark payload. */
function schemaFor(s: SchemasModule, path: string): NamedSchema | null {
  const p = path.replace(/^\/api\/v1/, "");
  if (p === "/applications") return { name: "SparkApplicationsSchema", schema: s.SparkApplicationsSchema, target: "applications list" };
  const m = /^\/applications\/[^/]+(\/.*)?$/.exec(p);
  if (!m) return null;
  const rest = m[1] ?? "";
  if (rest === "") return { target: "application", name: "SparkApplicationSchema", schema: s.SparkApplicationSchema };
  if (rest === "/jobs") return { target: "jobs list", name: "SparkJobsSchema", schema: s.SparkJobsSchema };
  if (/^\/jobs\/\d+$/.test(rest)) return { target: "job", name: "SparkJobSchema", schema: s.SparkJobSchema };
  if (rest === "/stages") return { target: "stages list", name: "SparkStagesSchema", schema: s.SparkStagesSchema };
  if (/^\/stages\/\d+\/\d+\/taskSummary$/.test(rest))
    return { target: "task summary", name: "SparkTaskSummarySchema", schema: s.SparkTaskSummarySchema };
  if (/^\/stages\/\d+\/\d+\/taskList$/.test(rest)) return { target: "task list", name: "SparkTasksSchema", schema: s.SparkTasksSchema };
  if (/^\/stages\/\d+$/.test(rest)) return { target: "stage attempts (array)", name: "SparkStagesSchema", schema: s.SparkStagesSchema };
  if (/^\/stages\/\d+\/\d+$/.test(rest)) return { target: "stage attempt", name: "SparkStageSchema", schema: s.SparkStageSchema };
  if (rest === "/executors" || rest === "/allexecutors")
    return { target: "executors list", name: "SparkExecutorsSchema", schema: s.SparkExecutorsSchema };
  if (rest === "/storage/rdd") return { target: "rdds list", name: "SparkRddsSchema", schema: s.SparkRddsSchema };
  // Raw Spark returns the RDD unwrapped; Burrow's backend wraps it as `{rdd}` (SparkRddResponseSchema). Accept both.
  if (/^\/storage\/rdd\/\d+$/.test(rest))
    return { target: "rdd", name: "SparkRddResponseSchema|SparkRddSchema", schema: z.union([s.SparkRddResponseSchema, s.SparkRddSchema]) };
  if (rest === "/environment") return { target: "environment", name: "SparkEnvironmentSchema", schema: s.SparkEnvironmentSchema };
  if (rest === "/sql") return { target: "sql list", name: "SparkSqlExecutionsSchema", schema: s.SparkSqlExecutionsSchema };
  if (/^\/sql\/\d+$/.test(rest)) return { target: "sql execution", name: "SparkSqlExecutionSchema", schema: s.SparkSqlExecutionSchema };
  if (rest === "/streaming/statistics")
    return { target: "streaming statistics", name: "SparkStreamingStatisticsSchema", schema: s.SparkStreamingStatisticsSchema };
  if (rest === "/streaming/receivers")
    return { target: "streaming receivers", name: "listOf(SparkStreamingReceiverSchema)", schema: listOf(s.SparkStreamingReceiverSchema) };
  if (rest === "/streaming/batches")
    return { target: "streaming batches", name: "listOf(SparkStreamingBatchSchema)", schema: listOf(s.SparkStreamingBatchSchema) };
  if (/^\/streaming\/batches\/\d+$/.test(rest))
    return { target: "streaming batch", name: "SparkStreamingBatchSchema", schema: s.SparkStreamingBatchSchema };
  return null;
}

/** Recursive, dependency-free directory walk (the fixture tree is deep and large). */
function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

interface Capture {
  file: string;
  /** Repo-relative path for readable failures. */
  label: string;
}

interface ManifestEntry {
  file: string;
  status: number;
  request: { path: string; query: string };
}

interface RestCapture extends Capture {
  path: string;
  schema: NamedSchema;
}

const manifestCache = new Map<string, Map<string, ManifestEntry>>();

function manifestFor(workloadDir: string): Map<string, ManifestEntry> {
  const cached = manifestCache.get(workloadDir);
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(join(workloadDir, "MANIFEST.json"), "utf8")) as { files: ManifestEntry[] };
  const map = new Map<string, ManifestEntry>();
  for (const entry of raw.files) map.set(entry.file, entry);
  manifestCache.set(workloadDir, map);
  return map;
}

/** First few parse issues, path-qualified so a mismatch points at the offending REST key. */
function digest(error: { issues?: ZodIssueLike[] } | undefined): string {
  return (error?.issues ?? [])
    .slice(0, 4)
    .map((i) => `${i.code ?? "?"} @ ${(i.path ?? []).map(String).join(".") || "<root>"}: ${i.message ?? ""}`)
    .join(" | ");
}

describe("Spark schemas parse every recorded fixture", () => {
  let schemas: SchemasModule;
  const rest: RestCapture[] = [];
  const dags: Capture[] = [];
  const unmapped: string[] = [];
  let nonOk = 0;

  beforeAll(async () => {
    // Dynamic import is required here: resetModules + toggling __BURROW_STRICT_SCHEMAS__ must re-evaluate ~/api/schemas/_base,
    // which a static import would have evaluated once at file load (already strict).
    (globalThis as { __BURROW_STRICT_SCHEMAS__?: boolean }).__BURROW_STRICT_SCHEMAS__ = false;
    vi.resetModules();
    schemas = await import("./schemas");

    if (!existsSync(SPARK_ROOT)) throw new Error(`fixture root not found: ${SPARK_ROOT}`);
    const all = walk(SPARK_ROOT, []);

    for (const file of all) {
      const rel = relative(SPARK_ROOT, file).split(sep).join("/");
      if (/\/rest\/[^/]+\.json$/.test(rel)) {
        const workloadDir = file.slice(0, file.indexOf(`${sep}rest${sep}`));
        const entry = manifestFor(workloadDir).get(`rest/${file.split(/[\\/]/).pop()}`);
        if (entry?.status !== 200) {
          nonOk += 1;
          continue;
        }
        const mapped = schemaFor(schemas, entry.request.path);
        if (!mapped) {
          unmapped.push(entry.request.path);
          continue;
        }
        rest.push({ file, label: rel, path: entry.request.path, schema: mapped });
      } else if (/^dag-[\w.-]+\.json$/.test(file.split(/[\\/]/).pop() ?? "")) {
        dags.push({ file, label: rel });
      }
    }
  });

  it("parses every status-200 REST capture in loose (production) mode", { timeout: 30_000 }, () => {
    const failures: string[] = [];
    for (const cap of rest) {
      const parsed = cap.schema.schema.safeParse(JSON.parse(readFileSync(cap.file, "utf8")));
      if (!parsed.success) failures.push(`${cap.label} [${cap.schema.name}] ${digest(parsed.error as { issues?: ZodIssueLike[] })}`);
    }
    for (const f of failures.slice(0, 20)) console.log(`[schema] FAIL ${f}`);
    if (failures.length > 20) console.log(`[schema] … and ${failures.length - 20} more`);
    expect(failures).toEqual([]);
  });

  it("parses every dag-*.json capture", () => {
    const failures: string[] = [];
    for (const cap of dags) {
      const parsed = schemas.SparkDagSchema.safeParse(JSON.parse(readFileSync(cap.file, "utf8")));
      if (!parsed.success) failures.push(`${cap.label} [SparkDagSchema] ${digest(parsed.error as { issues?: ZodIssueLike[] })}`);
    }
    for (const f of failures.slice(0, 20)) console.log(`[schema] FAIL ${f}`);
    if (failures.length > 20) console.log(`[schema] … and ${failures.length - 20} more`);
    expect(failures).toEqual([]);
  });

  it("covers a meaningful surface and reports counts", () => {
    const endpoints = new Set(rest.map((c) => c.schema.name));
    const workloads = new Set(rest.map((c) => c.label.split("/")[1]));
    console.log(
      `[schema] parsed ${rest.length} REST captures + ${dags.length} dag captures across ${workloads.size} workloads; ` +
        `${endpoints.size} endpoint schemas; skipped ${nonOk} non-200/absent, ${unmapped.length} unmapped`,
    );
    expect(rest.length).toBeGreaterThan(100);
    expect(dags.length).toBeGreaterThan(0);
    expect(endpoints.size).toBeGreaterThanOrEqual(10);
    // Anything captured but unmapped must be a deliberately non-entity endpoint; a Spark entity path here is a bug.
    const NON_ENTITY = [
      /^\/api\/v1$/,
      /^\/api\/v1\/version$/,
      /^\/api\/v1\/applications\/[^/]+\/logs$/,
      /^\/api\/v1\/applications\/[^/]+\/executors\/[^/]+\/threads$/,
      /^\/api\/v1\/applications\/[^/]+\/nonexistent$/,
      // Streaming output-op detail: not exposed by the Streaming page (statistics + batches + receivers only).
      /^\/api\/v1\/applications\/[^/]+\/streaming\/batches\/[^/]+\/operations(\/\d+)?$/,
      /^\/metrics\//,
    ];
    const unexpected = [...new Set(unmapped)].filter((p) => !NON_ENTITY.some((re) => re.test(p)));
    expect(unexpected).toEqual([]);
  });

  it("finds no undeclared key in strict mode across the corpus", { timeout: 30_000 }, async () => {
    // Same resetModules boundary as the loose pass; needed to flip the strict flag the schemas were built with.
    (globalThis as { __BURROW_STRICT_SCHEMAS__?: boolean }).__BURROW_STRICT_SCHEMAS__ = true;
    vi.resetModules();
    const strict: SchemasModule = await import("./schemas");
    const census = new Map<string, Set<string>>();
    let strictParsed = 0;
    for (const cap of rest) {
      const strictSchema = schemaFor(strict, cap.path);
      if (!strictSchema || strictSchema.name !== cap.schema.name) continue; // union helper name differs; skip
      const parsed = strictSchema.schema.safeParse(JSON.parse(readFileSync(cap.file, "utf8")));
      strictParsed += 1;
      if (parsed.success) continue;
      const issues = (parsed.error?.issues ?? undefined) as ZodIssueLike[] | undefined;
      for (const issue of issues ?? []) {
        if (issue.code !== "unrecognized_keys" || !issue.keys?.length) continue;
        const set = census.get(cap.schema.name) ?? new Set<string>();
        for (const key of issue.keys) set.add(key);
        census.set(cap.schema.name, set);
      }
    }
    const totalKeys = [...census.values()].reduce((n, s) => n + s.size, 0);
    console.log(`[schema] strict census: ${census.size} endpoints with unknown keys, ${totalKeys} distinct keys (informational)`);
    for (const [name, keys] of [...census.entries()].sort()) {
      console.log(`[schema]   ${name}: ${[...keys].sort().join(", ")}`);
    }
    // The census is a hard gate in miniature: every key Spark emitted across the captured corpus is declared in the
    // schema, so a new Spark version that adds a key fails here (and is then added deliberately).
    expect(strictParsed).toBeGreaterThan(100);
    expect(totalKeys).toBe(0);
  });
});
