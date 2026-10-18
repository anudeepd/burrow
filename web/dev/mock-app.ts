/**
 * Dev mock for the YARN application-detail domain (FE-AppDetail slice).
 *
 * Replays REAL ResourceManager payloads captured from the live 3.4.3 cluster into `fixtures/rm/app/<scenario>/`
 * (see `fixtures/rm/app/capture.py` for the exact capture run). Nothing is synthesised: the bodies are byte-for-byte
 * what `http://127.0.0.1:8088/ws/v1/cluster/...` returned, including Jersey's "mapped" notation
 * (`"allocatedMB": "768"`, `{"allocatedResources":{"entry":[…]}}`) and JAXB's omission of empty collections.
 *
 * Scenario selection is by application id — the app id IS the state, so no cookie/param plumbing is needed:
 *   application_1791010984040_0001  → running        (live app, containers, preemption metrics)
 *   application_1791010984040_0004  → multi-attempt  (FAILED after 3 attempts, per-attempt containers captured)
 *   application_1791010984040_0002  → finished       (SUCCEEDED; the RM has already dropped its containers)
 *
 * Any other application id falls through (`return null`) to the generic mock router, so the synthetic cluster served by
 * `dev/mock-data/rm.ts` keeps working for the applications list.
 *
 * Claims (never the bare `yarn/apps` list, never `spark/*` — those belong to other slices):
 *   yarn/apps/<id> · …/appattempts · …/appattempts/<at>/containers[/<cid>] · …/{state,priority,queue,timeouts}
 *   yarn/scheduler/app-activities/<id>
 */
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import { errorResponse, jsonResponse } from "./mock-data/instance.ts";

const FIXTURE_ROOT = new URL("../../fixtures/rm/app/", import.meta.url);

interface Scenario {
  name: string;
  dir: URL;
  files: Set<string>;
}

const scenarios = new Map<string, Scenario>();

async function readJson(url: URL): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(fileURLToPath(url), "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Index `fixtures/rm/app/<scenario>/` once: app id -> scenario + the file names it holds. */
async function loadScenarios(): Promise<void> {
  if (scenarios.size > 0) return;
  const root = fileURLToPath(FIXTURE_ROOT);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = new URL(`${entry.name}/`, FIXTURE_ROOT);
    const app = (await readJson(new URL("app.json", dir))) as { app?: { id?: string } } | undefined;
    const id = app?.app?.id;
    if (!id) continue;
    const files = new Set(await readdir(fileURLToPath(dir)));
    scenarios.set(id, { name: entry.name, dir, files });
  }
}

async function fixture(scenario: Scenario, file: string): Promise<unknown | undefined> {
  if (!scenario.files.has(file)) return undefined;
  return await readJson(new URL(file, scenario.dir));
}

// eslint/tsc: `url` must stay in the signature — dev/mock-api.ts calls every handle* with (req, path, url).
export async function handleApp(req: Request, path: string, _url: URL): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;

  const appActivities = /^yarn\/scheduler\/app-activities\/([^/]+)$/.exec(path);
  if (appActivities) {
    await loadScenarios();
    const scenario = scenarios.get(decodeURIComponent(appActivities[1]!));
    if (!scenario) return null;
    const body = await fixture(scenario, "scheduler-app-activities.json");
    if (body === undefined) {
      return errorResponse("not_found", `no app activities captured for ${appActivities[1]}`, 404, {
        hint: "RM 3.4.3 answers `fail to get application activities after finished` for a terminal application",
      });
    }
    return jsonResponse(body, {}, req);
  }

  const m = /^yarn\/apps\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return null;
  const appId = decodeURIComponent(m[1]!);
  const rest = m[2] ?? "";

  await loadScenarios();
  const scenario = scenarios.get(appId);
  if (!scenario) return null; // unknown app -> generic mock router (synthetic cluster)

  if (rest === "" || rest === "/") return jsonResponse(await fixture(scenario, "app.json"), {}, req);

  if (rest === "/appattempts") return jsonResponse(await fixture(scenario, "appattempts.json"), {}, req);

  const attemptDetail = /^\/appattempts\/([^/]+)$/.exec(rest);
  if (attemptDetail) {
    const attemptId = decodeURIComponent(attemptDetail[1]!);
    const attempts = (await fixture(scenario, "appattempts.json")) as
      | { appAttempts?: { appAttempt?: Array<Record<string, unknown>> } }
      | undefined;
    const attempt = attempts?.appAttempts?.appAttempt?.find((row) => row.appAttemptId === attemptId);
    if (!attempt) return errorResponse("not_found", `Application attempt '${attemptId}' does not exist.`, 404);
    // The captured list carries the ID, state, AM container, and timestamps; preserve only those facts instead of
    // inventing the attempt-only host diagnostics the real single-attempt endpoint may return.
    return jsonResponse(
      {
        appAttemptId: attempt.appAttemptId,
        appAttemptState: attempt.appAttemptState,
        amContainerId: attempt.containerId,
        startedTime: attempt.startTime,
        finishedTime: attempt.finishedTime,
      },
      {},
      req,
    );
  }

  const containers = /^\/appattempts\/([^/]+)\/containers$/.exec(rest);
  if (containers) {
    // The RM answers `{}` once it has dropped the attempt's containers; replay exactly that.
    const body = await fixture(scenario, `containers-${decodeURIComponent(containers[1]!)}.json`);
    return jsonResponse(body ?? {}, {}, req);
  }

  const container = /^\/appattempts\/([^/]+)\/containers\/([^/]+)$/.exec(rest);
  if (container) {
    const at = decodeURIComponent(container[1]!);
    const cid = decodeURIComponent(container[2]!);
    const body = await fixture(scenario, `container-${at}-${cid}.json`);
    if (body === undefined) {
      return errorResponse("not_found", `Container with id '${cid}' doesn't exist in RM.`, 404, {
        hint: "The RM drops container records when the attempt finishes (captured: fixtures/rm/app/finished)",
      });
    }
    return jsonResponse(body, {}, req);
  }

  const scalar = /^\/(state|priority|queue|timeouts)$/.exec(rest);
  if (scalar) {
    const body = await fixture(scenario, `${scalar[1]}.json`);
    return body === undefined ? null : jsonResponse(body, {}, req);
  }

  if (rest === "/statistics" || rest === "/appactivities") {
    // Evidence: both 404 on Hadoop 3.4.3 (CONTRACT CHANGE REQUEST in the slice report); the app-scoped activities the
    // attempt page used live at yarn/scheduler/app-activities/{id}.
    return errorResponse("not_found", `RM 3.4.3 does not serve /ws/v1/cluster/apps/{id}${rest}`, 404, {
      upstream: { url: `http://rm/ws/v1/cluster/apps/${appId}${rest}`, status: 404 },
      hint: "Use /api/yarn/scheduler/app-activities/{appId} for scheduler activities",
    });
  }

  return null;
}
