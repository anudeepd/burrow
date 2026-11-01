import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { vi } from "vitest";
import { routeTree } from "../routeTree.gen";
export { queryClient } from "../routes/__root";

export const APP_ID = "application_1791010984040_0001";
export const ATTEMPT_ID = "appattempt_1791010984040_0001_000001";
export const CONTAINER_ID = "container_1791010984040_0001_01_000001";

const FIXTURES = resolve(process.cwd(), "../fixtures/rm");
const SPARK_FIXTURES = resolve(process.cwd(), "../fixtures/spark/3.5.9/dstream/rest");
export const readRm = (path: string) => JSON.parse(readFileSync(resolve(FIXTURES, path), "utf8")) as unknown;
export const readSpark = (path: string) => JSON.parse(readFileSync(resolve(SPARK_FIXTURES, path), "utf8")) as unknown;
const runningApp = readRm("app/running/app.json") as { app: Record<string, unknown> };

export function serveFixtures(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    "/api/meta": {
      name: "Burrow",
      version: "0.1.0",
      now: 1_791_011_000_000,
      readOnly: true,
      rm: { urls: ["http://rm:8088"], active: "http://rm:8088", haState: "ACTIVE", hadoopVersion: "3.5.9", reachable: true },
      services: {
        sparkHistory: { configured: true, url: "http://history:18080", reachable: true },
        jobHistory: { configured: false, url: null, reachable: null },
        timeline: { configured: false, url: null, reachable: null },
      },
      features: { sparkLive: true, sparkHistory: true, aggregatedLogs: true, nodeLogs: true, events: true, kerberos: false },
      yarn: { logServerUrl: null, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
    },
    "/api/yarn/info": readRm("overview/info.json"),
    "/api/yarn/metrics": readRm("overview/metrics.json"),
    "/api/yarn/apps": readRm("app/running/apps.json"),
    "/api/yarn/scheduler": readRm("overview/scheduler.json"),
    "/api/yarn/scheduler-overview": readRm("overview/scheduler-overview.json"),
    "/api/rm/conf": {
      properties: [{ key: "yarn.resourcemanager.webapp.address", value: "127.0.0.1:8088", isFinal: false, resource: "yarn-site.xml" }],
    },
    "/api/rm/jmx": {
      beans: [
        {
          name: "java.lang:type=Memory",
          modelerType: "Memory",
          HeapMemoryUsage: { init: 1_048_576, used: 524_288, committed: 1_048_576, max: 2_097_152 },
          Flags: [true, false],
          StartedAtMillis: 1_791_015_558_000,
        },
      ],
    },
    "/api/rm/logs": readRm("tools/logs.json"),
    "/api/yarn/get-node-labels": readRm("nodes/get-node-labels.json"),
    "/api/yarn/get-node-to-labels": readRm("nodes/get-node-to-labels.json"),
    "/api/yarn/label-mappings": readRm("nodes/label-mappings.json"),
    [`/api/spark/${APP_ID}/source`]: {
      mode: "history",
      baseUrl: "http://history:18080",
      sparkAppId: APP_ID,
      attempt: null,
      available: true,
      reason: null,
      hint: null,
    },
    [`/api/spark/${APP_ID}/application`]: readSpark("final.application.json"),
    [`/api/spark/${APP_ID}/environment`]: readSpark("final.environment.json"),
    [`/api/spark/${APP_ID}/executors`]: readSpark("final.executors.json"),
    [`/api/spark/${APP_ID}/allexecutors`]: readSpark("final.allexecutors.json"),
    [`/api/spark/${APP_ID}/jobs`]: readSpark("final.jobs.json"),
    [`/api/spark/${APP_ID}/jobs/0`]: readSpark("final.job-0.json"),
    [`/api/spark/${APP_ID}/stages`]: readSpark("final.stages.status-complete.json"),
    [`/api/spark/${APP_ID}/stages/0`]: readSpark("final.stage-0.json"),
    [`/api/spark/${APP_ID}/stages/0/0`]: readSpark("final.stage-0-0.withSummaries.json"),
    [`/api/spark/${APP_ID}/stages/0/0/taskSummary`]: readSpark("final.stage-0-0.taskSummary.json"),
    [`/api/spark/${APP_ID}/stages/0/0/taskList`]: readSpark("final.stage-0-0.taskList.json"),
    [`/api/spark/${APP_ID}/sql`]: readSpark("final.sql.json"),
    [`/api/spark/${APP_ID}/sql/0`]: {
      id: 0,
      status: "COMPLETED",
      description: "Read fixture rows",
      submissionTime: "2026-10-03T07:13:47.313GMT",
      completionTime: "2026-10-03T07:13:48.313GMT",
      duration: 1000,
      queryId: "query-0",
      rootExecutionId: 0,
      planDescription: "Root\n+- Scan fixture",
      nodes: [],
      edges: [],
      runningJobIds: [],
      successJobIds: [],
      failedJobIds: [],
      errorMessage: null,
    },
    [`/api/spark/${APP_ID}/storage/rdd`]: readSpark("final.storage.rdd.json"),
    [`/api/spark/${APP_ID}/storage/rdd/52`]: readSpark("final.storage.rdd-52.json"),
    [`/api/spark/${APP_ID}/streaming/batches`]: readSpark("final.streaming.batches.json"),
    [`/api/spark/${APP_ID}/streaming/receivers`]: readSpark("final.streaming.receivers.json"),
    [`/api/spark/${APP_ID}/streaming/statistics`]: readSpark("final.streaming.statistics.json"),
    [`/api/yarn/apps/${APP_ID}`]: {
      app: {
        ...runningApp.app,
        resourceRequests: [
          {
            priority: 1,
            allocationRequestId: 7,
            resourceName: "*",
            capability: { memory: 1024, vCores: 1 },
            numContainers: 2,
            relaxLocality: true,
            nodeLabelExpression: "",
            executionTypeRequest: { executionType: "GUARANTEED", enforceExecutionType: true },
            placementConstraint: "allocation-tag=analytics",
            allocationTags: ["analytics"],
          },
        ],
      },
    },
    [`/api/yarn/apps/${APP_ID}/appattempts`]: readRm("app/running/appattempts.json"),
    [`/api/yarn/apps/${APP_ID}/appattempts/${ATTEMPT_ID}`]: {
      appAttemptId: ATTEMPT_ID,
      host: "127.0.0.4",
      rpcPort: 43981,
      trackingUrl: `http://rm:8088/proxy/${APP_ID}/`,
      originalTrackingUrl: "http://127.0.0.4:43981",
      diagnosticsInfo: "Attempt is running",
      appAttemptState: "RUNNING",
      amContainerId: CONTAINER_ID,
      startedTime: 1_791_010_998_466,
      finishedTime: 0,
    },
    [`/api/yarn/apps/${APP_ID}/appattempts/${ATTEMPT_ID}/containers`]: readRm(
      "app/running/containers-appattempt_1791010984040_0001_000001.json",
    ),
    [`/api/yarn/apps/${APP_ID}/appattempts/${ATTEMPT_ID}/containers/${CONTAINER_ID}`]: readRm(
      `app/running/container-${ATTEMPT_ID}-${CONTAINER_ID}.json`,
    ),
    "/api/yarn/nodes": readRm("nodes/nodes.json"),
    "/api/yarn/nodes/127.0.0.2:8041": readRm("nodes/node-127.0.0.2_8041.json"),
    ...overrides,
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      const fixturePath = url.pathname
        .replace(/application_\d+_\d+/g, APP_ID)
        .replace(/appattempt_\d+_\d+_\d+/g, ATTEMPT_ID)
        .replace(/container_\d+_\d+_\d+_\d+/g, CONTAINER_ID);
      const configuredBody = responses[url.pathname] ?? responses[fixturePath];
      const body = typeof configuredBody === "function" ? await (configuredBody as () => Promise<unknown>)() : configuredBody;
      if (body instanceof Response) return body;
      return new Response(
        body === undefined ? JSON.stringify({ error: { message: `No fixture for ${url.pathname}` } }) : JSON.stringify(body),
        {
          status: body === undefined ? 404 : 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }),
  );
}

export function routerAt(path: string) {
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
}

export { RouterProvider };
