/**
 * Dev-mock extension for the Scheduler slice (loaded by `dev/mock-api.ts` before the generated router).
 *
 * Sources are REAL captures in `fixtures/rm/scheduler/`:
 *   capacity/ — the running cluster's capacity scheduler, its activities, conf and QueueMetrics JMX bean;
 *   fair/, fifo/ — captured from throwaway ResourceManagers started with those scheduler classes (the shared test cluster
 *   is Capacity-scheduled and must not be cycled).
 *
 * `GET /api/yarn/scheduler` uses the Overview fixture by default. Set `BURROW_MOCK_SCHEDULER=fair|fifo` to serve a captured
 * payload of that type instead — the Playwright spec does not rely on this; it fulfils the fixture directly so one server
 * can render all three types.
 */
import { jsonResponse } from "./mock-data/instance.ts";

const FIXTURE = (rel: string) => new URL(`../../fixtures/rm/scheduler/${rel}`, import.meta.url);

const JMX_QUEUE_METRICS = "Hadoop:service=ResourceManager,name=QueueMetrics,q0=root";

async function fixture(rel: string): Promise<unknown> {
  return Bun.file(FIXTURE(rel)).json();
}

export async function handleScheduler(req: Request, path: string, url: URL): Promise<Response | null> {
  if (path === "yarn/scheduler") {
    const which = process.env.BURROW_MOCK_SCHEDULER;
    if (which === "fair" || which === "fifo") return jsonResponse(await fixture(`${which}/scheduler.json`), {}, req);
    return null; // capacity: the Overview fixture handles it by default.
  }
  if (path === "yarn/scheduler/activities") {
    // the captured activity snapshot is for the mock cluster's own node (127.0.0.2:8041), so it lines up with mock nodes
    return jsonResponse(await fixture("capacity/scheduler-activities.json"), {}, req);
  }
  if (path === "yarn/scheduler-conf") {
    return jsonResponse(await fixture("capacity/scheduler-conf.json"), {}, req);
  }
  if (path === "rm/jmx" && url.searchParams.get("qry") === JMX_QUEUE_METRICS) {
    return jsonResponse(await fixture("capacity/jmx-queuemetrics-root.json"), {}, req);
  }
  return null;
}
