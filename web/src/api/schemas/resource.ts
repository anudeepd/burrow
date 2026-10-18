import { z } from "zod";
import { num, obj } from "./_base";
import { entryMap, list } from "./_lenient";

/** yarn-api `ResourceInformation` (bean getters; JSON via JAXB default accessor). */
export const ResourceInformationSchema = obj({
  name: z.string(),
  resourceType: z.string().optional(), // COUNTABLE
  units: z.string().optional(), // "Mi", ""…
  value: num,
  minimumAllocation: num.optional(),
  maximumAllocation: num.optional(), // 9223372036854775807 loses precision as a JS number; display-only
  tags: list(z.string()),
  attributes: entryMap(z.string()).optional(),
});
export type ResourceInformation = z.infer<typeof ResourceInformationSchema>;

/** `ResourceInformationsInfo`: the value of `ResourceInfo.resourceInformations`, i.e. `{resourceInformation:[…]}`. */
export const ResourceInformationsSchema = obj({
  resourceInformation: list(ResourceInformationSchema),
});
export type ResourceInformations = z.infer<typeof ResourceInformationsSchema>;

/** RM `ResourceInfo` (`{memory, vCores, resourceInformations}`); `memory` in MB. */
export const ResourceInfoSchema = obj({
  memory: num,
  vCores: num,
  resourceInformations: ResourceInformationsSchema.optional(),
});
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;

/** `PartitionResourcesInfo` (a.k.a. one entry of `resourceUsagesByPartition`). */
export const PartitionResourcesInfoSchema = obj({
  partitionName: z.string().optional(),
  used: ResourceInfoSchema.optional(),
  reserved: ResourceInfoSchema.optional(),
  pending: ResourceInfoSchema.optional(),
  amUsed: ResourceInfoSchema.optional(),
  amLimit: ResourceInfoSchema.optional(),
  userAmLimit: ResourceInfoSchema.optional(),
});
export type PartitionResourcesInfo = z.infer<typeof PartitionResourcesInfoSchema>;
export const ResourceUsageByPartitionSchema = PartitionResourcesInfoSchema;
export type ResourceUsageByPartition = PartitionResourcesInfo;

/** `ResourcesInfo`: `{resourceUsagesByPartition:[…]}` (queues, users, `AppInfo.resourceInfo`). */
export const ResourcesInfoSchema = obj({
  resourceUsagesByPartition: list(PartitionResourcesInfoSchema),
});
export type ResourcesInfo = z.infer<typeof ResourcesInfoSchema>;

/** `ResourceUtilizationInfo` (node utilisation). CPU values are fractions/percent as reported by the NM. */
export const ResourceUtilizationSchema = obj({
  nodePhysicalMemoryMB: num,
  nodeVirtualMemoryMB: num,
  nodeCPUUsage: num,
  aggregatedContainersPhysicalMemoryMB: num,
  aggregatedContainersVirtualMemoryMB: num,
  containersCPUUsage: num,
});
export type ResourceUtilization = z.infer<typeof ResourceUtilizationSchema>;
