/** Replays DAG captures through the real Spark routes, so browser tests cover the production embedding too. */
import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { syntheticDag } from "../../src/features/dag/simulate";
import type { Dag } from "../../src/features/dag/types";

const APP = "application_1791010000001_0001";
const API = `**/api/spark/${APP}/**`;
const read = <T>(path: string): T => JSON.parse(readFileSync(`../fixtures/spark/${path}`, "utf8")) as T;

export async function gotoFixture(
  page: Page,
  query: string,
  metrics = "captured",
  options: { expandGraph?: boolean; stageList?: boolean; pollingOnly?: boolean } = {},
) {
  const params = new URLSearchParams(query);
  const synthetic = params.get("kind")?.startsWith("synthetic") ?? false;
  const sql = params.get("kind") === "sql";
  const version = params.get("v") ?? "4.2.0";
  const workload = params.get("w") ?? "big-dag";
  const file = params.get("f") ?? "dag-job-2.json";
  const dag = synthetic
    ? { ...syntheticDag({ stages: 1, nodesPerStage: params.get("kind") === "synthetic600" ? 480 : 270 }), kind: "stage" as const }
    : sql
      ? null
      : read<Dag>(`${version}/${workload}/${file}`);
  const execution = sql ? read<Record<string, unknown>>(`${version}/${workload}/${file}`) : null;
  const captured = synthetic || sql ? [] : read<Record<string, unknown>[]>(`${version}/${workload}/rest/final.stages.details.json`);
  const stageIds = dag?.stages.map((stage) => stage.stageId) ?? [];
  const jobId = dag?.jobId ?? 0;
  const stageId = dag?.stages[0]?.stageId ?? 0;
  const attemptId = dag?.stages[0]?.attempt ?? 0;
  const stageRoute = !synthetic && dag?.kind === "stage";
  let progressReads = 0;
  let releaseDelayedMetrics: (() => void) | undefined;
  const delayedMetrics =
    synthetic && metrics === "delayed"
      ? new Promise<void>((resolve) => {
          releaseDelayedMetrics = resolve;
        })
      : undefined;

  await page.unroute(API);
  await page.addInitScript(
    ({ live, pollingOnly }) => {
      if (pollingOnly) Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
      const key = "burrow.prefs.v1";
      const prefs = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...prefs, livePaused: !live, liveIntervalMs: 1000, tz: "utc" }));
    },
    { live: synthetic, pollingOnly: options.pollingOnly ?? false },
  );
  await page.route(API, async (route) => {
    const rest = new URL(route.request().url()).pathname.split(`/api/spark/${APP}/`)[1] ?? "";
    let json: unknown;
    if (rest.startsWith("dag/")) json = dag;
    else if (rest === `sql/${execution?.id}`) json = execution;
    else if (rest === "source" && synthetic)
      json = { mode: "live-proxy", available: true, sparkAppId: APP, reason: "Synthetic E2E progress fixture" };
    else if (rest === `jobs/${jobId}`)
      json = {
        jobId,
        name: "Captured DAG browser check",
        status: synthetic || metrics === "running" ? "RUNNING" : "SUCCEEDED",
        stageIds,
        jobTags: [],
      };
    else if (rest === "stages" || rest === `stages/${stageId}/${attemptId}`) {
      progressReads++;
      if (delayedMetrics) await delayedMetrics;
      const stages = synthetic
        ? [
            {
              stageId: 0,
              attemptId: 0,
              status: "ACTIVE",
              name: "Synthetic stage",
              numTasks: 100,
              numActiveTasks: 4,
              numCompleteTasks: 10 + (progressReads % 50),
              numFailedTasks: 0,
              shuffleReadBytes: 1000000 + progressReads * 10000,
              shuffleWriteBytes: 2000000 + progressReads * 10000,
              submissionTime: "2026-10-03T06:49:08.233GMT",
            },
          ]
        : metrics === "running"
          ? captured.map((stage) =>
              stage.stageId === dag?.stages[dag.stages.length - 1]?.stageId ? { ...stage, status: "ACTIVE", numActiveTasks: 1 } : stage,
            )
          : captured;
      json = rest === "stages" ? stages : (stages.find((stage) => stage.stageId === stageId && stage.attemptId === attemptId) ?? stages[0]);
    } else {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json,
      headers: { "x-burrow-api": "1", "x-burrow-cache": "bypass" },
    });
  });
  const route = sql ? `sql/${execution?.id}` : stageRoute ? `stages/${stageId}/${attemptId}` : `jobs/${jobId}`;
  await page.goto(`/apps/${APP}/spark/${route}${options.expandGraph ? "?expand=1" : ""}`);
  const fixture = { progressReads: () => progressReads, metrics, releaseMetrics: () => releaseDelayedMetrics?.() };
  if (options.stageList) {
    const stageList = page.getByTestId("mobile-dag-stage-summary");
    await expect(stageList).toBeVisible();
    await stageList.scrollIntoViewIfNeeded();
    return fixture;
  }
  const canvas = page.getByTestId("dag-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-dag-layout", "ready", { timeout: 20_000 });
  // The loading panel stays mounted to fade out when layout completes; no state panel should obscure the graph.
  await expect(canvas.locator('[data-testid="dag-state"]:visible')).toHaveCount(0);
  await expect.poll(() => canvas.locator("[role='treeitem']").count()).toBeGreaterThan(0);
  await canvas.scrollIntoViewIfNeeded();
  return fixture;
}
