import { z } from "zod";
import { num, obj } from "./_base";
import { entryMap, list } from "./_lenient";

/**
 * `org.apache.hadoop.yarn.server.webapp.dao.ContainerInfo` (used by RM `/appattempts/{id}/containers[/{cid}]`).
 * This class is not in the RM's JAXBContextResolver, so Jersey "mapped" notation applies: numbers may arrive
 * as strings (hence `num` everywhere) and `allocatedResources` is `[{key,value}]` / `{entry:[…]}`.
 */
export const ContainerSchema = obj({
  containerId: z.string(),
  allocatedMB: num,
  allocatedVCores: num,
  assignedNodeId: z.string().optional(),
  priority: num,
  startedTime: num,
  finishedTime: num, // 0 while running
  elapsedTime: num,
  diagnosticsInfo: z.string().optional(),
  logUrl: z.string().optional(),
  containerExitStatus: num, // -1000 INVALID, -1 ABORTED, 0 success, …
  containerState: z.string(), // ContainerState: NEW|RUNNING|COMPLETE
  nodeHttpAddress: z.string().optional(),
  nodeId: z.string(),
  allocatedResources: entryMap(num).optional(), // {"memory-mb":1024,"vcores":1,…}
  exposedPorts: z.string().optional(),
});
export type Container = z.infer<typeof ContainerSchema>;

const ContainersInnerSchema = obj({ container: list(ContainerSchema) });

/**
 * `GET …/containers`. Three shapes occur in the wild, and Hadoop omits empty collections entirely:
 *
 *   {"containers":{"container":[…]}}   wrapped (AHS/JHS-style)
 *   {"container":[…]}                  root-unwrapped — what the RM 3.4.3 actually answers (verified live,
 *                                      `apps/{id}/appattempts/{id}/containers`)
 *   {} / {"containers":null}           no live containers: the RM drops records for terminal attempts
 *
 * A union of two object schemas is not safe here: the wrapped branch matches the unwrapped payload
 * leniently (unknown keys are stripped) and yields zero containers, which silently looked like
 * "the RM has no containers" for *running* applications.
 */
export const ContainersResponseSchema = obj({
  containers: ContainersInnerSchema.nullable().optional(),
  container: list(ContainerSchema).optional(),
}).transform((v): { containers?: { container: Container[] } } => ({
  containers: v.containers ?? (v.container ? { container: v.container } : undefined),
}));
export type ContainersResponse = z.infer<typeof ContainersResponseSchema>;
export const selectContainers = (r: ContainersResponse): Container[] => r.containers?.container ?? [];

/** `GET …/containers/{id}` — `{container:{…}}`; root unwrapped (bare object) tolerated. */
export const ContainerResponseSchema = z.union([obj({ container: ContainerSchema }), ContainerSchema.transform((v) => ({ container: v }))]);
export type ContainerResponse = z.infer<typeof ContainerResponseSchema>;
export const selectContainer = (r: ContainerResponse): Container => r.container;
