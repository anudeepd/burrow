# Schema field inventory

Columns: `jsonPath` (relative to the entity root noted in each heading) · zod type (`?` = optional, `[]` = list normalised via `list()`, `num` = number|numeric string, `floatish` = num|"NaN") · DAO source `file:line` (Hadoop 3.4.3 sources).
Required = emitted for every Hadoop 2.x/3.x response; `?` = nullable, ACL/scheduler-gated, or added after the 2.7 baseline.

## attempt — `AppAttemptSchema` (app-attempt.ts) root `appAttempts.appAttempt[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `id` | `num` | AppAttemptInfo.java:42 |
| `startTime` | `num` | AppAttemptInfo.java:43 |
| `finishedTime` | `num` | AppAttemptInfo.java:44 |
| `containerId` | `z.string()` | AppAttemptInfo.java:45 |
| `nodeHttpAddress` | `z.string()` | AppAttemptInfo.java:46 |
| `nodeId` | `z.string()` | AppAttemptInfo.java:47 |
| `logsLink` | `z.string()` | AppAttemptInfo.java:48 |
| `blacklistedNodes` | `z.string().optional()` | AppAttemptInfo.java:49 |
| `nodesBlacklistedBySystem` | `z.string().optional()` | AppAttemptInfo.java:50 |
| `appAttemptId` | `z.string()` | AppAttemptInfo.java:51 |
| `exportPorts` | `z.string().optional()` | AppAttemptInfo.java:52 |
| `appAttemptState` | `z.string()` | AppAttemptInfo.java:53 |

## app.state — `AppStateResponseSchema` (app-misc.ts) root ``

| jsonPath | zod type | DAO source |
|---|---|---|
| `state` | `z.string()` | AppState.java:29 |
| `diagnostics` | `z.string().optional()` | AppState.java:30 |

## appstat — `StatisticsItemSchema` (app-misc.ts) root `appStatInfo.statItem[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `state` | `z.string()` | StatisticsItemInfo.java:30 |
| `type` | `z.string()` | StatisticsItemInfo.java:31 |
| `count` | `num` | StatisticsItemInfo.java:32 |

## activity.node — `ActivityNodeSchema` (app-misc.ts) root `children[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `name` | `z.string().optional()` | ActivityNodeInfo.java:41 |
| `appPriority` | `num.optional()` | ActivityNodeInfo.java:42 |
| `requestPriority` | `num.optional()` | ActivityNodeInfo.java:43 |
| `allocationRequestId` | `num.optional()` | ActivityNodeInfo.java:44 |
| `allocationState` | `z.string().optional()` | ActivityNodeInfo.java:45 |
| `diagnostic` | `z.string().optional()` | ActivityNodeInfo.java:46 |
| `nodeId` | `z.string().optional()` | ActivityNodeInfo.java:47 |
| `count` | `num.optional()` | ActivityNodeInfo.java:50 |
| `nodeIds` | `list(z.string())` | ActivityNodeInfo.java:51 |
| `children` | `lazy (recursive)` | ActivityNodeInfo.java:53 |

## activity.nodeAllocation — `NodeAllocationSchema` (app-misc.ts) root `allocations[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `partition` | `z.string().optional()` | NodeAllocationInfo.java:36 |
| `updatedContainerId` | `z.string().optional()` | NodeAllocationInfo.java:37 |
| `finalAllocationState` | `z.string().optional()` | NodeAllocationInfo.java:38 |
| `root` | `ActivityNodeSchema.optional()` | NodeAllocationInfo.java:39 |

## activity — `ActivitiesSchema` (app-misc.ts) root `activities`

| jsonPath | zod type | DAO source |
|---|---|---|
| `nodeId` | `z.string().optional()` | ActivitiesInfo.java:41 |
| `timestamp` | `num.optional()` | ActivitiesInfo.java:42 |
| `dateTime` | `z.string().optional()` | ActivitiesInfo.java:43 |
| `diagnostic` | `z.string().optional()` | ActivitiesInfo.java:44 |
| `allocations` | `list(NodeAllocationSchema)` | ActivitiesInfo.java:45 |

## activity.appRequest — `AppRequestAllocationSchema` (app-misc.ts) root `allocations[].children[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `requestPriority` | `num.optional()` | AppRequestAllocationInfo.java:37 |
| `allocationRequestId` | `num.optional()` | AppRequestAllocationInfo.java:38 |
| `allocationState` | `z.string().optional()` | AppRequestAllocationInfo.java:39 |
| `diagnostic` | `z.string().optional()` | AppRequestAllocationInfo.java:40 |
| `children` | `list(ActivityNodeSchema)` | AppRequestAllocationInfo.java:41 |

## activity.appAllocation — `AppAllocationSchema` (app-misc.ts) root `appActivities.allocations[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `nodeId` | `z.string().optional()` | AppAllocationInfo.java:40 |
| `timestamp` | `num.optional()` | AppAllocationInfo.java:41 |
| `dateTime` | `z.string().optional()` | AppAllocationInfo.java:42 |
| `queueName` | `z.string().optional()` | AppAllocationInfo.java:43 |
| `appPriority` | `num.optional()` | AppAllocationInfo.java:44 |
| `allocationState` | `z.string().optional()` | AppAllocationInfo.java:45 |
| `diagnostic` | `z.string().optional()` | AppAllocationInfo.java:46 |
| `children` | `list(AppRequestAllocationSchema)` | AppAllocationInfo.java:47 |

## schedulerConf.item — `SchedulerConfItemSchema` (app-misc.ts) root `property[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `name` | `z.string()` | ConfInfo.java:60 |
| `value` | `z.string().optional()` | ConfInfo.java:61 |

## app.executionTypeRequest — `ExecutionTypeRequestSchema` (app.ts) root `executionTypeRequest`

| jsonPath | zod type | DAO source |
|---|---|---|
| `executionType` | `z.string()` | ExecutionTypeRequestInfo.java:36 |
| `enforceExecutionType` | `z.boolean()` | ExecutionTypeRequestInfo.java:38 |

## app.resourceRequest — `ResourceRequestInfoSchema` (app.ts) root `resourceRequests[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `priority` | `num` | ResourceRequestInfo.java:40 |
| `allocationRequestId` | `num` | ResourceRequestInfo.java:42 |
| `resourceName` | `z.string().optional()` | ResourceRequestInfo.java:44 |
| `capability` | `ResourceInfoSchema.optional()` | ResourceRequestInfo.java:46 |
| `numContainers` | `num` | ResourceRequestInfo.java:48 |
| `relaxLocality` | `z.boolean()` | ResourceRequestInfo.java:50 |
| `nodeLabelExpression` | `z.string().optional()` | ResourceRequestInfo.java:52 |
| `executionTypeRequest` | `ExecutionTypeRequestSchema.optional()` | ResourceRequestInfo.java:55 |
| `placementConstraint` | `z.string().optional()` | ResourceRequestInfo.java:58 |
| `allocationTags` | `list(z.string())` | ResourceRequestInfo.java:60 |

## app.timeout — `AppTimeoutInfoSchema` (app.ts) root `timeouts.timeout[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `type` | `z.string()` | AppTimeoutInfo.java:36 (`timeoutType`, `@XmlElement(name="type")`) |
| `expiryTime` | `z.string().optional()` | AppTimeoutInfo.java:39 |
| `remainingTimeInSeconds` | `num.optional()` | AppTimeoutInfo.java:42 (`remainingTimeInSec`) |

## app — `AppSchema` (app.ts) root `apps.app[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `id` | `z.string()` | AppInfo.java:80 |
| `user` | `z.string()` | AppInfo.java:81 |
| `name` | `z.string()` | AppInfo.java:82 |
| `queue` | `z.string()` | AppInfo.java:83 |
| `state` | `z.string()` | AppInfo.java:84 |
| `finalStatus` | `z.string()` | AppInfo.java:85 |
| `progress` | `num` | AppInfo.java:86 |
| `trackingUI` | `z.string()` | AppInfo.java:87 |
| `trackingUrl` | `z.string().optional()` | AppInfo.java:88 |
| `diagnostics` | `z.string()` | AppInfo.java:89 |
| `clusterId` | `num` | AppInfo.java:90 |
| `rmClusterId` | `z.string().optional()` | AppInfo.java:91 |
| `applicationType` | `z.string().optional()` | AppInfo.java:92 |
| `applicationTags` | `z.string()` | AppInfo.java:93 |
| `priority` | `num` | AppInfo.java:94 |
| `startedTime` | `num` | AppInfo.java:97 |
| `launchTime` | `num.optional()` | AppInfo.java:98 |
| `finishedTime` | `num` | AppInfo.java:99 |
| `elapsedTime` | `num` | AppInfo.java:100 |
| `amContainerLogs` | `z.string().optional()` | AppInfo.java:101 |
| `amHostHttpAddress` | `z.string().optional()` | AppInfo.java:102 |
| `amRPCAddress` | `z.string().optional()` | AppInfo.java:103 |
| `masterNodeId` | `z.string().optional()` | AppInfo.java:104 |
| `allocatedMB` | `num` | AppInfo.java:105 |
| `allocatedVCores` | `num` | AppInfo.java:106 |
| `reservedMB` | `num.optional()` | AppInfo.java:107 |
| `reservedVCores` | `num.optional()` | AppInfo.java:108 |
| `runningContainers` | `num` | AppInfo.java:109 |
| `memorySeconds` | `num` | AppInfo.java:110 |
| `vcoreSeconds` | `num` | AppInfo.java:111 |
| `queueUsagePercentage` | `num` | AppInfo.java:112 |
| `clusterUsagePercentage` | `num` | AppInfo.java:113 |
| `resourceSecondsMap` | `entryMap(num).optional()` | AppInfo.java:114 |
| `preemptedResourceMB` | `num` | AppInfo.java:117 |
| `preemptedResourceVCores` | `num` | AppInfo.java:118 |
| `numNonAMContainerPreempted` | `num` | AppInfo.java:119 |
| `numAMContainerPreempted` | `num` | AppInfo.java:120 |
| `preemptedMemorySeconds` | `num.optional()` | AppInfo.java:121 |
| `preemptedVcoreSeconds` | `num.optional()` | AppInfo.java:122 |
| `preemptedResourceSecondsMap` | `entryMap(num).optional()` | AppInfo.java:123 |
| `resourceRequests` | `list(ResourceRequestInfoSchema)` | AppInfo.java:127 |
| `logAggregationStatus` | `z.string().optional()` | AppInfo.java:130 |
| `unmanagedApplication` | `z.boolean()` | AppInfo.java:131 |
| `appNodeLabelExpression` | `z.string().optional()` | AppInfo.java:132 |
| `amNodeLabelExpression` | `z.string().optional()` | AppInfo.java:133 |
| `resourceInfo` | `ResourcesInfoSchema.optional()` | AppInfo.java:135 |
| `timeouts` | `AppTimeoutsInfoSchema.optional()` | AppInfo.java:136 |

## cluster.info — `ClusterInfoSchema` (cluster-info.ts) root `clusterInfo`

| jsonPath | zod type | DAO source |
|---|---|---|
| `id` | `num` | ClusterInfo.java:34 |
| `startedOn` | `num` | ClusterInfo.java:35 |
| `state` | `z.string()` | ClusterInfo.java:36 |
| `haState` | `z.string()` | ClusterInfo.java:37 |
| `rmStateStoreName` | `z.string()` | ClusterInfo.java:38 |
| `resourceManagerVersion` | `z.string()` | ClusterInfo.java:39 |
| `resourceManagerBuildVersion` | `z.string()` | ClusterInfo.java:40 |
| `resourceManagerVersionBuiltOn` | `z.string()` | ClusterInfo.java:41 |
| `hadoopVersion` | `z.string()` | ClusterInfo.java:42 |
| `hadoopBuildVersion` | `z.string()` | ClusterInfo.java:43 |
| `hadoopVersionBuiltOn` | `z.string()` | ClusterInfo.java:44 |
| `haZooKeeperConnectionState` | `z.string().optional()` | ClusterInfo.java:45 |
| `subClusterId` | `z.string().optional()` | ClusterInfo.java:47 |

## cluster.metrics — `ClusterMetricsSchema` (cluster-metrics.ts) root `clusterMetrics`

| jsonPath | zod type | DAO source |
|---|---|---|
| `appsSubmitted` | `num` | ClusterMetricsInfo.java:35 |
| `appsCompleted` | `num` | ClusterMetricsInfo.java:36 |
| `appsPending` | `num` | ClusterMetricsInfo.java:37 |
| `appsRunning` | `num` | ClusterMetricsInfo.java:38 |
| `appsFailed` | `num` | ClusterMetricsInfo.java:39 |
| `appsKilled` | `num` | ClusterMetricsInfo.java:40 |
| `reservedMB` | `num` | ClusterMetricsInfo.java:42 |
| `availableMB` | `num` | ClusterMetricsInfo.java:43 |
| `allocatedMB` | `num` | ClusterMetricsInfo.java:44 |
| `pendingMB` | `num.optional()` | ClusterMetricsInfo.java:45 |
| `reservedVirtualCores` | `num` | ClusterMetricsInfo.java:47 |
| `availableVirtualCores` | `num` | ClusterMetricsInfo.java:48 |
| `allocatedVirtualCores` | `num` | ClusterMetricsInfo.java:49 |
| `pendingVirtualCores` | `num.optional()` | ClusterMetricsInfo.java:50 |
| `containersAllocated` | `num` | ClusterMetricsInfo.java:52 |
| `containersReserved` | `num` | ClusterMetricsInfo.java:53 |
| `containersPending` | `num` | ClusterMetricsInfo.java:54 |
| `totalMB` | `num` | ClusterMetricsInfo.java:56 |
| `utilizedMB` | `num.optional()` | ClusterMetricsInfo.java:57 |
| `totalVirtualCores` | `num` | ClusterMetricsInfo.java:58 |
| `utilizedVirtualCores` | `num.optional()` | ClusterMetricsInfo.java:59 |
| `utilizedMBPercent` | `num.optional()` | ClusterMetricsInfo.java:60 |
| `utilizedVirtualCoresPercent` | `num.optional()` | ClusterMetricsInfo.java:61 |
| `rmSchedulerBusyPercent` | `num.optional()` | ClusterMetricsInfo.java:62 |
| `totalNodes` | `num` | ClusterMetricsInfo.java:63 |
| `lostNodes` | `num` | ClusterMetricsInfo.java:64 |
| `unhealthyNodes` | `num` | ClusterMetricsInfo.java:65 |
| `decommissioningNodes` | `num` | ClusterMetricsInfo.java:66 |
| `decommissionedNodes` | `num` | ClusterMetricsInfo.java:67 |
| `rebootedNodes` | `num` | ClusterMetricsInfo.java:68 |
| `activeNodes` | `num` | ClusterMetricsInfo.java:69 |
| `shutdownNodes` | `num` | ClusterMetricsInfo.java:70 |
| `containerAssignedPerSecond` | `num.optional()` | ClusterMetricsInfo.java:72 |
| `totalUsedResourcesAcrossPartition` | `ResourceInfoSchema.optional()` | ClusterMetricsInfo.java:75 |
| `totalClusterResourcesAcrossPartition` | `ResourceInfoSchema.optional()` | ClusterMetricsInfo.java:78 |
| `totalReservedResourcesAcrossPartition` | `ResourceInfoSchema.optional()` | ClusterMetricsInfo.java:81 |
| `totalAllocatedContainersAcrossPartition` | `num.optional()` | ClusterMetricsInfo.java:84 |
| `crossPartitionMetricsAvailable` | `z.boolean().optional()` | ClusterMetricsInfo.java:86 |
| `rmEventQueueSize` | `num.optional()` | ClusterMetricsInfo.java:88 |
| `schedulerEventQueueSize` | `num.optional()` | ClusterMetricsInfo.java:89 |

## container — `ContainerSchema` (container.ts) root `containers.container[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `containerId` | `z.string()` | ContainerInfo.java:43 |
| `allocatedMB` | `num` | ContainerInfo.java:44 |
| `allocatedVCores` | `num` | ContainerInfo.java:45 |
| `assignedNodeId` | `z.string().optional()` | ContainerInfo.java:46 |
| `priority` | `num` | ContainerInfo.java:47 |
| `startedTime` | `num` | ContainerInfo.java:48 |
| `finishedTime` | `num` | ContainerInfo.java:49 |
| `elapsedTime` | `num` | ContainerInfo.java:50 |
| `diagnosticsInfo` | `z.string().optional()` | ContainerInfo.java:51 |
| `logUrl` | `z.string().optional()` | ContainerInfo.java:52 |
| `containerExitStatus` | `num` | ContainerInfo.java:53 |
| `containerState` | `z.string()` | ContainerInfo.java:54 |
| `nodeHttpAddress` | `z.string().optional()` | ContainerInfo.java:55 |
| `nodeId` | `z.string()` | ContainerInfo.java:56 |
| `allocatedResources` | `entryMap(num).optional()` | ContainerInfo.java:57 |
| `exposedPorts` | `z.string().optional()` | ContainerInfo.java:58 |

## daemon.conf — `ConfPropertySchema` (daemon.ts) root `properties[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `key` | `z.string()` | Configuration.java:3867 |
| `value` | `z.string().nullable()` | Configuration.java:3868 |
| `isFinal` | `boolish` | Configuration.java:3870 |
| `resource` | `z.string().optional()` | Configuration.java:3878 |

## nodelabel — `NodeLabelSchema` (node-labels.ts) root `nodeLabelInfo[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `name` | `z.string()` | NodeLabelInfo.java:31 |
| `exclusivity` | `boolish` | NodeLabelInfo.java:32 |
| `partitionInfo` | `PartitionInfoSchema.optional()` | NodeLabelInfo.java:33 |
| `activeNMs` | `num.optional()` | NodeLabelInfo.java:34 |

## nodelabel.nodeIds — `NodeIDsInfoSchema` (node-labels.ts) root `labelsToNodes.entry[].value`

| jsonPath | zod type | DAO source |
|---|---|---|
| `nodes` | `list(z.string())` | NodeIDsInfo.java:87 |
| `partitionInfo` | `PartitionInfoSchema.optional()` | NodeIDsInfo.java:50 |

## node.allocationTag — `AllocationTagInfoSchema` (node.ts) root `allocationTags.allocationTagInfo[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `allocationTag` | `z.string()` | AllocationTagInfo.java:32 |
| `allocationsCount` | `num` | AllocationTagInfo.java:33 |

## node.attribute — `NodeAttributeInfoSchema` (node.ts) root `nodeAttributesInfo.nodeAttributeInfo[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `prefix` | `z.string().optional()` | NodeAttributeInfo.java:34 |
| `name` | `z.string()` | NodeAttributeInfo.java:35 |
| `type` | `z.string().optional()` | NodeAttributeInfo.java:36 |
| `value` | `z.string().optional()` | NodeAttributeInfo.java:37 |

## node — `NodeSchema` (node.ts) root `nodes.node[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `rack` | `z.string()` | NodeInfo.java:45 |
| `state` | `z.string()` | NodeInfo.java:46 |
| `id` | `z.string()` | NodeInfo.java:47 |
| `nodeHostName` | `z.string()` | NodeInfo.java:48 |
| `nodeHTTPAddress` | `z.string()` | NodeInfo.java:49 |
| `lastHealthUpdate` | `num` | NodeInfo.java:50 |
| `version` | `z.string().optional()` | NodeInfo.java:51 |
| `healthReport` | `z.string()` | NodeInfo.java:52 |
| `numContainers` | `num` | NodeInfo.java:53 |
| `usedMemoryMB` | `num` | NodeInfo.java:54 |
| `availMemoryMB` | `num` | NodeInfo.java:55 |
| `usedVirtualCores` | `num` | NodeInfo.java:56 |
| `availableVirtualCores` | `num` | NodeInfo.java:57 |
| `memUtilization` | `num.optional()` | NodeInfo.java:58 |
| `cpuUtilization` | `num.optional()` | NodeInfo.java:59 |
| `numRunningOpportContainers` | `num.optional()` | NodeInfo.java:60 |
| `usedMemoryOpportGB` | `num.optional()` | NodeInfo.java:61 |
| `usedVirtualCoresOpport` | `num.optional()` | NodeInfo.java:62 |
| `numQueuedContainers` | `num.optional()` | NodeInfo.java:63 |
| `nodeLabels` | `list(z.string())` | NodeInfo.java:64 |
| `allocationTags` | `AllocationTagsInfoSchema.optional()` | NodeInfo.java:65 |
| `resourceUtilization` | `ResourceUtilizationSchema.optional()` | NodeInfo.java:66 |
| `usedResource` | `ResourceInfoSchema.optional()` | NodeInfo.java:67 |
| `availableResource` | `ResourceInfoSchema.optional()` | NodeInfo.java:68 |
| `nodeAttributesInfo` | `NodeAttributesInfoSchema.optional()` | NodeInfo.java:69 |
| `totalResource` | `ResourceInfoSchema.optional()` | NodeInfo.java:70 |
| `subClusterId` | `z.string().optional()` | NodeInfo.java:71 |

## queue.capacityVectorEntry — `QueueCapacityVectorEntrySchema` (queue.ts) root `capacityVectorEntries[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `resourceName` | `z.string()` | QueueCapacityVectorEntryInfo.java:27 |
| `resourceValue` | `z.string()` | QueueCapacityVectorEntryInfo.java:28 |

## queue.capacityVector — `QueueCapacityVectorSchema` (queue.ts) root `queueCapacityVectorInfo`

| jsonPath | zod type | DAO source |
|---|---|---|
| `configuredCapacityVector` | `z.string().optional()` | QueueCapacityVectorInfo.java:32 |
| `capacityVectorEntries` | `list(QueueCapacityVectorEntrySchema)` | QueueCapacityVectorInfo.java:33 |

## queue.partitionCapacity — `PartitionCapacitySchema` (queue.ts) root `capacities.queueCapacitiesByPartition[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `partitionName` | `z.string().optional()` | PartitionQueueCapacitiesInfo.java:33 |
| `queueCapacityVectorInfo` | `QueueCapacityVectorSchema.optional()` | PartitionQueueCapacitiesInfo.java:35 |
| `capacity` | `floatish` | PartitionQueueCapacitiesInfo.java:36 |
| `usedCapacity` | `floatish` | PartitionQueueCapacitiesInfo.java:37 |
| `maxCapacity` | `floatish` | PartitionQueueCapacitiesInfo.java:38 |
| `absoluteCapacity` | `floatish` | PartitionQueueCapacitiesInfo.java:39 |
| `absoluteUsedCapacity` | `floatish` | PartitionQueueCapacitiesInfo.java:40 |
| `absoluteMaxCapacity` | `floatish` | PartitionQueueCapacitiesInfo.java:41 |
| `maxAMLimitPercentage` | `floatish.optional()` | PartitionQueueCapacitiesInfo.java:42 |
| `weight` | `floatish.optional()` | PartitionQueueCapacitiesInfo.java:43 |
| `normalizedWeight` | `floatish.optional()` | PartitionQueueCapacitiesInfo.java:44 |
| `configuredMinResource` | `ResourceInfoSchema.optional()` | PartitionQueueCapacitiesInfo.java:45 |
| `configuredMaxResource` | `ResourceInfoSchema.optional()` | PartitionQueueCapacitiesInfo.java:46 |
| `effectiveMinResource` | `ResourceInfoSchema.optional()` | PartitionQueueCapacitiesInfo.java:47 |
| `effectiveMaxResource` | `ResourceInfoSchema.optional()` | PartitionQueueCapacitiesInfo.java:48 |

## queue.capacities — `QueueCapacitiesSchema` (queue.ts) root `capacities`

| jsonPath | zod type | DAO source |
|---|---|---|
| `queueCapacitiesByPartition` | `list(PartitionCapacitySchema)` | QueueCapacitiesInfo.java:38 |

## queue.acl — `QueueAclSchema` (queue.ts) root `queueAcls.queueAcl[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `accessType` | `z.string()` | QueueAclInfo.java:29 |
| `accessControlList` | `z.string()` | QueueAclInfo.java:30 |

## queue.template.confItem — `ConfItemSchema` (queue.ts) root `…property[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `name` | `z.string()` | LeafQueueTemplateInfo.java:49 |
| `value` | `z.string().optional()` | LeafQueueTemplateInfo.java:72 |

## queue.user — `UserInfoSchema` (queue.ts) root `users.user[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `username` | `z.string()` | UserInfo.java:33 |
| `resourcesUsed` | `ResourceInfoSchema.optional()` | UserInfo.java:34 |
| `numPendingApplications` | `num` | UserInfo.java:35 |
| `numActiveApplications` | `num` | UserInfo.java:36 |
| `AMResourceUsed` | `ResourceInfoSchema.optional()` | UserInfo.java:37 |
| `userResourceLimit` | `ResourceInfoSchema.optional()` | UserInfo.java:38 |
| `resources` | `ResourcesInfoSchema.optional()` | UserInfo.java:39 |
| `userWeight` | `floatish.optional()` | UserInfo.java:40 |
| `isActive` | `z.boolean().optional()` | UserInfo.java:41 |

## queue — `QueueInfoSchema` (queue.ts) root `queues.queue[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `type` | `z.string().optional()` | Jersey xsi:type (leaf: `capacitySchedulerLeafQueueInfo`) |
| `queuePath` | `z.string().optional()` | CapacitySchedulerQueueInfo.java:53 |
| `capacity` | `floatish` | CapacitySchedulerQueueInfo.java:54 |
| `usedCapacity` | `floatish` | CapacitySchedulerQueueInfo.java:55 |
| `maxCapacity` | `floatish` | CapacitySchedulerQueueInfo.java:56 |
| `absoluteCapacity` | `floatish` | CapacitySchedulerQueueInfo.java:57 |
| `absoluteMaxCapacity` | `floatish` | CapacitySchedulerQueueInfo.java:58 |
| `absoluteUsedCapacity` | `floatish` | CapacitySchedulerQueueInfo.java:59 |
| `weight` | `floatish.optional()` | CapacitySchedulerQueueInfo.java:60 |
| `normalizedWeight` | `floatish.optional()` | CapacitySchedulerQueueInfo.java:61 |
| `numApplications` | `num` | CapacitySchedulerQueueInfo.java:62 |
| `maxParallelApps` | `num.optional()` | CapacitySchedulerQueueInfo.java:63 |
| `queueName` | `z.string()` | CapacitySchedulerQueueInfo.java:64 |
| `isAbsoluteResource` | `z.boolean().optional()` | CapacitySchedulerQueueInfo.java:65 |
| `state` | `z.string().optional()` | CapacitySchedulerQueueInfo.java:66 |
| `queues` | `lazy (recursive)` | CapacitySchedulerQueueInfo.java:67 |
| `resourcesUsed` | `ResourceInfoSchema.optional()` | CapacitySchedulerQueueInfo.java:68 |
| `hideReservationQueues` | `z.boolean().optional()` | CapacitySchedulerQueueInfo.java:69 |
| `nodeLabels` | `list(z.string())` | CapacitySchedulerQueueInfo.java:70 |
| `allocatedContainers` | `num.optional()` | CapacitySchedulerQueueInfo.java:71 |
| `reservedContainers` | `num.optional()` | CapacitySchedulerQueueInfo.java:72 |
| `pendingContainers` | `num.optional()` | CapacitySchedulerQueueInfo.java:73 |
| `capacities` | `QueueCapacitiesSchema.optional()` | CapacitySchedulerQueueInfo.java:74 |
| `resources` | `ResourcesInfoSchema.optional()` | CapacitySchedulerQueueInfo.java:75 |
| `minEffectiveCapacity` | `ResourceInfoSchema.optional()` | CapacitySchedulerQueueInfo.java:76 |
| `maxEffectiveCapacity` | `ResourceInfoSchema.optional()` | CapacitySchedulerQueueInfo.java:77 |
| `maximumAllocation` | `ResourceInfoSchema.optional()` | CapacitySchedulerQueueInfo.java:78 |
| `queueAcls` | `QueueAclsSchema.optional()` | CapacitySchedulerQueueInfo.java:79 |
| `queuePriority` | `num.optional()` | CapacitySchedulerQueueInfo.java:80 |
| `orderingPolicyInfo` | `z.string().optional()` | CapacitySchedulerQueueInfo.java:81 |
| `autoCreateChildQueueEnabled` | `z.boolean().optional()` | CapacitySchedulerQueueInfo.java:82 |
| `leafQueueTemplate` | `QueueTemplatePropertiesSchema.optional()` | CapacitySchedulerQueueInfo.java:83 |
| `mode` | `z.string().optional()` | CapacitySchedulerQueueInfo.java:84 |
| `queueType` | `z.string().optional()` | CapacitySchedulerQueueInfo.java:85 |
| `creationMethod` | `z.string().optional()` | CapacitySchedulerQueueInfo.java:86 |
| `autoCreationEligibility` | `z.string().optional()` | CapacitySchedulerQueueInfo.java:87 |
| `defaultNodeLabelExpression` | `z.string().optional()` | CapacitySchedulerQueueInfo.java:88 |
| `autoQueueTemplateProperties` | `QueueTemplatePropertiesSchema.optional()` | CapacitySchedulerQueueInfo.java:89 |
| `autoQueueParentTemplateProperties` | `QueueTemplatePropertiesSchema.optional()` | CapacitySchedulerQueueInfo.java:91 |
| `autoQueueLeafTemplateProperties` | `QueueTemplatePropertiesSchema.optional()` | CapacitySchedulerQueueInfo.java:93 |
| `numActiveApplications` | `num.optional()` | CapacitySchedulerLeafQueueInfo.java:40 |
| `numPendingApplications` | `num.optional()` | CapacitySchedulerLeafQueueInfo.java:41 |
| `numContainers` | `num.optional()` | CapacitySchedulerLeafQueueInfo.java:42 |
| `maxApplications` | `num.optional()` | CapacitySchedulerLeafQueueInfo.java:43 |
| `maxApplicationsPerUser` | `num.optional()` | CapacitySchedulerLeafQueueInfo.java:44 |
| `userLimit` | `floatish.optional()` | CapacitySchedulerLeafQueueInfo.java:45 |
| `users` | `QueueUsersSchema.optional()` | CapacitySchedulerLeafQueueInfo.java:46 |
| `userLimitFactor` | `floatish.optional()` | CapacitySchedulerLeafQueueInfo.java:47 |
| `configuredMaxAMResourceLimit` | `floatish.optional()` | CapacitySchedulerLeafQueueInfo.java:48 |
| `AMResourceLimit` | `ResourceInfoSchema.optional()` | CapacitySchedulerLeafQueueInfo.java:49 |
| `usedAMResource` | `ResourceInfoSchema.optional()` | CapacitySchedulerLeafQueueInfo.java:50 |
| `userAMResourceLimit` | `ResourceInfoSchema.optional()` | CapacitySchedulerLeafQueueInfo.java:51 |
| `preemptionDisabled` | `z.boolean().optional()` | CapacitySchedulerLeafQueueInfo.java:52 |
| `intraQueuePreemptionDisabled` | `z.boolean().optional()` | CapacitySchedulerLeafQueueInfo.java:53 |
| `defaultPriority` | `num.optional()` | CapacitySchedulerLeafQueueInfo.java:54 |
| `isAutoCreatedLeafQueue` | `z.boolean().optional()` | CapacitySchedulerLeafQueueInfo.java:55 |
| `maxApplicationLifetime` | `num.optional()` | CapacitySchedulerLeafQueueInfo.java:56 |
| `defaultApplicationLifetime` | `num.optional()` | CapacitySchedulerLeafQueueInfo.java:57 |

## resource.information — `ResourceInformationSchema` (resource.ts) root `resourceInformation[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `name` | `z.string()` | ResourceInformation.java:38 |
| `resourceType` | `z.string().optional()` | ResourceInformation.java:40 |
| `units` | `z.string().optional()` | ResourceInformation.java:39 |
| `value` | `num` | ResourceInformation.java:41 |
| `minimumAllocation` | `num.optional()` | ResourceInformation.java:42 |
| `maximumAllocation` | `num.optional()` | ResourceInformation.java:43 |
| `tags` | `list(z.string())` | ResourceInformation.java:44 |
| `attributes` | `entryMap(z.string()).optional()` | ResourceInformation.java:45 |

## resource.informations — `ResourceInformationsSchema` (resource.ts) root `resourceInformations`

| jsonPath | zod type | DAO source |
|---|---|---|
| `resourceInformation` | `list(ResourceInformationSchema)` | ResourceInformationsInfo.java:35 |

## resource.info — `ResourceInfoSchema` (resource.ts) root `resourceInfo`

| jsonPath | zod type | DAO source |
|---|---|---|
| `memory` | `num` | ResourceInfo.java:35 |
| `vCores` | `num` | ResourceInfo.java:37 |
| `resourceInformations` | `ResourceInformationsSchema.optional()` | ResourceInfo.java:39 |

## resource.partition — `PartitionResourcesInfoSchema` (resource.ts) root `resourceUsagesByPartition[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `partitionName` | `z.string().optional()` | PartitionResourcesInfo.java:30 |
| `used` | `ResourceInfoSchema.optional()` | PartitionResourcesInfo.java:31 |
| `reserved` | `ResourceInfoSchema.optional()` | PartitionResourcesInfo.java:32 |
| `pending` | `ResourceInfoSchema.optional()` | PartitionResourcesInfo.java:33 |
| `amUsed` | `ResourceInfoSchema.optional()` | PartitionResourcesInfo.java:34 |
| `amLimit` | `ResourceInfoSchema.optional()` | PartitionResourcesInfo.java:35 |
| `userAmLimit` | `ResourceInfoSchema.optional()` | PartitionResourcesInfo.java:36 |

## resource.usages — `ResourcesInfoSchema` (resource.ts) root `resources`

| jsonPath | zod type | DAO source |
|---|---|---|
| `resourceUsagesByPartition` | `list(PartitionResourcesInfoSchema)` | ResourcesInfo.java:35 |

## node.resourceUtilization — `ResourceUtilizationSchema` (resource.ts) root `resourceUtilization`

| jsonPath | zod type | DAO source |
|---|---|---|
| `nodePhysicalMemoryMB` | `num` | ResourceUtilizationInfo.java:35 |
| `nodeVirtualMemoryMB` | `num` | ResourceUtilizationInfo.java:36 |
| `nodeCPUUsage` | `num` | ResourceUtilizationInfo.java:37 |
| `aggregatedContainersPhysicalMemoryMB` | `num` | ResourceUtilizationInfo.java:38 |
| `aggregatedContainersVirtualMemoryMB` | `num` | ResourceUtilizationInfo.java:39 |
| `containersCPUUsage` | `num` | ResourceUtilizationInfo.java:40 |

## scheduler.health.operation — `SchedulerHealthOperationSchema` (scheduler.ts) root `health.operationsInfo[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `operation` | `z.string()` | CapacitySchedulerHealthInfo.java:35 |
| `nodeId` | `z.string().optional()` | CapacitySchedulerHealthInfo.java:36 |
| `containerId` | `z.string().optional()` | CapacitySchedulerHealthInfo.java:37 |
| `queue` | `z.string().optional()` | CapacitySchedulerHealthInfo.java:38 |

## scheduler.health.lastRun — `SchedulerHealthRunDetailsSchema` (scheduler.ts) root `health.lastRunDetails[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `operation` | `z.string()` | CapacitySchedulerHealthInfo.java:35 |
| `count` | `num` | CapacitySchedulerHealthInfo.java:72 |
| `resources` | `ResourceInfoSchema.optional()` | CapacitySchedulerHealthInfo.java:73 |

## scheduler.health — `SchedulerHealthSchema` (scheduler.ts) root `health`

| jsonPath | zod type | DAO source |
|---|---|---|
| `lastrun` | `num` | CapacitySchedulerHealthInfo.java:97 |
| `operationsInfo` | `list(SchedulerHealthOperationSchema)` | CapacitySchedulerHealthInfo.java:98 |
| `lastRunDetails` | `list(SchedulerHealthRunDetailsSchema)` | CapacitySchedulerHealthInfo.java:99 |

## scheduler.capacity — `CapacitySchedulerInfoSchema` (scheduler.ts) root `scheduler.schedulerInfo`

| jsonPath | zod type | DAO source |
|---|---|---|
| `type` | `z.literal("capacityScheduler")` | Jersey xsi:type from `@XmlType(name="capacityScheduler")` (CapacitySchedulerInfo.java) |
| `capacity` | `floatish` | CapacitySchedulerInfo.java:46 |
| `usedCapacity` | `floatish` | CapacitySchedulerInfo.java:47 |
| `maxCapacity` | `floatish` | CapacitySchedulerInfo.java:48 |
| `weight` | `floatish.optional()` | CapacitySchedulerInfo.java:49 |
| `normalizedWeight` | `floatish.optional()` | CapacitySchedulerInfo.java:50 |
| `queueCapacityVectorInfo` | `QueueCapacityVectorSchema.optional()` | CapacitySchedulerInfo.java:51 |
| `queueName` | `z.string()` | CapacitySchedulerInfo.java:52 |
| `queuePath` | `z.string().optional()` | CapacitySchedulerInfo.java:53 |
| `maxParallelApps` | `num.optional()` | CapacitySchedulerInfo.java:54 |
| `isAbsoluteResource` | `z.boolean().optional()` | CapacitySchedulerInfo.java:55 |
| `queues` | `obj({ queue: list(QueueInfoSchema) }).optional()` | CapacitySchedulerInfo.java:56 |
| `capacities` | `QueueCapacitiesSchema.optional()` | CapacitySchedulerInfo.java:57 |
| `health` | `SchedulerHealthSchema.optional()` | CapacitySchedulerInfo.java:58 |
| `maximumAllocation` | `ResourceInfoSchema.optional()` | CapacitySchedulerInfo.java:59 |
| `queueAcls` | `QueueAclsSchema.optional()` | CapacitySchedulerInfo.java:60 |
| `queuePriority` | `num.optional()` | CapacitySchedulerInfo.java:61 |
| `orderingPolicyInfo` | `z.string().optional()` | CapacitySchedulerInfo.java:62 |
| `mode` | `z.string().optional()` | CapacitySchedulerInfo.java:63 |
| `queueType` | `z.string().optional()` | CapacitySchedulerInfo.java:64 |
| `creationMethod` | `z.string().optional()` | CapacitySchedulerInfo.java:65 |
| `autoCreationEligibility` | `z.string().optional()` | CapacitySchedulerInfo.java:66 |
| `defaultNodeLabelExpression` | `z.string().optional()` | CapacitySchedulerInfo.java:67 |
| `autoQueueTemplateProperties` | `QueueTemplatePropertiesSchema.optional()` | CapacitySchedulerInfo.java:68 |
| `autoQueueParentTemplateProperties` | `QueueTemplatePropertiesSchema.optional()` | CapacitySchedulerInfo.java:69 |
| `autoQueueLeafTemplateProperties` | `QueueTemplatePropertiesSchema.optional()` | CapacitySchedulerInfo.java:70 |

## scheduler.fair.queue — `FairQueueInfoSchema` (scheduler.ts) root `rootQueue / childQueues.queue[]`

| jsonPath | zod type | DAO source |
|---|---|---|
| `type` | `z.string().optional()` | Jersey xsi:type (leaf: `fairSchedulerLeafQueueInfo`) |
| `maxApps` | `num` | FairSchedulerQueueInfo.java:40 |
| `minResources` | `ResourceInfoSchema` | FairSchedulerQueueInfo.java:51 |
| `maxResources` | `ResourceInfoSchema` | FairSchedulerQueueInfo.java:52 |
| `usedResources` | `ResourceInfoSchema` | FairSchedulerQueueInfo.java:53 |
| `amUsedResources` | `ResourceInfoSchema.optional()` | FairSchedulerQueueInfo.java:54 |
| `amMaxResources` | `ResourceInfoSchema.optional()` | FairSchedulerQueueInfo.java:55 |
| `demandResources` | `ResourceInfoSchema` | FairSchedulerQueueInfo.java:56 |
| `steadyFairResources` | `ResourceInfoSchema` | FairSchedulerQueueInfo.java:57 |
| `fairResources` | `ResourceInfoSchema` | FairSchedulerQueueInfo.java:58 |
| `clusterResources` | `ResourceInfoSchema` | FairSchedulerQueueInfo.java:59 |
| `reservedResources` | `ResourceInfoSchema.optional()` | FairSchedulerQueueInfo.java:60 |
| `maxContainerAllocation` | `ResourceInfoSchema.optional()` | FairSchedulerQueueInfo.java:61 |
| `pendingContainers` | `num` | FairSchedulerQueueInfo.java:63 |
| `allocatedContainers` | `num` | FairSchedulerQueueInfo.java:64 |
| `reservedContainers` | `num` | FairSchedulerQueueInfo.java:65 |
| `queueName` | `z.string()` | FairSchedulerQueueInfo.java:67 |
| `schedulingPolicy` | `z.string()` | FairSchedulerQueueInfo.java:68 |
| `preemptable` | `z.boolean()` | FairSchedulerQueueInfo.java:70 |
| `childQueues` | `lazy (recursive)` | FairSchedulerQueueInfo.java:72 |
| `numPendingApps` | `num.optional()` | FairSchedulerLeafQueueInfo.java:32 |
| `numActiveApps` | `num.optional()` | FairSchedulerLeafQueueInfo.java:33 |

## scheduler.fair — `FairSchedulerInfoSchema` (scheduler.ts) root `scheduler.schedulerInfo`

| jsonPath | zod type | DAO source |
|---|---|---|
| `type` | `z.literal("fairScheduler")` | Jersey xsi:type from `@XmlType(name="fairScheduler")` (FairSchedulerInfo.java) |
| `rootQueue` | `FairQueueInfoSchema` | FairSchedulerInfo.java:36 |

## scheduler.fifo — `FifoSchedulerInfoSchema` (scheduler.ts) root `scheduler.schedulerInfo`

| jsonPath | zod type | DAO source |
|---|---|---|
| `type` | `z.literal("fifoScheduler")` | Jersey xsi:type from `@XmlType(name="fifoScheduler")` (FifoSchedulerInfo.java) |
| `capacity` | `floatish` | FifoSchedulerInfo.java:40 |
| `usedCapacity` | `floatish` | FifoSchedulerInfo.java:41 |
| `qstate` | `z.string().optional()` | FifoSchedulerInfo.java:42 |
| `minQueueMemoryCapacity` | `num` | FifoSchedulerInfo.java:43 |
| `maxQueueMemoryCapacity` | `num` | FifoSchedulerInfo.java:44 |
| `numNodes` | `num` | FifoSchedulerInfo.java:45 |
| `usedNodeCapacity` | `num` | FifoSchedulerInfo.java:46 |
| `availNodeCapacity` | `num` | FifoSchedulerInfo.java:47 |
| `totalNodeCapacity` | `num` | FifoSchedulerInfo.java:48 |
| `numContainers` | `num` | FifoSchedulerInfo.java:49 |

## Entities defined on one line (no table above)

| entity / schema | jsonPath | zod type | DAO source |
|---|---|---|---|
| app.timeouts `AppTimeoutsInfoSchema` | `timeout[]` | `list(AppTimeoutInfoSchema)` | AppTimeoutsInfo.java:34 |
| app.priority `AppPriorityResponseSchema` | `priority` | `num` | AppPriority.java |
| app.queue `AppQueueResponseSchema` | `queue` | `z.string()` | AppQueue.java |
| nodelabel.list `NodeLabelsInfoSchema` | `nodeLabelInfo[]` | `list(NodeLabelSchema)` | NodeLabelsInfo.java:34 |
| nodelabel `NodeLabelSchema` | `activeNMs` (NOT `numActiveNMs`) | `num.optional()` | NodeLabelInfo.java:34 |
| nodelabel.nodeIds `NodeIDsInfoSchema` | `nodes[]`, `partitionInfo` | `list(string)`, `PartitionInfoSchema?` | NodeIDsInfo.java (`@XmlElement(name="nodes")`) |
| nodelabel.partitionInfo `PartitionInfoSchema` | `resourceAvailable` | `ResourceInfoSchema?` | PartitionInfo.java:37 |
| node.toLabels `NodeToLabelsResponseSchema` | `nodeToLabels` (entry map host:port → `{nodeLabelInfo[]}`) | `entryMap(NodeLabelsInfoSchema)?` | NodeToLabelsInfo.java |
| nodelabel.mappings `LabelMappingsResponseSchema` | `labelsToNodes.entry[].{key:NodeLabel, value:NodeIDsInfo}` | `list(LabelMappingEntrySchema)` | LabelsToNodesInfo.java |
| scheduler envelope `SchedulerResponseSchema` | `scheduler.schedulerInfo`, `scheduler.subClusterId?` | union on `type` | SchedulerTypeInfo.java |
| scheduler `SchedulerInfo` base fields (`schedulerName`, `minAllocResource`, …) | — | NOT serialised | SchedulerInfo.java has no `@XmlAccessorType(FIELD)`, protected fields + getter-only properties are skipped by JAXB (confirmed absent in the 3.4 docs sample) |
| meta `MetaSchema` | whole shape | see meta.ts | docs/contracts/api.md §2 (synthesized) |
| errors `ApiErrorEnvelopeSchema` / `RemoteExceptionSchema` | `error.{code,message,upstream?,hint?}` / `RemoteException.{exception,message,javaClassName}` | see errors.ts | api.md §1 / RemoteExceptionData.java:30-32 |
| daemon.jmx `JmxResponseSchema` | `beans[].{name, modelerType?, …open}` | `z.looseObject` (deliberate) | JMXJsonServlet.java:242,303,305 |
| daemon.logs `RmLogsListingSchema` | `files[].{name,size,lastModified}` | ASSUMPTION | synthesized by Rust backend |
| user-info `ClusterUserInfoSchema` | `rmLoginUser?`, `requestedUser?`, `subClusterId?` | strings | ClusterUserInfo.java |
| resource-types / resource-profiles | — | ASSUMPTION | no DAO in 3.4.3 RM REST (endpoints answer 404 upstream) |

## Wire-format notes

- Registered in `JAXBContextResolver` (natural JSON, wrapped root, real numbers): AppInfo, AppAttemptInfo(s), ClusterInfo, ClusterMetricsInfo, NodeInfo/NodesInfo, scheduler infos, ResourceInfo, UsersInfo/UserInfo, AppTimeout(s)Info, ApplicationStatisticsInfo, Activities infos, QueueAclsInfo.
- NOT registered (Jersey default "mapped": numbers/booleans possibly quoted, root maybe unwrapped, Map → `{entry:[{key,value}]}`): `server.webapp.dao.ContainerInfo/ContainersInfo`, NodeLabelsInfo, NodeToLabelsInfo, LabelsToNodesInfo, AppState/AppQueue/AppPriority, ConfInfo (scheduler-conf), ClusterUserInfo. Schemas for these accept both shapes (`num`, `boolish`, `entryMap`, wrapped|unwrapped unions).
- `Map<String,Long>` (`resourceSecondsMap`, `preemptedResourceSecondsMap`, container `allocatedResources`) and `Map<String,String>` (`ResourceInformation.attributes`) are normalised by `entryMap` to plain records.
- Empty collections: `{"apps":null}`, `{"nodes":null}`, `users:{}`, missing list keys → `[]` via `list()`.
- FIFO `usedCapacity` can be the string `"NaN"` → `floatish`.

## attempt (single) — `AppAttemptDetailSchema` (app-attempt.ts) root `` (`GET /apps/{id}/appattempts/{attemptId}`)

| jsonPath | zod type | DAO source |
|---|---|---|
| `appAttemptId` | `z.string()` | webapp AppAttemptInfo (verified live, RM 3.4.3) |
| `host` | `z.string().optional()` | webapp AppAttemptInfo (`"N/A"` before the AM registers) |
| `rpcPort` | `num.optional()` | webapp AppAttemptInfo (`-1` before the AM registers) |
| `trackingUrl` | `z.string().optional()` | webapp AppAttemptInfo |
| `originalTrackingUrl` | `z.string().optional()` | webapp AppAttemptInfo |
| `diagnosticsInfo` | `z.string().optional()` | webapp AppAttemptInfo |
| `appAttemptState` | `z.string()` | webapp AppAttemptInfo |
| `amContainerId` | `z.string().optional()` | webapp AppAttemptInfo |
| `startedTime` | `num.optional()` | webapp AppAttemptInfo |
| `finishedTime` | `num.optional()` | webapp AppAttemptInfo |

## spark.sql.metrics — frontend-minted (`features/dag/react/chrome.tsx` + `features/dag/sql-plan.ts`)

The SQL-plan drawer stamps an operator's plan accumulables. They come from the Spark SQL execution payload
(`nodes[].metrics[].{name,value}`, carried onto `GraphNode.metrics` by `buildSqlPlanGraph`), but no REST field id or
legacy page owns them: the drawer mints one positional id pair per list entry so the parity harness can see the rows.
Ids are positional (`[<i>]` = the index in `SqlPlanNode.metrics`), never a stage id, and `data-yv` carries the raw
upstream string verbatim.

| jsonPath | zod type | source |
|---|---|---|
| `spark.sql.metrics[<i>].name` | `z.string()` | `SqlPlanNode.metrics[i].name` |
| `spark.sql.metrics[<i>].value` | `z.string()` | `SqlPlanNode.metrics[i].value` |
