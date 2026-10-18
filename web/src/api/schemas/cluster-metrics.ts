import { z } from "zod";
import { num, obj } from "./_base";
import { ResourceInfoSchema } from "./resource";

/**
 * RM `ClusterMetricsInfo` — `GET /ws/v1/cluster/metrics`.
 * Required = present in every Hadoop 2.x/3.x response; optional = added later or only emitted by the Capacity Scheduler.
 */
export const ClusterMetricsSchema = obj({
  appsSubmitted: num,
  appsCompleted: num,
  appsPending: num,
  appsRunning: num,
  appsFailed: num,
  appsKilled: num,
  reservedMB: num,
  availableMB: num,
  allocatedMB: num,
  pendingMB: num.optional(),
  reservedVirtualCores: num,
  availableVirtualCores: num,
  allocatedVirtualCores: num,
  pendingVirtualCores: num.optional(),
  containersAllocated: num,
  containersReserved: num,
  containersPending: num,
  totalMB: num,
  utilizedMB: num.optional(),
  totalVirtualCores: num,
  utilizedVirtualCores: num.optional(),
  utilizedMBPercent: num.optional(),
  utilizedVirtualCoresPercent: num.optional(),
  rmSchedulerBusyPercent: num.optional(), // -1 when the event-processor monitor is disabled
  totalNodes: num,
  lostNodes: num,
  unhealthyNodes: num,
  decommissioningNodes: num,
  decommissionedNodes: num,
  rebootedNodes: num,
  activeNodes: num,
  shutdownNodes: num,
  containerAssignedPerSecond: num.optional(),
  totalUsedResourcesAcrossPartition: ResourceInfoSchema.optional(), // Capacity Scheduler only
  totalClusterResourcesAcrossPartition: ResourceInfoSchema.optional(),
  totalReservedResourcesAcrossPartition: ResourceInfoSchema.optional(),
  totalAllocatedContainersAcrossPartition: num.optional(),
  crossPartitionMetricsAvailable: z.boolean().optional(),
  rmEventQueueSize: num.optional(),
  schedulerEventQueueSize: num.optional(),
});
export type ClusterMetrics = z.infer<typeof ClusterMetricsSchema>;

export const ClusterMetricsResponseSchema = obj({ clusterMetrics: ClusterMetricsSchema });
export type ClusterMetricsResponse = z.infer<typeof ClusterMetricsResponseSchema>;
export const selectClusterMetrics = (r: ClusterMetricsResponse): ClusterMetrics => r.clusterMetrics;
