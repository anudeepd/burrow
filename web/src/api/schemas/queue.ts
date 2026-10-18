import { z } from "zod";
import { num, obj } from "./_base";
import { floatish, list } from "./_lenient";
import { ResourceInfoSchema, ResourcesInfoSchema } from "./resource";

/** `QueueCapacityVectorEntryInfo`. */
export const QueueCapacityVectorEntrySchema = obj({
  resourceName: z.string(),
  resourceValue: z.string(), // "12.5%", "[memory=1024]"
});
export type QueueCapacityVectorEntry = z.infer<typeof QueueCapacityVectorEntrySchema>;

/** `QueueCapacityVectorInfo`. */
export const QueueCapacityVectorSchema = obj({
  configuredCapacityVector: z.string().optional(),
  capacityVectorEntries: list(QueueCapacityVectorEntrySchema),
});
export type QueueCapacityVector = z.infer<typeof QueueCapacityVectorSchema>;

/** `PartitionQueueCapacitiesInfo` — one entry of `capacities.queueCapacitiesByPartition`. */
export const PartitionCapacitySchema = obj({
  partitionName: z.string().optional(), // "" = default partition
  queueCapacityVectorInfo: QueueCapacityVectorSchema.optional(),
  capacity: floatish,
  usedCapacity: floatish,
  maxCapacity: floatish,
  absoluteCapacity: floatish,
  absoluteUsedCapacity: floatish,
  absoluteMaxCapacity: floatish,
  maxAMLimitPercentage: floatish.optional(),
  weight: floatish.optional(), // -1 when unset
  normalizedWeight: floatish.optional(),
  configuredMinResource: ResourceInfoSchema.optional(),
  configuredMaxResource: ResourceInfoSchema.optional(),
  effectiveMinResource: ResourceInfoSchema.optional(),
  effectiveMaxResource: ResourceInfoSchema.optional(),
});
export type PartitionCapacity = z.infer<typeof PartitionCapacitySchema>;

/** `QueueCapacitiesInfo`. */
export const QueueCapacitiesSchema = obj({
  queueCapacitiesByPartition: list(PartitionCapacitySchema),
});
export type QueueCapacities = z.infer<typeof QueueCapacitiesSchema>;

/** `QueueAclInfo` / `QueueAclsInfo`. */
export const QueueAclSchema = obj({
  accessType: z.string(), // SUBMIT_APPLICATIONS | ADMINISTER_QUEUE
  accessControlList: z.string(),
});
export type QueueAcl = z.infer<typeof QueueAclSchema>;
export const QueueAclsSchema = obj({ queueAcl: list(QueueAclSchema) });
export type QueueAcls = z.infer<typeof QueueAclsSchema>;

/** `ConfItem` of the auto-creation template (`LeafQueueTemplateInfo.ConfItem`). */
export const ConfItemSchema = obj({
  name: z.string(),
  value: z.string().optional(),
});
export type ConfItem = z.infer<typeof ConfItemSchema>;
/** `AutoQueueTemplatePropertiesInfo` / `LeafQueueTemplateInfo`. */
export const QueueTemplatePropertiesSchema = obj({ property: list(ConfItemSchema) });
export type QueueTemplateProperties = z.infer<typeof QueueTemplatePropertiesSchema>;

/** Capacity `UserInfo` (leaf queue `users.user[]`). */
export const UserInfoSchema = obj({
  username: z.string(),
  resourcesUsed: ResourceInfoSchema.optional(),
  numPendingApplications: num,
  numActiveApplications: num,
  AMResourceUsed: ResourceInfoSchema.optional(),
  userResourceLimit: ResourceInfoSchema.optional(),
  resources: ResourcesInfoSchema.optional(),
  userWeight: floatish.optional(),
  isActive: z.boolean().optional(),
});
export type UserInfo = z.infer<typeof UserInfoSchema>;
export const QueueUsersSchema = obj({ user: list(UserInfoSchema) });
export type QueueUsers = z.infer<typeof QueueUsersSchema>;

/**
 * `CapacitySchedulerQueueInfo` plus the leaf extension `CapacitySchedulerLeafQueueInfo` (all leaf-only keys optional).
 * Jersey adds `type: "capacitySchedulerLeafQueueInfo"` to leaves only.
 */
export const QueueInfoSchema = obj({
  type: z.string().optional(),
  queuePath: z.string().optional(),
  capacity: floatish,
  usedCapacity: floatish,
  maxCapacity: floatish,
  absoluteCapacity: floatish,
  absoluteMaxCapacity: floatish,
  absoluteUsedCapacity: floatish,
  weight: floatish.optional(),
  normalizedWeight: floatish.optional(),
  numApplications: num,
  maxParallelApps: num.optional(), // 2147483647 = unlimited
  queueName: z.string(),
  isAbsoluteResource: z.boolean().optional(),
  state: z.string().optional(), // RUNNING | STOPPED | DRAINING
  get queues() {
    return obj({ queue: list(QueueInfoSchema) }).optional();
  },
  resourcesUsed: ResourceInfoSchema.optional(),
  hideReservationQueues: z.boolean().optional(),
  nodeLabels: list(z.string()),
  allocatedContainers: num.optional(),
  reservedContainers: num.optional(),
  pendingContainers: num.optional(),
  capacities: QueueCapacitiesSchema.optional(),
  resources: ResourcesInfoSchema.optional(),
  minEffectiveCapacity: ResourceInfoSchema.optional(),
  maxEffectiveCapacity: ResourceInfoSchema.optional(),
  maximumAllocation: ResourceInfoSchema.optional(),
  queueAcls: QueueAclsSchema.optional(),
  queuePriority: num.optional(),
  orderingPolicyInfo: z.string().optional(),
  autoCreateChildQueueEnabled: z.boolean().optional(),
  leafQueueTemplate: QueueTemplatePropertiesSchema.optional(),
  mode: z.string().optional(), // percentage | absolute | weight
  queueType: z.string().optional(), // parent | leaf
  creationMethod: z.string().optional(), // static | dynamicLegacy | dynamicFlexible
  autoCreationEligibility: z.string().optional(), // off | legacy | flexible
  defaultNodeLabelExpression: z.string().optional(),
  autoQueueTemplateProperties: QueueTemplatePropertiesSchema.optional(),
  autoQueueParentTemplateProperties: QueueTemplatePropertiesSchema.optional(),
  autoQueueLeafTemplateProperties: QueueTemplatePropertiesSchema.optional(),
  // ---- leaf only (CapacitySchedulerLeafQueueInfo) ----
  numActiveApplications: num.optional(),
  numPendingApplications: num.optional(),
  numContainers: num.optional(),
  maxApplications: num.optional(),
  maxApplicationsPerUser: num.optional(),
  userLimit: floatish.optional(),
  users: QueueUsersSchema.optional(),
  userLimitFactor: floatish.optional(),
  configuredMaxAMResourceLimit: floatish.optional(),
  AMResourceLimit: ResourceInfoSchema.optional(),
  usedAMResource: ResourceInfoSchema.optional(),
  userAMResourceLimit: ResourceInfoSchema.optional(),
  preemptionDisabled: z.boolean().optional(),
  intraQueuePreemptionDisabled: z.boolean().optional(),
  defaultPriority: num.optional(),
  isAutoCreatedLeafQueue: z.boolean().optional(),
  maxApplicationLifetime: num.optional(), // -1 = unlimited
  defaultApplicationLifetime: num.optional(),
});
export type QueueInfo = z.infer<typeof QueueInfoSchema>;
