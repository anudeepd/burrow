/**
 * Dev-mock handlers for the Nodes / Node-labels domain (FE-NodesTools slice).
 *
 * Wired by `dev/mock-api.ts` (WebFoundation2): each slice exports a `handle<Name>(req)` returning a `Response` when it owns the
 * path, or `null` to fall through. Paths arrive with `/api/` stripped, e.g. `yarn/nodes?states=RUNNING`.
 *
 * NodeManager payloads and captured detail IDs use fixtures under `fixtures/rm/nodes/**`; node lists, labels, and generated
 * detail IDs use the shared cluster so catalogue, membership, and navigation agree with `/yarn/nodes`.
 */
import containers2Fixture from "../../fixtures/rm/nodes/nm-127.0.0.2_8042-containers.json";
import containers3Fixture from "../../fixtures/rm/nodes/nm-127.0.0.3_8042-containers.json";
import containers4Fixture from "../../fixtures/rm/nodes/nm-127.0.0.4_8042-containers.json";
import appsFixture from "../../fixtures/rm/nodes/nm-127.0.0.2_8042-apps.json";
import confFixture from "../../fixtures/rm/nodes/nm-127.0.0.2_8042-conf.json";
import infoFixture from "../../fixtures/rm/nodes/nm-127.0.0.2_8042-info.json";
import jmxFixture from "../../fixtures/rm/nodes/nm-127.0.0.2_8042-jmx.json";
import nodeA from "../../fixtures/rm/nodes/node-127.0.0.2_8041.json";
import nodeB from "../../fixtures/rm/nodes/node-127.0.0.3_8041.json";
import nodeC from "../../fixtures/rm/nodes/node-127.0.0.4_8041.json";
import { NodeResponseSchema } from "../src/api/schemas";
import { type NmContainers, NmAppsResponseSchema, NmContainersResponseSchema, NmInfoResponseSchema } from "../src/api/queries/nodes";
import { getCluster } from "./mock-data/instance.ts";
import { labelMappingsResponse, nodeIdOf, nodeLabelsResponse, nodeResponse, nodeToLabelsResponse } from "./mock-data/rm.ts";

const RM_JSON = { "content-type": "application/json; charset=utf-8", "x-burrow-api": "1", "x-burrow-cache": "hit" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: RM_JSON });

const notFound = (message: string) =>
  json(
    {
      RemoteException: {
        exception: "NotFoundException",
        javaClassName: "org.apache.hadoop.yarn.webapp.NotFoundException",
        message: `java.lang.Exception: ${message}`,
      },
    },
    404,
  );

const SINGLE_NODES = new Map(
  [nodeA, nodeB, nodeC].map((raw) => {
    const node = NodeResponseSchema.parse(raw).node;
    return [node.id, node] as const;
  }),
);

const NM_INFO = NmInfoResponseSchema.parse(infoFixture);
const NM_APPS = NmAppsResponseSchema.parse(appsFixture);
// one captured container list per node (the live cluster runs a seeded workload, so .3/.4 carry RUNNING containers)
const NM_CONTAINERS: Record<string, NmContainers> = {
  "127.0.0.2:8042": NmContainersResponseSchema.parse(containers2Fixture),
  "127.0.0.3:8042": NmContainersResponseSchema.parse(containers3Fixture),
  "127.0.0.4:8042": NmContainersResponseSchema.parse(containers4Fixture),
};

/** NM daemon data is identical cluster-wide except for the node identity; unknown hosts get the captured node, re-labelled. */
function nmInfoFor(hostPort: string) {
  if (hostPort === NM_INFO.id) return NM_INFO;
  return { ...NM_INFO, id: hostPort, nodeHostName: hostPort.split(":")[0] };
}

function nmPath(hostPort: string, path: string): Response {
  switch (path) {
    case "info":
      return json({ nodeInfo: nmInfoFor(hostPort) });
    case "containers":
      return json({ containers: { container: NM_CONTAINERS[hostPort] ?? [] } });
    case "apps":
      return json(hostPort === "127.0.0.2:8042" ? { apps: { app: NM_APPS } } : { apps: {} });
    case "conf":
      return json(confFixture);
    case "jmx":
      return json(jmxFixture);
    default:
      return notFound(`path ${path} not found`);
  }
}

export async function handleNodes(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\//, "");
  const seg = path.split("/");

  if (seg[0] === "nm" && seg.length >= 3) {
    return nmPath(decodeURIComponent(seg[1] ?? ""), seg.slice(2).join("/"));
  }

  if (seg[0] === "yarn" && seg[1] === "nodes" && seg.length === 3) {
    const id = decodeURIComponent(seg[2] ?? "");
    const node = SINGLE_NODES.get(id);
    if (node) return json({ node });
    const cluster = getCluster();
    if (cluster.nodes.some((candidate) => nodeIdOf(candidate) === id || candidate.host === id)) {
      return json(nodeResponse(cluster, id));
    }
    return notFound(`nodeId, ${id}, is not found`);
  }
  if (path === "yarn/get-node-labels") return json(nodeLabelsResponse(getCluster()));
  if (path === "yarn/get-node-to-labels") return json(nodeToLabelsResponse(getCluster()));
  if (path === "yarn/label-mappings") return json(labelMappingsResponse(getCluster()));

  return null;
}
