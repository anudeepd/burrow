/**
 * Mock payloads the RM DAO builders in `rm.ts` / `scheduler.ts` do not cover: application activities, the resource-type
 * registry and resource profiles. Shapes follow src/api/schemas/app-misc.ts (which documents which of these paths real
 * Hadoop 3.4.3 actually serves — `/resource-types` and `/resource-profiles` are NOT served upstream, so the response is
 * an explicit assumption of the contract, not a replay of captured bytes).
 */
import type { MockCluster } from "./cluster.ts";
import { RmError } from "./rm.ts";
import { LONG_MAX } from "./util.ts";

const notFound = (msg: string) =>
  new RmError(404, {
    RemoteException: {
      exception: "NotFoundException",
      message: `java.lang.Exception: ${msg}`,
      javaClassName: "org.apache.hadoop.yarn.webapp.NotFoundException",
    },
  });

/** `GET /apps/{id}/appactivities` — `{appActivities:{applicationId, diagnostic, timestamp, dateTime, allocations:[…]}}`. */
export function APP_ACTIVITIES(c: MockCluster, id: string) {
  const a = c.getApp(id);
  if (!a) throw notFound(`app with id: ${id} not found`);
  const pending = a.state === "NEW" || a.state === "NEW_SAVING" || a.state === "SUBMITTED" || a.state === "ACCEPTED";
  const attempt = a.attempts.at(-1);
  const node = attempt && attempt.nodeIdx >= 0 ? c.nodes[attempt.nodeIdx] : undefined;
  return {
    appActivities: {
      applicationId: a.id,
      diagnostic: pending ? "waiting for AM container to be allocated" : "allocated container",
      timestamp: c.now,
      dateTime: new Date(c.now).toISOString(),
      allocations: [
        {
          nodeId: pending ? "" : (node?.host ?? ""),
          timestamp: c.now,
          dateTime: new Date(c.now).toISOString(),
          queueName: a.queue,
          appPriority: a.priority,
          allocationState: pending ? "PENDING" : "ALLOCATED",
          diagnostic: pending ? "waiting for available resources" : "assigned to node",
          children: [
            {
              requestPriority: a.priority,
              allocationRequestId: 0,
              allocationState: pending ? "PENDING" : "ALLOCATED",
              diagnostic: `Request for ${a.planContainers} container(s) of ${a.cmb} MB`,
            },
          ],
        },
      ],
    },
  };
}

/** `yarn-api` resource-type registry, as configured in yarn-site.xml (`memory-mb`, `vcores`, `yarn.io/gpu`). */
export function resourceTypesResponse() {
  return {
    resourceInformation: [
      {
        name: "memory-mb",
        resourceType: "COUNTABLE",
        units: "Mi",
        value: 1,
        minimumAllocation: 1024,
        maximumAllocation: LONG_MAX,
        tags: [],
      },
      { name: "vcores", resourceType: "COUNTABLE", units: "", value: 1, minimumAllocation: 1, maximumAllocation: 512, tags: [] },
      { name: "yarn.io/gpu", resourceType: "COUNTABLE", units: "", value: 1, minimumAllocation: 1, maximumAllocation: 4, tags: [] },
    ],
  };
}

/** `GET /resource-profiles` — named resource presets. */
export function resourceProfilesResponse() {
  return {
    profiles: {
      minimum: { "memory-mb": 1024, vcores: 1 },
      default: { "memory-mb": 2048, vcores: 2 },
      highmem: { "memory-mb": 16384, vcores: 4 },
      gpu: { "memory-mb": 8192, vcores: 4, "yarn.io/gpu": 1 },
    },
  };
}
