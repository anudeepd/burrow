/**
 * Test-only helpers for the DAG corpus. **Node-only** (`.node.ts`): it reads goldens from disk, so nothing in the
 * application may import it. Vitest picks up the specs that use it; the app bundle never sees it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dag, DagInput } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
export const SPARK_FIXTURES = join(REPO_ROOT, "fixtures", "spark");

export interface Golden {
  version: string;
  workload: string;
  file: string;
  path: string;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
  } catch {
    return [];
  }
}

export function sparkVersions(): string[] {
  return listDirs(SPARK_FIXTURES).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
}

/** Every `dag-*.json` golden for one Spark version, sorted so failures are reproducible. */
export function goldensFor(version: string): Golden[] {
  const out: Golden[] = [];
  const base = join(SPARK_FIXTURES, version);
  for (const workload of listDirs(base)) {
    const dir = join(base, workload);
    for (const file of readdirSync(dir)
      .filter((f) => f.startsWith("dag-") && f.endsWith(".json"))
      .sort()) {
      out.push({ version, workload, file, path: join(dir, file) });
    }
  }
  return out;
}

export function allGoldens(): Golden[] {
  const out: Golden[] = [];
  for (const version of sparkVersions()) out.push(...goldensFor(version));
  return out;
}

export function readGolden(golden: Golden): Dag {
  return JSON.parse(readFileSync(golden.path, "utf8")) as Dag;
}

/** Captured SQL plan executions (`rest/final.sql-<id>.json`) — REST-native, so no goldens exist for these. */
export function sqlPlans(version: string): { workload: string; file: string; path: string }[] {
  const out: { workload: string; file: string; path: string }[] = [];
  const base = join(SPARK_FIXTURES, version);
  for (const workload of listDirs(base)) {
    const restDir = join(base, workload, "rest");
    let files: string[] = [];
    try {
      files = readdirSync(restDir);
    } catch {
      continue;
    }
    for (const file of files.filter((f) => /^final\.sql-\d+\.json$/.test(f)).sort()) {
      out.push({ workload, file: `rest/${file}`, path: join(restDir, file) });
    }
  }
  return out;
}

export function readSqlPlan(path: string): DagInput {
  return JSON.parse(readFileSync(path, "utf8")) as DagInput;
}

export function readCapturedStages(version: string, workload: string): unknown {
  const path = join(SPARK_FIXTURES, version, workload, "rest", "final.stages.details.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Rectangle-overlap check used by the "no overlapping nodes" assertion. */
export function overlappingPairs(
  boxes: { id: string; x: number; y: number; width: number; height: number }[],
  tolerance = 0.01,
): [string, string][] {
  const bad: [string, string][] = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j]!;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapX > tolerance && overlapY > tolerance) bad.push([a.id, b.id]);
    }
  }
  return bad;
}
