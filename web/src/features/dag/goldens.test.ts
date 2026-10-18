// @vitest-environment node
/**
 * The corpus gate: **every** captured golden (Spark 3.5.9 and 4.2.0, 732 files) must adapt and lay out without errors
 * and without overlapping nodes. This is the programmatic form of acceptance criterion #1.
 *
 * Layout is the expensive part (~10-60 ms per graph, all of it synchronous), so the corpus is split across three specs
 * that can run in parallel within the file.
 */
import { describe, expect, it } from "vitest";
import { buildGraph } from "./dag-model";
import { layoutGraphSync } from "./layout";
import type { RenderGraph } from "./types";
import { allGoldens, goldensFor, overlappingPairs, readGolden, sparkVersions } from "./testing/fixtures.node";

interface Failure {
  where: string;
  what: string;
}

/** Adapt + lay out one golden and report every problem instead of throwing on the first. */
async function check(golden: { version: string; workload: string; file: string; path: string }): Promise<Failure[]> {
  const where = `${golden.version}/${golden.workload}/${golden.file}`;
  const failures: Failure[] = [];
  let graph: RenderGraph;
  try {
    graph = buildGraph(readGolden(golden));
  } catch (err) {
    return [{ where, what: `buildGraph threw: ${err instanceof Error ? err.message : String(err)}` }];
  }
  if (graph.nodes.length === 0) failures.push({ where, what: "adapted to zero nodes" });
  if (graph.nodes.some((n) => !graph.sizes.get(n.id))) failures.push({ where, what: "a node has no size" });
  for (const e of graph.edges) {
    if (!graph.nodes.some((n) => n.id === e.from) || !graph.nodes.some((n) => n.id === e.to)) {
      failures.push({ where, what: `edge ${e.id} references a node outside the graph` });
    }
  }
  if (graph.clusters.some((c) => c.parentId && !graph.clusters.some((p) => p.id === c.parentId))) {
    failures.push({ where, what: "a cluster references a missing parent" });
  }
  if (graph.warnings.length > 0) {
    // Warnings are allowed only for genuinely broken payloads; the goldens are verified, so any hit is a real signal.
    failures.push({ where, what: `unexpected warnings: ${graph.warnings.join(" | ")}` });
  }

  const layout = await layoutGraphSync(graph);
  for (const node of graph.nodes) {
    const box = layout.nodes.get(node.id);
    if (!box) {
      failures.push({ where, what: `no layout box for ${node.id}` });
      continue;
    }
    const size = graph.sizes.get(node.id)!;
    if (Math.abs(box.width - size.width) > 0.51 || Math.abs(box.height - size.height) > 0.51) {
      failures.push({ where, what: `${node.id} box ${box.width}x${box.height} ≠ requested ${size.width}x${size.height}` });
    }
  }
  if (layout.width <= 0 || layout.height <= 0) failures.push({ where, what: "empty layout bounds" });
  const boxes = graph.nodes
    .map((n) => {
      const b = layout.nodes.get(n.id);
      return b ? { id: n.id, ...b } : null;
    })
    .filter((b): b is { id: string; x: number; y: number; width: number; height: number } => b !== null);
  const overlaps = overlappingPairs(boxes);
  if (overlaps.length > 0) {
    failures.push({ where, what: `${overlaps.length} overlapping node pair(s), e.g. ${overlaps[0]!.join(" × ")}` });
  }
  return failures;
}

async function checkAll(goldens: ReturnType<typeof goldensFor>): Promise<void> {
  const failures: Failure[] = [];
  for (const golden of goldens) failures.push(...(await check(golden)));
  if (failures.length > 0) {
    const head = failures
      .slice(0, 25)
      .map((f) => `  ${f.where}: ${f.what}`)
      .join("\n");
    throw new Error(`${failures.length} failure(s) across ${goldens.length} goldens:\n${head}`);
  }
}

describe("DAG corpus", () => {
  it("finds both goldens sets", () => {
    const versions = sparkVersions();
    expect(versions).toEqual(expect.arrayContaining(["3.5.9", "4.2.0"]));
    expect(allGoldens().length).toBeGreaterThan(700);
  });

  for (const version of ["4.2.0", "3.5.9"]) {
    const goldens = goldensFor(version);
    // Chunked so each spec stays well under the timing budget and failures name a small range.
    const chunks: (typeof goldens)[] = [];
    const size = Math.ceil(goldens.length / 4);
    for (let i = 0; i < goldens.length; i += size) chunks.push(goldens.slice(i, i + size));
    for (const [index, chunk] of chunks.entries()) {
      it(`${version} renders and lays out goldens ${index + 1}/${chunks.length} (${chunk.length} files)`, {
        timeout: 240_000,
      }, async () => {
        await checkAll(chunk);
      });
    }
  }
});
