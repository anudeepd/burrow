import { z } from "zod";
import { num, obj } from "./_base";
import { boolish, entryMap, list } from "./_lenient";
import { ResourceInfoSchema } from "./resource";

/*
 * None of these DAOs is registered in the RM's JAXBContextResolver, so Jersey "mapped" notation applies:
 * root element unwrapped (`{"nodeLabelInfo":[…]}`), numbers/booleans may be strings, Maps => `{entry:[{key,value}]}`.
 * Wrapped roots (`{"nodeLabelsInfo":{…}}`) are tolerated too. Output of every *Response schema is the normalised shape.
 */

/** `PartitionInfo`. */
export const PartitionInfoSchema = obj({ resourceAvailable: ResourceInfoSchema.optional() });
export type PartitionInfo = z.infer<typeof PartitionInfoSchema>;

/** `NodeLabelInfo`. NB the Java field is `activeNMs` (only set by `/get-rm-node-labels`). */
export const NodeLabelSchema = obj({
  name: z.string(), // "" = DEFAULT partition on some endpoints
  exclusivity: boolish,
  partitionInfo: PartitionInfoSchema.optional(),
  activeNMs: num.optional(),
});
export type NodeLabel = z.infer<typeof NodeLabelSchema>;

/** `NodeLabelsInfo` unwrapped: `{nodeLabelInfo:[…]}`. */
export const NodeLabelsInfoSchema = obj({ nodeLabelInfo: list(NodeLabelSchema) });
export type NodeLabelsInfo = z.infer<typeof NodeLabelsInfoSchema>;

/** `GET /get-node-labels`. */
export const NodeLabelsResponseSchema = z.union([
  obj({ nodeLabelsInfo: NodeLabelsInfoSchema }).transform((v) => v.nodeLabelsInfo),
  NodeLabelsInfoSchema,
]);
export type NodeLabelsResponse = z.infer<typeof NodeLabelsResponseSchema>;
export const selectNodeLabels = (r: NodeLabelsResponse): NodeLabel[] => r.nodeLabelInfo;

/** `GET /get-node-to-labels` — `{nodeToLabels:{entry:[{key:"host:port",value:{nodeLabelInfo:[…]}}]}}` => record. */
const NodeToLabelsInnerSchema = obj({ nodeToLabels: entryMap(NodeLabelsInfoSchema).optional() });
export const NodeToLabelsResponseSchema = z.union([
  obj({ nodeToLabelsInfo: NodeToLabelsInnerSchema }).transform((v) => v.nodeToLabelsInfo),
  NodeToLabelsInnerSchema,
]);
export type NodeToLabelsResponse = z.infer<typeof NodeToLabelsResponseSchema>;
export const selectNodeToLabels = (r: NodeToLabelsResponse): Record<string, NodeLabel[]> => {
  const out: Record<string, NodeLabel[]> = {};
  for (const [node, info] of Object.entries(r.nodeToLabels ?? {})) out[node] = info.nodeLabelInfo;
  return out;
};

/** `NodeIDsInfo`: `{nodes:[…], partitionInfo}`. */
export const NodeIDsInfoSchema = obj({
  nodes: list(z.string()),
  partitionInfo: PartitionInfoSchema.optional(),
});
export type NodeIDsInfo = z.infer<typeof NodeIDsInfoSchema>;

/** `GET /label-mappings` — `{labelsToNodes:{entry:[{key:NodeLabelInfo,value:NodeIDsInfo}]}}`. */
export const LabelMappingEntrySchema = obj({ key: NodeLabelSchema, value: NodeIDsInfoSchema });
export type LabelMappingEntry = z.infer<typeof LabelMappingEntrySchema>;
const LabelMappingsInnerSchema = obj({
  labelsToNodes: obj({ entry: list(LabelMappingEntrySchema) }).optional(),
});
export const LabelMappingsResponseSchema = z.union([
  obj({ labelsToNodesInfo: LabelMappingsInnerSchema }).transform((v) => v.labelsToNodesInfo),
  LabelMappingsInnerSchema,
]);
export type LabelMappingsResponse = z.infer<typeof LabelMappingsResponseSchema>;
export const selectLabelMappings = (r: LabelMappingsResponse): LabelMappingEntry[] => r.labelsToNodes?.entry ?? [];
