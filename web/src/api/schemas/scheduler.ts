import { z } from "zod";
import { num, obj } from "./_base";
import { floatish, list } from "./_lenient";
import { QueueAclsSchema, QueueCapacitiesSchema, QueueCapacityVectorSchema, QueueInfoSchema, QueueTemplatePropertiesSchema } from "./queue";
import { ResourceInfoSchema } from "./resource";

/** Scheduler `type` discriminator values (Jersey xsi:type of `SchedulerInfo` subclasses). */
export const SCHEDULER_TYPES = ["capacityScheduler", "fairScheduler", "fifoScheduler"] as const;
export type SchedulerType = (typeof SCHEDULER_TYPES)[number];

// ---------------------------------------------------------------- Capacity

/** `CapacitySchedulerHealthInfo.OperationInformation`. */
export const SchedulerHealthOperationSchema = obj({
  operation: z.string(), // last-allocation | last-release | last-preemption | last-reservation
  nodeId: z.string().optional(),
  containerId: z.string().optional(),
  queue: z.string().optional(),
});
export type SchedulerHealthOperation = z.infer<typeof SchedulerHealthOperationSchema>;

/** `CapacitySchedulerHealthInfo.LastRunDetails`. */
export const SchedulerHealthRunDetailsSchema = obj({
  operation: z.string(), // allocations | reservations | releases
  count: num,
  resources: ResourceInfoSchema.optional(),
});
export type SchedulerHealthRunDetails = z.infer<typeof SchedulerHealthRunDetailsSchema>;

/** `CapacitySchedulerHealthInfo`. */
export const SchedulerHealthSchema = obj({
  lastrun: num, // epoch ms, 0 = never
  operationsInfo: list(SchedulerHealthOperationSchema),
  lastRunDetails: list(SchedulerHealthRunDetailsSchema),
});
export type SchedulerHealth = z.infer<typeof SchedulerHealthSchema>;

/** `CapacitySchedulerInfo` (the root queue + scheduler-wide info). */
export const CapacitySchedulerInfoSchema = obj({
  type: z.literal("capacityScheduler"),
  capacity: floatish,
  usedCapacity: floatish,
  maxCapacity: floatish,
  weight: floatish.optional(),
  normalizedWeight: floatish.optional(),
  queueCapacityVectorInfo: QueueCapacityVectorSchema.optional(),
  queueName: z.string(),
  queuePath: z.string().optional(),
  maxParallelApps: num.optional(),
  isAbsoluteResource: z.boolean().optional(),
  queues: obj({ queue: list(QueueInfoSchema) }).optional(),
  capacities: QueueCapacitiesSchema.optional(),
  health: SchedulerHealthSchema.optional(),
  maximumAllocation: ResourceInfoSchema.optional(),
  queueAcls: QueueAclsSchema.optional(),
  queuePriority: num.optional(),
  orderingPolicyInfo: z.string().optional(),
  mode: z.string().optional(),
  queueType: z.string().optional(),
  creationMethod: z.string().optional(),
  autoCreationEligibility: z.string().optional(),
  defaultNodeLabelExpression: z.string().optional(),
  autoQueueTemplateProperties: QueueTemplatePropertiesSchema.optional(),
  autoQueueParentTemplateProperties: QueueTemplatePropertiesSchema.optional(),
  autoQueueLeafTemplateProperties: QueueTemplatePropertiesSchema.optional(),
});
export type CapacitySchedulerInfo = z.infer<typeof CapacitySchedulerInfoSchema>;

// -------------------------------------------------------------------- Fair

/** `FairSchedulerQueueInfo` + `FairSchedulerLeafQueueInfo` (leaf keys optional; `type:"fairSchedulerLeafQueueInfo"` on leaves). */
export const FairQueueInfoSchema = obj({
  type: z.string().optional(),
  maxApps: num,
  minResources: ResourceInfoSchema,
  maxResources: ResourceInfoSchema,
  usedResources: ResourceInfoSchema,
  amUsedResources: ResourceInfoSchema.optional(),
  amMaxResources: ResourceInfoSchema.optional(),
  demandResources: ResourceInfoSchema,
  steadyFairResources: ResourceInfoSchema,
  fairResources: ResourceInfoSchema,
  clusterResources: ResourceInfoSchema,
  reservedResources: ResourceInfoSchema.optional(),
  maxContainerAllocation: ResourceInfoSchema.optional(),
  pendingContainers: num,
  allocatedContainers: num,
  reservedContainers: num,
  queueName: z.string(),
  schedulingPolicy: z.string(),
  preemptable: z.boolean(),
  get childQueues() {
    return obj({ queue: list(FairQueueInfoSchema) }).optional();
  },
  // leaf only
  numPendingApps: num.optional(),
  numActiveApps: num.optional(),
});
export type FairQueueInfo = z.infer<typeof FairQueueInfoSchema>;

/** `FairSchedulerInfo`. */
export const FairSchedulerInfoSchema = obj({
  type: z.literal("fairScheduler"),
  rootQueue: FairQueueInfoSchema,
});
export type FairSchedulerInfo = z.infer<typeof FairSchedulerInfoSchema>;

// -------------------------------------------------------------------- FIFO

/** `FifoSchedulerInfo`. `usedCapacity` is `"NaN"` on an idle cluster. */
export const FifoSchedulerInfoSchema = obj({
  type: z.literal("fifoScheduler"),
  capacity: floatish,
  usedCapacity: floatish,
  qstate: z.string().optional(), // RUNNING | STOPPED
  minQueueMemoryCapacity: num,
  maxQueueMemoryCapacity: num,
  numNodes: num,
  usedNodeCapacity: num,
  availNodeCapacity: num,
  totalNodeCapacity: num,
  numContainers: num,
});
export type FifoSchedulerInfo = z.infer<typeof FifoSchedulerInfoSchema>;

// ----------------------------------------------------------------- Union

/** Forward-compat fallback: a scheduler type this build doesn't know (deliberately open even in strict mode). */
export const UnknownSchedulerInfoSchema = z.looseObject({
  type: z.string().refine((t) => !(SCHEDULER_TYPES as readonly string[]).includes(t), "known scheduler type with an invalid body"),
});
export type UnknownSchedulerInfo = z.infer<typeof UnknownSchedulerInfoSchema>;

export const SchedulerInfoSchema = z.union([
  z.discriminatedUnion("type", [CapacitySchedulerInfoSchema, FairSchedulerInfoSchema, FifoSchedulerInfoSchema]),
  UnknownSchedulerInfoSchema,
]);
export type SchedulerInfo = z.infer<typeof SchedulerInfoSchema>;

/** `GET /scheduler` — `SchedulerTypeInfo`: `{scheduler:{schedulerInfo:{type,…}}}`. */
export const SchedulerResponseSchema = obj({
  scheduler: obj({
    schedulerInfo: SchedulerInfoSchema,
    subClusterId: z.string().optional(),
  }),
});
export type SchedulerResponse = z.infer<typeof SchedulerResponseSchema>;
export const selectSchedulerInfo = (r: SchedulerResponse): SchedulerInfo => r.scheduler.schedulerInfo;

export const isCapacityScheduler = (s: SchedulerInfo): s is CapacitySchedulerInfo => s.type === "capacityScheduler";
export const isFairScheduler = (s: SchedulerInfo): s is FairSchedulerInfo => s.type === "fairScheduler";
export const isFifoScheduler = (s: SchedulerInfo): s is FifoSchedulerInfo => s.type === "fifoScheduler";
