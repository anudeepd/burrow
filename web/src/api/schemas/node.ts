import { z } from "zod";
import { num, obj } from "./_base";
import { list } from "./_lenient";
import { ResourceInfoSchema, ResourceUtilizationSchema } from "./resource";

/** Known `NodeState` values (`/nodes?states=` filter and `NodeInfo.state`). Schema field stays a lenient string. */
export const NODE_STATES = ["NEW", "RUNNING", "UNHEALTHY", "DECOMMISSIONING", "DECOMMISSIONED", "LOST", "REBOOTED", "SHUTDOWN"] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** `AllocationTagInfo`. */
export const AllocationTagInfoSchema = obj({
  allocationTag: z.string(),
  allocationsCount: num,
});
export type AllocationTagInfo = z.infer<typeof AllocationTagInfoSchema>;
export const AllocationTagsInfoSchema = obj({ allocationTagInfo: list(AllocationTagInfoSchema) });
export type AllocationTagsInfo = z.infer<typeof AllocationTagsInfoSchema>;

/** `NodeAttributeInfo`. */
export const NodeAttributeInfoSchema = obj({
  prefix: z.string().optional(), // "nm.yarn.io"
  name: z.string(),
  type: z.string().optional(), // STRING
  value: z.string().optional(),
});
export type NodeAttributeInfo = z.infer<typeof NodeAttributeInfoSchema>;
export const NodeAttributesInfoSchema = obj({ nodeAttributeInfo: list(NodeAttributeInfoSchema) });
export type NodeAttributesInfo = z.infer<typeof NodeAttributesInfoSchema>;

/** RM `NodeInfo` (JAXB FIELD). */
export const NodeSchema = obj({
  rack: z.string(),
  state: z.string(), // NodeState (lenient)
  id: z.string(), // "host:port"
  nodeHostName: z.string(),
  nodeHTTPAddress: z.string(),
  lastHealthUpdate: num,
  version: z.string().optional(),
  healthReport: z.string(),
  numContainers: num,
  usedMemoryMB: num,
  availMemoryMB: num,
  usedVirtualCores: num,
  availableVirtualCores: num,
  memUtilization: num.optional(), // percent
  cpuUtilization: num.optional(), // percent
  numRunningOpportContainers: num.optional(),
  usedMemoryOpportGB: num.optional(),
  usedVirtualCoresOpport: num.optional(),
  numQueuedContainers: num.optional(),
  nodeLabels: list(z.string()),
  allocationTags: AllocationTagsInfoSchema.optional(),
  resourceUtilization: ResourceUtilizationSchema.optional(),
  usedResource: ResourceInfoSchema.optional(),
  availableResource: ResourceInfoSchema.optional(),
  nodeAttributesInfo: NodeAttributesInfoSchema.optional(),
  totalResource: ResourceInfoSchema.optional(),
  subClusterId: z.string().optional(),
});
export type Node = z.infer<typeof NodeSchema>;

/** `GET /nodes` — `{nodes:{node:[…]}}`, `{"nodes":null}` when empty. */
export const NodesResponseSchema = obj({
  nodes: obj({ node: list(NodeSchema) })
    .nullable()
    .optional(),
});
export type NodesResponse = z.infer<typeof NodesResponseSchema>;
export const selectNodes = (r: NodesResponse): Node[] => r.nodes?.node ?? [];

/** `GET /nodes/{id}` — `{node:{…}}`. */
export const NodeResponseSchema = obj({ node: NodeSchema });
export type NodeResponse = z.infer<typeof NodeResponseSchema>;
export const selectNode = (r: NodeResponse): Node => r.node;
