#!/usr/bin/env python3
"""Generates parity/inventory/src/rest-rm.yaml (ResourceManager REST object model).

Run:  .venv/bin/python parity/inventory/tools/gen_rest_rm.py

Sources of truth, in order:
1. the DAO Java sources (rest_rm_objects.collect_objects() -> fields/type/ref/values/source), and
2. live-verified JSON of the running Hadoop 3.4.3 RM at http://127.0.0.1:8088 (2026-10-03), recorded below as
   WRAPPED / UNWRAPPED and in the per-object notes.  Where live evidence and the extractor disagree, the note says so.

JSON wrapping rules (live-verified, RMWebServices + JAXBContextResolver.java:63-133):
  * classes listed in JAXBContextResolver's `cTypes` are WRAPPED in their @XmlRootElement name and keep native
    JSON types (`{"apps":{"app":[...]}}`, `{"clusterMetrics":{"appsSubmitted":2,...}}`);
  * classes listed in `rootUnwrappedTypes` are root-UNWRAPPED: the properties sit at the top level and keep native
    types (`{"priority":0}`);
  * every other class falls back to Jersey's default JAXB JSON provider: root-UNWRAPPED *and* all scalars are
    STRINGIFIED (`{"nodeLabelInfo":[{"name":"ssd","exclusivity":"false",...}]}`, `{"allocatedMB":"768"}`), with
    single-element collections collapsing to a bare element (`/nodes/x/get-labels` with one label).
  * JAXB omits null properties entirely; `-1` is used as an "unavailable" sentinel by several DAOs.
Values in `unit` are inferred from the Java field name/type (documented rule below) and overridden per field where
verified.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from invlib import *          # noqa: F401,F403
import rest_rm_objects as O   # noqa: E402

RMW = 'hadoop-yarn-server-resourcemanager/org/apache/hadoop/yarn/server/resourcemanager/webapp/'
SRVW = 'hadoop-yarn-server-common/org/apache/hadoop/yarn/server/webapp/'
YCW = 'hadoop-yarn-common/org/apache/hadoop/yarn/webapp/'
HC = 'hadoop-common/org/apache/hadoop/'
RWS = RMW + 'RMWebServices.java'
RESOLVER = RMW + 'JAXBContextResolver.java'

PROD = ['application/json; charset=utf-8', 'application/xml; charset=utf-8']

# --------------------------------------------------------------------------- JAXB contexts
# JAXBContextResolver.java:63-133 (cTypes)
WRAPPED = set("""AppInfo AppAttemptInfo AppAttemptsInfo ClusterInfo CapacitySchedulerQueueInfo FifoSchedulerInfo
SchedulerTypeInfo NodeInfo UserMetricsInfo CapacitySchedulerInfo ClusterMetricsInfo SchedulerInfo AppsInfo NodesInfo
RemoteException CapacitySchedulerQueueInfoList ResourceInfo UsersInfo UserInfo ApplicationStatisticsInfo
StatisticsItemInfo CapacitySchedulerHealthInfo FairSchedulerQueueInfoList AppTimeoutsInfo AppTimeoutInfo
ResourceInformationsInfo ActivitiesInfo AppActivitiesInfo QueueAclsInfo QueueAclInfo BulkActivitiesInfo""".split())
# JAXBContextResolver.java:94-98 (rootUnwrappedTypes)
UNWRAPPED = set("""NewApplication ApplicationSubmissionContextInfo ContainerLaunchContextInfo LocalResourceInfo
DelegationToken AppQueue AppPriority ResourceOptionInfo""".split())

# --------------------------------------------------------------------------- units
PERCENT = {
    'progress', 'clusterUsagePercentage', 'queueUsagePercentage', 'usedCapacity', 'capacity', 'maxCapacity',
    'absoluteCapacity', 'absoluteMaxCapacity', 'absoluteUsedCapacity', 'weight', 'normalizedWeight', 'userLimit',
    'userLimitFactor', 'configuredMaxAMResourceLimit', 'memUtilization', 'cpuUtilization', 'nodeCPUUsage',
    'containersCPUUsage', 'overallGpuUtilization', 'maxAMLimitPercentage', 'utilizedMBPercent',
    'utilizedVirtualCoresPercent', 'rmSchedulerBusyPercent', 'schedulerBusy', 'userWeight',
}
EPOCH_MS = {
    'startStartedTime', 'startedTime', 'startTime', 'finishedTime', 'launchTime', 'lastHealthUpdate', 'timestamp',
    'startedOn', 'lastrun', 'acceptance-time',
}
DURATION_MS = {'elapsedTime', 'maxApplicationLifetime', 'defaultApplicationLifetime'}
COUNT = {
    'numContainers', 'numApplications', 'numNodes', 'numActiveApplications', 'numPendingApplications',
    'numQueuedContainers', 'numRunningOpportContainers', 'numActiveApps', 'numPendingApps', 'count',
    'allocationsCount', 'numAMContainerPreempted', 'numNonAMContainerPreempted', 'containersAllocated',
    'containersPending', 'containersReserved', 'runningContainers', 'pendingContainers', 'reservedContainers',
    'allocatedContainers', 'totalAllocatedContainersAcrossPartition', 'maxApps', 'maxApplications',
    'maxApplicationsPerUser', 'maxParallelApps', 'applicationPriority', 'maximumClusterPriority', 'queuePriority',
    'priority', 'requestPriority', 'appPriority', 'activeNMs', 'lostNodes', 'unhealthyNodes', 'decommissioningNodes',
    'decommissionedNodes', 'rebootedNodes', 'activeNodes', 'shutdownNodes', 'totalNodes', 'rmEventQueueSize',
    'schedulerEventQueueSize', 'rmDispatcherEventQueueSize', 'schedulerDispatcherEventQueueSize', 'usedNodeCapacity',
    'availNodeCapacity', 'totalNodeCapacity', 'availableVirtualCores', 'rpcPort',
}
UNIT_OVERRIDE = {
    ('AppTimeoutInfo', 'expiryTime'): '',
    ('AppInfo', 'amRPCAddress'): '',
    ('ClusterInfo', 'id'): 'epoch-ms',
    ('NodeInfo', 'usedMemoryOpportGB'): 'GB',
    ('FifoSchedulerInfo', 'minQueueMemoryCapacity'): 'MB',
    ('FifoSchedulerInfo', 'maxQueueMemoryCapacity'): 'MB',
    ('CapacitySchedulerLeafQueueInfo', 'maxApplicationLifetime'): 'ms',
    ('ResourceInformation', 'value'): '',
    ('ResourceInformation', 'minimumAllocation'): '',
    ('ResourceInformation', 'maximumAllocation'): '',
    ('ResourceUtilizationInfo', 'nodePhysicalMemoryMB'): 'MB',
    ('ResourceUtilizationInfo', 'nodeVirtualMemoryMB'): 'MB',
    ('ResourceUtilizationInfo', 'aggregatedContainersPhysicalMemoryMB'): 'MB',
    ('ResourceUtilizationInfo', 'aggregatedContainersVirtualMemoryMB'): 'MB',
}


def unit_of(obj, name):
    if (obj, name) in UNIT_OVERRIDE:
        return UNIT_OVERRIDE[(obj, name)]
    if name in PERCENT:
        return 'percent'
    if name == 'memory':
        return 'MB'
    if name.endswith('MB'):
        return 'MB'
    if name.endswith('GB'):
        return 'GB'
    if name.endswith('Percent') or name.endswith('Percentage'):
        return 'percent'
    if name.endswith('VirtualCores') or name.endswith('VCores') or name.endswith('vCores'):
        return 'count'
    if name in COUNT:
        return 'count'
    if name in EPOCH_MS:
        return 'epoch-ms'
    if name in DURATION_MS:
        return 'ms'
    if name == 'remainingTimeInSeconds':
        return 'seconds'
    if name == 'containerAssignedPerSecond':
        return 'count/s'
    if name == 'memorySeconds' or name == 'preemptedMemorySeconds':
        return 'MB-seconds'
    if name == 'vcoreSeconds' or name == 'preemptedVcoreSeconds':
        return 'vcore-seconds'
    return ''


# --------------------------------------------------------------------------- per-field knowledge
def FM(**kw):
    return kw


FIELD_META = {
    ('ClusterInfo', 'id'): FM(note='ResourceManager.getClusterTimeStamp(): epoch ms of RM start, printed raw by the legacy About page (NOT date formatted).'),
    ('ClusterInfo', 'state'): FM(note='Service.STATE enum name; a running RM reports STARTED.'),
    ('ClusterInfo', 'haState'): FM(note='HAServiceState; a non-HA RM reports ACTIVE.'),
    ('ClusterInfo', 'subClusterId'): FM(nullable=True, note='omitted from JSON when null (non-federated RM) - live-verified absent.'),
    ('ClusterInfo', 'haZooKeeperConnectionState'): FM(note='free text, e.g. "Could not find leader elector. Verify both HA and automatic failover are enabled."'),
    ('ClusterInfo', 'startedOn'): FM(note='epoch ms; legacy About renders Times.format().'),
    ('ClusterMetricsInfo', 'utilizedMBPercent'): FM(note='int percent that can exceed 100 when the cluster is over-committed (live: 150 with 3072 MB total and 4608 MB allocated).'),
    ('ClusterMetricsInfo', 'totalUsedResourcesAcrossPartition'): FM(nullable=False, note='cross-partition metrics; legacy MetricsOverviewTable prefers these over allocatedMB/allocatedVirtualCores when crossPartitionMetricsAvailable.'),
    ('ClusterMetricsInfo', 'totalClusterResourcesAcrossPartition'): FM(note='cross-partition metrics; see note on totalUsedResourcesAcrossPartition.'),
    ('ClusterMetricsInfo', 'totalReservedResourcesAcrossPartition'): FM(note='cross-partition metrics; see note on totalUsedResourcesAcrossPartition.'),
    ('ClusterMetricsInfo', 'crossPartitionMetricsAvailable'): FM(note='false when the scheduler does not aggregate per-partition resources; legacy then falls back to allocatedMB/allocatedVirtualCores.'),
    ('ClusterUserInfo', 'rmLoginUser'): FM(note='RM process login user.'),
    ('ClusterUserInfo', 'requestedUser'): FM(note='UGI of the caller; unauthenticated RM shows dr.who (StaticUserWebFilter). Live: rmLoginUser=puppyseal, requestedUser=dr.who.'),
    ('ClusterUserInfo', 'subClusterId'): FM(nullable=True, note='omitted when null.'),
    ('AppInfo', 'state'): FM(note='YarnApplicationState.'),
    ('AppInfo', 'finalStatus'): FM(note='FinalApplicationStatus: UNDEFINED|SUCCEEDED|FAILED|KILLED. UNDEFINED while the app is not finished.'),
    ('AppInfo', 'progress'): FM(note='0.0-100.0; legacy renders StringUtils.formatPercent(progress, 1) with a trailing %. -1 is not used here.'),
    ('AppInfo', 'trackingUI'): FM(note='UNASSIGNED|ApplicationMaster|History (upper-case in REST); the legacy table prints "Unassigned"/"ApplicationMaster"/"History".'),
    ('AppInfo', 'allocatedMB'): FM(note='-1 for a finished application (legacy then prints N/A); live-verified -1 on FINISHED app.'),
    ('AppInfo', 'allocatedVCores'): FM(note='-1 for a finished application.'),
    ('AppInfo', 'reservedMB'): FM(note='-1 for a finished application.'),
    ('AppInfo', 'reservedVCores'): FM(note='-1 for a finished application.'),
    ('AppInfo', 'runningContainers'): FM(note='-1 for a finished application.'),
    ('AppInfo', 'rmClusterId'): FM(nullable=True, note='not present in live AppInfo JSON on Hadoop 3.4.3 (extractor lists the Java field); treat as absent unless observed. [INFERENCE]'),
    ('AppInfo', 'resourceSecondsMap'): FM(note='JAXB Map via adapter: N entries serialise as {"entry":[{"key":..,"value":..}]}; a SINGLE entry collapses to {"entry":{"key":..,"value":..}} (live-verified).'),
    ('AppInfo', 'preemptedResourceSecondsMap'): FM(note='same single-entry map collapse as resourceSecondsMap.'),
    ('AppInfo', 'applicationTags'): FM(note='comma-separated; empty string when no tags.'),
    ('AppInfo', 'logAggregationStatus'): FM(note='LogAggregationStatus enum'),
    ('AppInfo', 'timeouts'): FM(note='AppTimeoutsInfo; live shows one LIFETIME timeout with expiryTime "UNLIMITED" and remainingTimeInSeconds -1 when unset.'),
    ('AppInfo', 'resourceInfo'): FM(note='per-partition resource usage; capacity/fair only.'),
    ('AppAttemptInfo', 'exportPorts'): FM(note='live value is the STRING "null" for attempts without exported ports.'),
    ('AppAttemptInfo', 'id'): FM(note='attempt ordinal (1-based).'),
    ('AppAttemptInfo', 'finishedTime'): FM(note='0 while the attempt is still running.'),
    ('AppAttemptInfo', 'blacklistedNodes'): FM(note='comma+space separated node ids; empty string when none.'),
    ('AppAttemptInfo', 'nodesBlacklistedBySystem'): FM(note='comma+space separated node ids; empty string when none.'),
    ('ServerAppAttemptInfo', 'rpcPort'): FM(note='the single-attempt endpoint is root-unwrapped and stringifies scalars: live "rpcPort":"-1", "host":"N/A" when the AM never registered.'),
    ('ServerAppAttemptInfo', 'amContainerId'): FM(nullable=True, note='omitted when null.'),
    ('ServerAppAttemptInfo', 'appAttemptState'): FM(note='YarnApplicationAttemptState (server-common DAO), NOT RMAppAttemptState: e.g. RUNNING/FAILED/FINISHED/KILLED.'),
    ('ContainerInfo', 'allocatedMB'): FM(note='stringified ("768") because ContainerInfo is not in the RM JAXB resolver list - live-verified.'),
    ('ContainerInfo', 'diagnosticsInfo'): FM(nullable=True, note='omitted when null.'),
    ('ContainerInfo', 'allocatedResources'): FM(note='map via adapter: multi-entry {"entry":[{"key":"memory-mb","value":"768"},...]}; single entry collapses to an object; values are strings.'),
    ('ContainerInfo', 'exposedPorts'): FM(note='empty string when no ports were exposed.'),
    ('ContainerInfo', 'containerExitStatus'): FM(note='0 while running.'),
    ('NodeInfo', 'lastHealthUpdate'): FM(note='epoch ms of the node\'s last heartbeat.'),
    ('NodeInfo', 'healthReport'): FM(note='empty string when healthy with no report.'),
    ('NodeInfo', 'memUtilization'): FM(note='float percent of physical memory used by containers (0-100, can exceed 100).'),
    ('NodeInfo', 'cpuUtilization'): FM(note='float percent (0-100, can exceed 100).'),
    ('NodeInfo', 'nodeLabels'): FM(note='array; the legacy UI prints the elements comma separated.'),
    ('NodeInfo', 'allocationTags'): FM(note='AllocationTagsInfo; live {} (empty object) when the node has no tags.'),
    ('NodeInfo', 'resourceUtilization'): FM(note='NodeResourceMonitorView values; null when the node health script/resource monitor is disabled.'),
    ('NodeInfo', 'usedResource'): FM(note='ResourceInfo with memory/vCores/resourceInformations.'),
    ('NodeInfo', 'availableResource'): FM(note='ResourceInfo with memory/vCores/resourceInformations.'),
    ('NodeInfo', 'totalResource'): FM(note='ResourceInfo with memory/vCores/resourceInformations.'),
    ('NodeInfo', 'numRunningOpportContainers'): FM(when=['conf:yarn.resourcemanager.opportunistic-container-allocation.enabled=true'], note='opportunistic-container fields; 0 when the feature is off.'),
    ('NodeInfo', 'subClusterId'): FM(nullable=True, note='omitted when null (non-federated).'),
    ('NodeLabelInfo', 'exclusivity'): FM(note='Java boolean, but the JSON is a STRING "true"/"false" because NodeLabelsInfo is not in the RM JAXB resolver list (root-unwrapped + stringified scalars) - live-verified.'),
    ('NodeLabelInfo', 'activeNMs'): FM(nullable=True, note='omitted from the live /get-node-labels JSON (null).'),
    ('NodeLabelInfo', 'partitionInfo'): FM(note='only present in the /get-node-labels response (RMWebServices.java:1439-1443); /nodes/{id}/get-labels omits it.'),
    ('StatisticsItemInfo', 'type'): FM(note='"*" for all application types, otherwise the lower-cased application type (live: "spark").'),
    ('SchedulerInfo', '*'): FM(note='abstract base: with @XmlAccessorType(FIELD) on the subclasses its protected fields are NOT serialised; only the @XmlType discriminator appears as "type".'),
    ('SchedulerOverviewInfo', 'schedulerType'): FM(note='legacy SchedulerInfo.getSchedulerType() text, e.g. "Capacity Scheduler".'),
    ('SchedulerOverviewInfo', 'schedulingResourceType'): FM(note='comma-joined (no space), e.g. "memory-mb (unit=Mi),vcores"; the legacy page uses Arrays.toString, which adds brackets and a space after the comma.'),
    ('SchedulerOverviewInfo', 'applicationPriority'): FM(note='max cluster-level application priority.'),
    ('SchedulerOverviewInfo', 'schedulerBusy'): FM(note='RM scheduler busy percent (0-100).'),
    ('SchedulerOverviewInfo', 'rmDispatcherEventQueueSize'): FM(note='RM dispatcher event queue size; only meaningful when the RM scheduler is busy.'),
    ('SchedulerOverviewInfo', 'schedulerDispatcherEventQueueSize'): FM(note='scheduler dispatcher event queue size.'),
    ('CapacitySchedulerInfo', 'weight'): FM(note='-1.0 when the queue has no explicit weight (auto-computed); normalizedWeight is 0.0 in that case. Live-verified on root.'),
    ('CapacitySchedulerInfo', 'defaultNodeLabelExpression'): FM(nullable=True, note='omitted when null - live-verified absent on root.'),
    ('CapacitySchedulerInfo', 'queues'): FM(note='CapacitySchedulerQueueInfoList: {"queue":[...]}; a single child still serialises as an array (live-verified).'),
    ('CapacitySchedulerInfo', 'health'): FM(note='CapacitySchedulerHealthInfo (lastrun + operationsInfo + lastRunDetails).'),
    ('CapacitySchedulerLeafQueueInfo', 'name'): FM(note='unused'),
    ('UserInfo', 'resourcesUsed'): FM(note='per-user used resources of the queue (root partition view).'),
    ('UserInfo', 'AMResourceUsed'): FM(nullable=True, note='omitted when the user has no AM running.'),
    ('UserInfo', 'userResourceLimit'): FM(note='effective per-user resource limit.'),
    ('UserInfo', 'userWeight'): FM(note='per-user weight (capacity scheduler user-limit config).'),
    ('OperationInformation', 'containerId'): FM(note='live value "N/A" when the operation was not on a container (last-allocation) - a sentinel string, not an id.'),
    ('ActivityNodeInfo', 'count'): FM(note='number of allocations aggregated at this node.'),
    ('ActivityNodeInfo', 'nodeIds'): FM(nullable=True, note='present for aggregated slots; omitted otherwise.'),
    ('QueueCapacitiesInfo', 'queueCapacitiesByPartition'): FM(note='one entry per label/partition; partitionName "" is the default partition.'),
    ('ResourceInfo', 'memory'): FM(note='MB; in stringified contexts (e.g. inside NodeLabelInfo) it is a string ("3072").'),
    ('ResourceInformation', 'value'): FM(note='numeric resource value in its own units.'),
    ('ResourceInformation', 'tags'): FM(nullable=True, note='omitted from the JSON when empty - live-verified on 3.4.3 (/apps item resourceInformations.resourceInformation has no tags key); listed here because @XmlElement serialises it when the resource has tags.'),
    ('PartitionResourcesInfo', 'amLimit'): FM(nullable=True, note='present only when the queue has an AM limit for the partition (capacity scheduler leaf queues).'),
    ('PartitionResourcesInfo', 'amUsed'): FM(nullable=True, note='present only when the queue tracks AM usage for the partition.'),
    ('PartitionResourcesInfo', 'userAmLimit'): FM(nullable=True, note='present only when the queue tracks a per-user AM limit for the partition.'),
    ('AppInfo', 'appNodeLabelExpression'): FM(nullable=True, note='omitted when null (no node-label expression on the app) - live-verified.'),
    ('AppInfo', 'amNodeLabelExpression'): FM(nullable=True, note='omitted when null.'),
    ('AppInfo', 'diagnostics'): FM(note='free text; the AppBlock prints it in a "Diagnostics" cell and it can be empty for a healthy app.'),
    ('CapacitySchedulerHealthInfo', 'operationsInfo'): FM(nullable=True, note='present only after the scheduler has recorded at least one last-operation entry (the health block is built on demand).'),
    ('ResourceInformation', 'attributes'): FM(nullable=True, note='{} or null; live shows {} under the wrapped context and null under stringified contexts.'),
    ('AppTimeoutInfo', 'type'): FM(note='ApplicationTimeoutType: LIFETIME|...'),
    ('AppTimeoutInfo', 'expiryTime'): FM(note='date string, or "UNLIMITED" when no expiry is set (live-verified).'),
    ('AppTimeoutInfo', 'remainingTimeInSeconds'): FM(note='-1 when no expiry is set (live-verified).'),
    ('ConfInfo', 'property'): FM(note='array of {name,value}; single property still an array.'),
    ('RemoteException', 'exception'): FM(note='Java exception class short name, e.g. BadRequestException/NotFoundException.'),
    ('ConfigVersionInfo', 'version'): FM(note='monotonic scheduler-conf version (epoch ms of the last update).'),
}
# synthetic fields not present as Java fields (JAXB @XmlType polymorphism discriminators)
SYNTHETIC_TYPE = {
    'CapacitySchedulerInfo': ('capacityScheduler', 42),
    'FairSchedulerInfo': ('fairScheduler', 32),
    'FifoSchedulerInfo': ('fifoScheduler', 36),
    'CapacitySchedulerQueueInfo': ('capacitySchedulerQueueInfo', 45),
    'CapacitySchedulerLeafQueueInfo': ('capacitySchedulerLeafQueueInfo', 36),
    'FairSchedulerQueueInfo': ('fairSchedulerQueueInfo', 36),
    'FairSchedulerLeafQueueInfo': ('fairSchedulerLeafQueueInfo', 29),
}

# --------------------------------------------------------------------------- objects
objects = O.collect_objects()
for oname, obj in objects.items():
    for f in obj['fields']:
        meta = {}
        if (oname, f['name']) in FIELD_META:
            meta = dict(FIELD_META[(oname, f['name'])])
        f.setdefault('nullable', meta.pop('nullable', False))
        f.setdefault('when', meta.pop('when', []))
        if 'values' in meta:
            f['values'] = meta.pop('values')
        f['unit'] = meta.pop('unit', unit_of(oname, f['name']))
        f['note'] = meta.pop('note', '')
        f.update(meta)
    if oname in SYNTHETIC_TYPE:
        val, line = SYNTHETIC_TYPE[oname]
        obj['fields'].insert(0, {
            'name': 'type', 'type': 'enum', 'array': False, 'ref': None, 'values': [val],
            'nullable': False, 'when': [], 'unit': '', 'synthetic': True,
            'source': '%sdao/%s.java:%d' % (RMW, oname if oname not in (
                'CapacitySchedulerLeafQueueInfo', 'FairSchedulerLeafQueueInfo') else oname, line),
            'note': 'JAXB polymorphism discriminator injected by the JSON provider from @XmlType(name=...) / the class name; NOT a Java field.',
        })
    obj['jsonMode'] = 'nested'
    obj['rootUnwrapping'] = oname not in WRAPPED
    if oname in WRAPPED:
        obj['jsonMode'] = 'wrapped'
    elif oname in UNWRAPPED:
        obj['jsonMode'] = 'unwrapped'
# SchedulerInfo: make the base-class fact explicit
objects['SchedulerInfo']['note'] = (
    'Abstract base of the three scheduler info DAOs. All its fields are protected and the subclasses use '
    '@XmlAccessorType(FIELD), so none of them is serialised; the only observable key contributed to the JSON is the '
    'polymorphism discriminator `type` (see the synthetic field on each subclass). SchedulerInfo.java:37-85.')
objects['RemoteException']['java'] = 'org.apache.hadoop.yarn.webapp.RemoteExceptionData'

# --------------------------------------------------------------------------- entities
entities = [
    {'id': 'cluster.info', 'description': 'the ResourceManager itself (GET /ws/v1/cluster/info)',
     'roots': [{'object': 'ClusterInfo', 'jsonPath': 'clusterInfo', 'when': []}]},
    {'id': 'cluster.metrics', 'description': 'cluster-wide counters and resources (GET /ws/v1/cluster/metrics)',
     'roots': [{'object': 'ClusterMetricsInfo', 'jsonPath': 'clusterMetrics', 'when': []}]},
    {'id': 'clusteruser', 'description': 'the user the RM sees for the request (GET /ws/v1/cluster/userinfo); root-UNWRAPPED (properties at top level)',
     'roots': [{'object': 'ClusterUserInfo', 'jsonPath': '', 'when': []}]},
    {'id': 'scheduler', 'description': 'scheduler summary + per-queue tree (GET /ws/v1/cluster/scheduler) and the scheduler overview scalars (GET /ws/v1/cluster/scheduler-overview)',
     'roots': [
         {'object': 'SchedulerOverviewInfo', 'jsonPath': '', 'when': []},
         {'object': 'SchedulerTypeInfo', 'jsonPath': 'scheduler', 'when': []},
         {'object': 'CapacitySchedulerInfo', 'jsonPath': 'scheduler.schedulerInfo', 'when': ['scheduler=capacity']},
         {'object': 'FairSchedulerInfo', 'jsonPath': 'scheduler.schedulerInfo', 'when': ['scheduler=fair']},
         {'object': 'FifoSchedulerInfo', 'jsonPath': 'scheduler.schedulerInfo', 'when': ['scheduler=fifo']},
     ]},
    {'id': 'queue', 'description': 'one scheduler queue; keys are relative to the queue object, so nested queues reuse the same ids',
     'roots': [
         {'object': 'CapacitySchedulerQueueInfo', 'jsonPath': 'scheduler.schedulerInfo.queues.queue[]', 'when': ['scheduler=capacity']},
         {'object': 'CapacitySchedulerLeafQueueInfo', 'jsonPath': 'scheduler.schedulerInfo.queues.queue[]', 'when': ['scheduler=capacity']},
         {'object': 'CapacitySchedulerQueueInfo', 'jsonPath': 'scheduler.schedulerInfo.queues.queue[].queues.queue[]', 'when': ['scheduler=capacity']},
         {'object': 'CapacitySchedulerLeafQueueInfo', 'jsonPath': 'scheduler.schedulerInfo.queues.queue[].queues.queue[]', 'when': ['scheduler=capacity']},
         {'object': 'FairSchedulerQueueInfo', 'jsonPath': 'scheduler.schedulerInfo.rootQueue', 'when': ['scheduler=fair']},
         {'object': 'FairSchedulerLeafQueueInfo', 'jsonPath': 'scheduler.schedulerInfo.rootQueue', 'when': ['scheduler=fair']},
         {'object': 'FairSchedulerQueueInfo', 'jsonPath': 'scheduler.schedulerInfo.rootQueue.childQueues.queue[]', 'when': ['scheduler=fair']},
         {'object': 'FairSchedulerLeafQueueInfo', 'jsonPath': 'scheduler.schedulerInfo.rootQueue.childQueues.queue[]', 'when': ['scheduler=fair']},
     ]},
    {'id': 'queueuser', 'description': 'one user of one queue, from a capacity leaf queue\'s users.user[] array',
     'roots': [{'object': 'UserInfo', 'jsonPath': 'scheduler.schedulerInfo.queues.queue[].users.user[]', 'when': ['scheduler=capacity']}]},
    {'id': 'app', 'description': 'one YARN application (AppInfo; the standalone app sub-resources expose a subset of the same keys)',
     'roots': [
         {'object': 'AppInfo', 'jsonPath': 'apps.app[]', 'when': []},
         {'object': 'AppInfo', 'jsonPath': 'app', 'when': []},
         {'object': 'AppState', 'jsonPath': '', 'when': []},
         {'object': 'AppPriority', 'jsonPath': '', 'when': []},
         {'object': 'AppQueue', 'jsonPath': '', 'when': []},
     ]},
    {'id': 'attempt', 'description': 'one application attempt; two DAO shapes are exposed by two different endpoints (union of keys)',
     'roots': [
         {'object': 'AppAttemptInfo', 'jsonPath': 'appAttempts.appAttempt[]', 'when': []},
         {'object': 'ServerAppAttemptInfo', 'jsonPath': '', 'when': []},
     ]},
    {'id': 'container', 'description': 'one container',
     'roots': [
         {'object': 'ContainerInfo', 'jsonPath': 'containers.container[]', 'when': []},
         {'object': 'ContainerInfo', 'jsonPath': 'container', 'when': []},
         {'object': 'ContainerInfo', 'jsonPath': '', 'when': []},
     ]},
    {'id': 'node', 'description': 'one NodeManager as known to the RM',
     'roots': [
         {'object': 'NodeInfo', 'jsonPath': 'nodes.node[]', 'when': []},
         {'object': 'NodeInfo', 'jsonPath': 'node', 'when': []},
     ]},
    {'id': 'nodelabel', 'description': 'one node label/partition',
     'roots': [
         {'object': 'NodeLabelInfo', 'jsonPath': 'nodeLabelInfo[]', 'when': []},
         {'object': 'NodeLabelInfo', 'jsonPath': 'nodeLabelInfo', 'when': ['other:single-element label list collapses to a bare object (live-verified /nodes/{id}/get-labels)']},
         {'object': 'NodeLabelInfo', 'jsonPath': 'nodeToLabels.entry[].value.nodeLabelInfo[]', 'when': []},
         {'object': 'NodeLabelInfo', 'jsonPath': 'labelsToNodes.entry[].key', 'when': []},
         {'object': 'NodeIDsInfo', 'jsonPath': 'labelsToNodes.entry[].value', 'when': []},
         {'object': 'NodeIDsInfo', 'jsonPath': 'nodes', 'when': ['other:the label-mappings entry value carries the node list and the partition capacity']},
     ]},
    {'id': 'appstat', 'description': 'application counters grouped by state and type (GET /ws/v1/cluster/appstatistics)',
     'roots': [{'object': 'StatisticsItemInfo', 'jsonPath': 'appStatInfo.statItem[]', 'when': []}]},
    {'id': 'activities', 'description': 'scheduler allocation activities (GET /ws/v1/cluster/scheduler/activities, /scheduler/bulk-activities)',
     'roots': [
         {'object': 'ActivitiesInfo', 'jsonPath': 'activities', 'when': []},
         {'object': 'ActivitiesInfo', 'jsonPath': 'bulkActivities.activities[]', 'when': []},
         {'object': 'BulkActivitiesInfo', 'jsonPath': 'bulkActivities', 'when': []},
     ]},
    {'id': 'appactivity', 'description': 'per-application allocation activities (GET /ws/v1/cluster/scheduler/app-activities/{appid})',
     'roots': [{'object': 'AppActivitiesInfo', 'jsonPath': 'appActivities', 'when': []}]},
    {'id': 'conf', 'description': 'one configuration property or the scheduler-conf version (GET /ws/v1/cluster/scheduler-conf, /scheduler-conf/version, and the daemon /conf endpoint); root-UNWRAPPED, {"property":[{"name":..,"value":..}]}',
     'roots': [
         {'object': 'ConfInfo', 'jsonPath': '', 'when': []},
         {'object': 'ConfigVersionInfo', 'jsonPath': 'configversion', 'when': []},
     ]},
    {'id': 'queueacl', 'description': 'the result of the queue access check (GET /ws/v1/cluster/queues/{queue}/access); root-UNWRAPPED',
     'roots': [{'object': 'RMQueueAclInfo', 'jsonPath': '', 'when': []}]},
    {'id': 'usermetrics', 'description': 'the per-user QueueMetrics block of the legacy MetricsOverviewTable; NOT exposed by any RM REST endpoint (JMX only)',
     'roots': []},
]

data = {'version': 1, 'entities': entities, 'objects': objects, 'resources': []}

# --------------------------------------------------------------------------- resources
R = data['resources']
I = 'wrapped (root element name); native JSON types'

R.append(RES('rm.info', 'rm', 'GET', '/ws/v1/cluster/info', contract='info', allow=True,
             produces=PROD, response=resp('ClusterInfo', 'clusterInfo', '{"clusterInfo":{…}}', ctype=PROD[0]),
             src=RWS + ':379', note='The RM info also answers GET /ws/v1/cluster (RMWSConsts.RM_WEB_SERVICE_PATH) with the same body.'))
R.append(RES('rm.metrics', 'rm', 'GET', '/ws/v1/cluster/metrics', contract='metrics', allow=True,
             produces=PROD, response=resp('ClusterMetricsInfo', 'clusterMetrics', '{"clusterMetrics":{…}}', ctype=PROD[0]),
             src=RWS + ':400'))
R.append(RES('rm.cluster-user-info', 'rm', 'GET', '/ws/v1/cluster/userinfo', contract=None, allow=False,
             produces=PROD, response=resp('ClusterUserInfo', None, '{"rmLoginUser":…,"requestedUser":…,"subClusterId":…|absent}', ctype=PROD[0]),
             src=RWS + ':389',
             note='Root-UNWRAPPED with stringified scalars (ClusterUserInfo is not in the RM JAXB resolver list). Not in the docs/contracts/api.md allowlist - CONTRACT CHANGE REQUEST to add `userinfo`.'))
R.append(RES('rm.scheduler', 'rm', 'GET', '/ws/v1/cluster/scheduler', contract='scheduler', allow=True,
             produces=PROD, response=resp('SchedulerTypeInfo', 'scheduler', '{"scheduler":{"schedulerInfo":{…polymorphic type…},"subClusterId":…|absent}}', ctype=PROD[0]),
             src=RWS + ':410'))
R.append(RES('rm.scheduler-overview', 'rm', 'GET', '/ws/v1/cluster/scheduler-overview', contract=None, allow=False,
             produces=PROD, response=resp('SchedulerOverviewInfo', None, '{"schedulerType":"Capacity Scheduler","schedulingResourceType":"memory-mb (unit=Mi),vcores","minimumAllocation":{…},"maximumAllocation":{…},"applicationPriority":…,"schedulerBusy":…,"rmDispatcherEventQueueSize":…,"schedulerDispatcherEventQueueSize":…}', ctype=PROD[0]),
             src=RWS + ':3012',
             note='Root-UNWRAPPED + stringified scalars. Not in docs/contracts/api.md §3 - CONTRACT CHANGE REQUEST to add `scheduler-overview` (the legacy MetricsOverviewTable scheduler block maps 1:1 onto it).'))
R.append(RES('rm.scheduler.activities', 'rm', 'GET', '/ws/v1/cluster/scheduler/activities', contract='scheduler/activities', allow=True,
             params=[P('nodeId', doc='node id (host:port) to show activities for', src=RWS + ':745'),
                     P('groupBy', doc='grouping, only DIAGNOSTIC is supported', values=['DIAGNOSTIC'], src=RWS + ':746')],
             produces=PROD, response=resp('ActivitiesInfo', 'activities', '{"activities":{"nodeId":…,"timestamp":…,"dateTime":…,"diagnostic":…,"allocations":[…]}}', ctype=PROD[0]),
             src=RWS + ':739',
             when=['conf:yarn.resourcemanager.scheduler.activities.enable=true'],
             note='Live without the flag: {"activities":{"nodeId":…,"diagnostic":"waiting for display"}}. Activities are only populated while the RM records them (bounded by yarn.resourcemanager.scheduler.activities.max-count-per-node).'))
R.append(RES('rm.scheduler.bulk-activities', 'rm', 'GET', '/ws/v1/cluster/scheduler/bulk-activities', contract=None, allow=False,
             params=[P('groupBy', doc='aggregation, only DIAGNOSTIC is supported', values=['DIAGNOSTIC'], src=RWS + ':821'),
                     P('activitiesCount', 'query', 'int', False, [], 'number of activities to return (default 1000)', RWS + ':822', default=1000)],
             produces=PROD, response=resp('BulkActivitiesInfo', 'bulkActivities', '{"bulkActivities":{"activities":[ActivitiesInfo…],"subClusterId":…|absent}}', ctype=PROD[0]),
             src=RWS + ':819', when=['conf:yarn.resourcemanager.scheduler.activities.enable=true']))
R.append(RES('rm.app.activities', 'rm', 'GET', '/ws/v1/cluster/scheduler/app-activities/{appid}', contract=None, allow=False,
             params=[P('appid', 'path', 'string', True, [], 'application id', RWS + ':883'),
                     P('maxTime', doc='longest node count to display', src=RWS + ':884'),
                     P('requestPriorities', doc='comma separated request priorities', src=RWS + ':885'),
                     P('allocationRequestIds', doc='comma separated allocation request ids', src=RWS + ':886'),
                     P('groupBy', doc='aggregation, only DIAGNOSTIC is supported', src=RWS + ':888'),
                     P('limit', doc='maximum number of requests to display', src=RWS + ':889'),
                     P('actions', doc='comma separated actions, currently only GET/REFRESH', src=RWS + ':890'),
                     P('summarize', doc='whether to return a child-summarized response (default true)', src=RWS + ':891')],
             produces=PROD, response=resp('AppActivitiesInfo', 'appActivities', '{"appActivities":{"applicationId":…,"diagnostic":…,"timestamp":…,"dateTime":…,"allocations":[…]}}', ctype=PROD[0]),
             src=RWS + ':877',
             note='The docs/contracts/api.md §3 entry `apps/{appId}/appactivities` does NOT exist (live 404); this is the real endpoint - CONTRACT CHANGE REQUEST.'))
R.append(RES('rm.app.statistics', 'rm', 'GET', '/ws/v1/cluster/appstatistics', contract='appstatistics', allow=True,
             params=[P('states', doc='comma separated YarnApplicationState names', src=RWS + ':1039'),
                     P('applicationTypes', doc='comma separated application types', src=RWS + ':1040')],
             produces=PROD, response=resp('ApplicationStatisticsInfo', 'appStatInfo', '{"appStatInfo":{"statItem":[{"state":…,"type":…,"count":…},…]}}', ctype=PROD[0]),
             src=RWS + ':1032',
             note='Always returns one statItem per (YarnApplicationState x requested type), including zero counts; type "*" when applicationTypes is omitted. i.e. the ordering is states-major, types-minor.'))
R.append(RES('rm.apps', 'rm', 'GET', '/ws/v1/cluster/apps', contract='apps', allow=True,
             params=[P('state', doc='single YarnApplicationState (deprecated in favour of states)', src=RWS + ':630'),
                     P('states', doc='comma separated YarnApplicationState names; SUCCEEDED is invalid, use FINISHED', values=['NEW', 'NEW_SAVING', 'SUBMITTED', 'ACCEPTED', 'RUNNING', 'FINISHED', 'FAILED', 'KILLED'], src=RWS + ':631'),
                     P('finalStatus', doc='comma separated FinalApplicationStatus names', src=RWS + ':632'),
                     P('user', doc='user name', src=RWS + ':633'),
                     P('queue', doc='queue name (exact match, root.* form)', src=RWS + ':634'),
                     P('limit', doc='maximum number of applications returned', src=RWS + ':635'),
                     P('startedTimeBegin', 'query', 'long', False, [], 'earliest start time (epoch ms)', RWS + ':636'),
                     P('startedTimeEnd', 'query', 'long', False, [], 'latest start time (epoch ms)', RWS + ':637'),
                     P('finishedTimeBegin', 'query', 'long', False, [], 'earliest finish time (epoch ms)', RWS + ':638'),
                     P('finishedTimeEnd', 'query', 'long', False, [], 'latest finish time (epoch ms)', RWS + ':639'),
                     P('applicationTypes', doc='comma separated application types', src=RWS + ':640'),
                     P('applicationTags', doc='comma separated tags', src=RWS + ':641'),
                     P('name', doc='application name (exact match)', src=RWS + ':642'),
                     P('deSelects', doc='comma separated fields to omit (resourceRequests, resourceUsage, appNodeLabelExpression, amNodeLabelExpression, timeouts)', values=['resourceRequests', 'resourceUsage', 'appNodeLabelExpression', 'amNodeLabelExpression', 'timeouts'], src=RWS + ':643')],
             produces=PROD, response=resp('AppsInfo', 'apps', '{"apps":{"app":[AppInfo…]}}', ctype=PROD[0]),
             errors=[{'status': 400, 'when': 'invalid state/parameter', 'body': 'RemoteException (BadRequestException)'}],
             src=RWS + ':624',
             note='An empty result is {"apps":{}} (the `app` key is omitted, not []).'))
R.append(RES('rm.app', 'rm', 'GET', '/ws/v1/cluster/apps/{appid}', contract='apps/{appId}', allow=True,
             params=[P('appid', 'path', 'string', True, [], 'application id (application_<ts>_<n>)', RWS + ':1126'),
                     P('deSelects', doc='comma separated fields to omit', src=RWS + ':1127')],
             produces=PROD, response=resp('AppInfo', 'app', '{"app":{…}}', ctype=PROD[0]),
             errors=[{'status': 404, 'when': 'unknown application', 'body': 'RemoteException (NotFoundException)'}],
             src=RWS + ':1120'))
R.append(RES('rm.app.attempts', 'rm', 'GET', '/ws/v1/cluster/apps/{appid}/appattempts', contract='apps/{appId}/appattempts', allow=True,
             params=[P('appid', 'path', 'string', True, [], 'application id', RWS + ':1159')],
             produces=PROD, response=resp('AppAttemptsInfo', 'appAttempts', '{"appAttempts":{"appAttempt":[AppAttemptInfo…]}}', ctype=PROD[0]),
             errors=[{'status': 404, 'when': 'unknown application', 'body': 'RemoteException'}],
             src=RWS + ':1153'))
R.append(RES('rm.app.attempt', 'rm', 'GET', '/ws/v1/cluster/apps/{appid}/appattempts/{appattemptid}', contract=None, allow=False,
             params=[P('appid', 'path', 'string', True, [], 'application id', RWS + ':1185'),
                     P('appattemptid', 'path', 'string', True, [], 'application attempt id', RWS + ':1186')],
             produces=PROD, response=resp('ServerAppAttemptInfo', None, '{"appAttemptId":…,"host":…,"rpcPort":"-1","trackingUrl":…,"originalTrackingUrl":…,"diagnosticsInfo":…,"appAttemptState":…,"amContainerId":…|absent,"startedTime":"…","finishedTime":"…"}', ctype=PROD[0]),
             errors=[{'status': 404, 'when': 'unknown attempt', 'body': 'RemoteException'}],
             src=RWS + ':1178',
             note='Root-UNWRAPPED + STRINGIFIED scalars (server-common AppAttemptInfo is not in the RM JAXB resolver list). Not in the docs/contracts/api.md allowlist - CONTRACT CHANGE REQUEST.'))
R.append(RES('rm.app.attempt.containers', 'rm', 'GET', '/ws/v1/cluster/apps/{appid}/appattempts/{appattemptid}/containers', contract='apps/{appId}/appattempts/{attemptId}/containers', allow=True,
             params=[P('appid', 'path', 'string', True, [], 'application id', RWS + ':1198'),
                     P('appattemptid', 'path', 'string', True, [], 'application attempt id', RWS + ':1199')],
             produces=PROD, response=resp('ContainersInfo', None, '{"container":[{…},…]}  (root-unwrapped + stringified; EMPTY result is {} - property omitted)', ctype=PROD[0]),
             src=RWS + ':1191',
             note='Root-UNWRAPPED + stringified scalars; live-verified `{"container":[{"containerId":…,"allocatedMB":"768",…}]}`. A finished attempt returns {}. Containers are only tracked while present in the RM context.'))
R.append(RES('rm.app.attempt.container', 'rm', 'GET', '/ws/v1/cluster/apps/{appid}/appattempts/{appattemptid}/containers/{containerid}', contract='apps/{appId}/appattempts/{attemptId}/containers/{containerId}', allow=True,
             params=[P('appid', 'path', 'string', True, [], 'application id', RWS + ':1211'),
                     P('appattemptid', 'path', 'string', True, [], 'application attempt id', RWS + ':1212'),
                     P('containerid', 'path', 'string', True, [], 'container id', RWS + ':1213')],
             produces=PROD, response=resp('ContainerInfo', None, '{"containerId":…,"allocatedMB":"768",…}  (root-unwrapped + stringified)', ctype=PROD[0]),
             errors=[{'status': 404, 'when': 'container unknown / not in the RM context', 'body': 'RemoteException (NotFoundException)'}],
             src=RWS + ':1204'))
R.append(RES('rm.app.state', 'rm', 'GET', '/ws/v1/cluster/apps/{appid}/state', contract='apps/{appId}/state', allow=True,
             params=[P('appid', 'path', 'string', True, [], 'application id', RWS + ':1224')],
             produces=PROD, response=resp('AppState', None, '{"state":"FINISHED"}', ctype=PROD[0]),
             src=RWS + ':1218'))
R.append(RES('rm.app.priority', 'rm', 'GET', '/ws/v1/cluster/apps/{appid}/priority', contract='apps/{appId}/priority', allow=True,
             params=[P('appid', 'path', 'string', True, [], 'application id', RWS + ':1603')],
             produces=PROD, response=resp('AppPriority', None, '{"priority":0}', ctype=PROD[0]),
             src=RWS + ':1597'))
R.append(RES('rm.app.queue', 'rm', 'GET', '/ws/v1/cluster/apps/{appid}/queue', contract='apps/{appId}/queue', allow=True,
             params=[P('appid', 'path', 'string', True, [], 'application id', RWS + ':1711')],
             produces=PROD, response=resp('AppQueue', None, '{"queue":"root.default"}', ctype=PROD[0]),
             src=RWS + ':1705'))
R.append(RES('rm.app.timeouts', 'rm', 'GET', '/ws/v1/cluster/apps/{appid}/timeouts', contract='apps/{appId}/timeouts', allow=True,
             params=[P('appid', 'path', 'string', True, [], 'application id', RWS + ':2549')],
             produces=PROD, response=resp('AppTimeoutsInfo', 'timeouts', '{"timeouts":{"timeout":[{"type":"LIFETIME","expiryTime":"UNLIMITED","remainingTimeInSeconds":-1}]}}', ctype=PROD[0]),
             src=RWS + ':2543'))
R.append(RES('rm.app.timeout', 'rm', 'GET', '/ws/v1/cluster/apps/{appid}/timeouts/{type}', contract=None, allow=False,
             params=[P('appid', 'path', 'string', True, [], 'application id', RWS + ':2504'),
                     P('type', 'path', 'string', True, ['LIFETIME'], 'ApplicationTimeoutType', RWS + ':2505')],
             produces=PROD, response=resp('AppTimeoutInfo', 'timeout', '{"timeout":{"type":"LIFETIME","expiryTime":…,"remainingTimeInSeconds":…}}', ctype=PROD[0]),
             src=RWS + ':2498'))
R.append(RES('rm.nodes', 'rm', 'GET', '/ws/v1/cluster/nodes', contract='nodes', allow=True,
             params=[P('states', doc='comma separated RMNodeState names; empty returns RUNNING nodes', values=['NEW', 'RUNNING', 'UNHEALTHY', 'DECOMMISSIONED', 'LOST', 'REBOOTED', 'DECOMMISSIONING', 'SHUTDOWN'], src=RWS + ':469')],
             produces=PROD, response=resp('NodesInfo', 'nodes', '{"nodes":{"node":[NodeInfo…]}}', ctype=PROD[0]),
             src=RWS + ':464'))
R.append(RES('rm.node', 'rm', 'GET', '/ws/v1/cluster/nodes/{nodeId}', contract='nodes/{nodeId}', allow=True,
             params=[P('nodeId', 'path', 'string', True, [], 'node id host:port (port defaults to the NM tracking port)', RWS + ':507')],
             produces=PROD, response=resp('NodeInfo', 'node', '{"node":{…}}', ctype=PROD[0]),
             errors=[{'status': 404, 'when': 'unknown node', 'body': 'RemoteException'}],
             src=RWS + ':502'))
R.append(RES('rm.node-labels', 'rm', 'GET', '/ws/v1/cluster/get-node-labels', contract='get-node-labels', allow=True,
             produces=PROD, response=resp('NodeLabelsInfo', None, '{"nodeLabelInfo":[{"name":…,"exclusivity":"true","partitionInfo":{…}}, …]}', ctype=PROD[0]),
             src=RWS + ':1423',
             note='Root-UNWRAPPED + stringified scalars; live-verified. A single label collapses to a bare object (see rm.node.labels).'))
R.append(RES('rm.rm-node-labels', 'rm', 'GET', '/ws/v1/cluster/get-rm-node-labels', contract=None, allow=False,
             produces=PROD, response=resp('NodeLabelsInfo', None, '"nodeLabelInfo":[…] (same shape as rm.node-labels)', ctype=PROD[0]),
             src=RWS + ':1447', note='Labels known to the RM state (includes labels with no active node).'))
R.append(RES('rm.node.labels', 'rm', 'GET', '/ws/v1/cluster/nodes/{nodeId}/get-labels', contract=None, allow=False,
             params=[P('nodeId', 'path', 'string', True, [], 'node id', RWS + ':1533')],
             produces=PROD, response=resp('NodeLabelsInfo', None, '{"nodeLabelInfo":{"name":"gpu","exclusivity":"true"}}  (single label => bare object, live-verified)', ctype=PROD[0]),
             src=RWS + ':1527',
             note='Not in docs/contracts/api.md §3 - CONTRACT CHANGE REQUEST (the node detail page needs the node\'s own labels; rm.node.nodeLabels[] also carries them).'))
R.append(RES('rm.node-to-labels', 'rm', 'GET', '/ws/v1/cluster/get-node-to-labels', contract='get-node-to-labels', allow=True,
             produces=PROD, response=resp('NodeToLabelsInfo', None, '{"nodeToLabels":{"entry":[{"key":"host:port","value":{"nodeLabelInfo":[…]}},…]}}', ctype=PROD[0]),
             src=RWS + ':1300',
             note='Root-UNWRAPPED + stringified; the java.util.Map is serialised through the JAXB map adapter as entry/key/value, and a SINGLE entry collapses to a bare object (same quirk as AppInfo.resourceSecondsMap). Live shows the same node twice, once with the tracking port and once with port 0.'))
R.append(RES('rm.labels-to-nodes', 'rm', 'GET', '/ws/v1/cluster/label-mappings', contract='label-mappings', allow=True,
             params=[P('labels', doc='comma separated label names to restrict the mapping to', src=RWS + ':1323')],
             produces=PROD, response=resp('LabelsToNodesInfo', None, '{"labelsToNodes":{"entry":[{"key":{"name":…,"exclusivity":"true"},"value":{"nodes":[…],"partitionInfo":{…}}},…]}}', ctype=PROD[0]),
             src=RWS + ':1317'))
R.append(RES('rm.queue.access', 'rm', 'GET', '/ws/v1/cluster/queues/{queue}/access', contract=None, allow=False,
             params=[P('queue', 'path', 'string', True, [], 'queue name', RWS + ':2939'),
                     P('user', doc='user to check', src=RWS + ':2940'),
                     P('queue-acl-type', doc='ACL type to check', values=['SUBMIT_APPLICATIONS', 'ADMINISTER_QUEUE', 'APPLICATION_MAX_PRIORITY'], src=RWS + ':2941')],
             produces=PROD, response=resp('RMQueueAclInfo', 'rMQueueAclInfo', '{"rMQueueAclInfo":{…}}', ctype=PROD[0]),
             src=RWS + ':2938'))
R.append(RES('rm.scheduler-conf', 'rm', 'GET', '/ws/v1/cluster/scheduler-conf', contract='scheduler-conf', allow=True,
             produces=PROD, response=resp('ConfInfo', None, '{"property":[{"name":"yarn.scheduler.capacity.root.…","value":"…"},…]}  (root-unwrapped)', ctype=PROD[0]),
             src=RWS + ':2873',
             note='Returns the live CapacityScheduler configuration as a flat property list (root key `property`, live-verified).'))
R.append(RES('rm.scheduler-conf.version', 'rm', 'GET', '/ws/v1/cluster/scheduler-conf/version', contract=None, allow=False,
             produces=PROD, response=resp('ConfigVersionInfo', 'configversion', '{"configversion":{…}}', ctype=PROD[0]),
             src=RWS + ':2906'))
R.append(RES('rm.scheduler-conf.format', 'rm', 'POST', '/ws/v1/cluster/scheduler-conf/format', contract=None, allow=False, ro=False,
             produces=PROD, response=resp(None, None, 'text', ctype='text/plain'), src=RWS + ':2719',
             note='WRITE: formats/replaces the scheduler configuration. Listed for completeness; excluded from the read-only product.'))
R.append(RES('rm.scheduler-conf.validate', 'rm', 'POST', '/ws/v1/cluster/scheduler-conf/validate', contract=None, allow=False, ro=False,
             produces=PROD, response=resp('RemoteException', None, 'validation errors', ctype=PROD[0]), src=RWS + ':2757',
             note='WRITE (dry-run validation). Excluded from the read-only product.'))
R.append(RES('rm.scheduler-conf.update', 'rm', 'PUT', '/ws/v1/cluster/scheduler-conf', contract=None, allow=False, ro=False,
             produces=PROD, response=resp(None, None, 'empty', ctype=PROD[0]), src=RWS + ':2811',
             note='WRITE: applies a SchedConfUpdateInfo. Excluded from the read-only product.'))
R.append(RES('rm.scheduler.logs', 'rm', 'POST', '/ws/v1/cluster/scheduler/logs', contract=None, allow=False, ro=False,
             params=[P('time', doc='period of the dump: 1=hourly, 2=daily, 3=weekly, 4=monthly', values=['1', '2', '3', '4'], src=RWS + ':440')],
             produces=PROD, response=resp(None, None, 'text', ctype='text/plain'), src=RWS + ':435',
             note='WRITE: dumps scheduler logs to the RM log directory. Excluded from the read-only product.'))
R.append(RES('rm.resource-profiles', 'rm', 'GET', '/ws/v1/cluster/resource-profiles', contract='resource-profiles', allow=True,
             produces=PROD, response=resp(None, None, 'unknown - not registered by this build', ctype=PROD[0]),
             src=RMW + 'RMWebServices.java:235',
             when=['other:unsupported by Hadoop 3.4.3 RMWebServices (live 404 on 2026-10-03)'],
             note='docs/contracts/api.md §3 lists it, but RMWebServices 3.4.3 satisfies ResourceProfilesManager through ClientRMService only - no JAX-RS @Path references it (grep-verified). CONTRACT CHANGE REQUEST: drop from the allowlist or document as unavailable.'))
R.append(RES('rm.resource-types', 'rm', 'GET', '/ws/v1/cluster/resource-types', contract='resource-types', allow=True,
             produces=PROD, response=resp(None, None, 'unknown - not registered by this build', ctype=PROD[0]),
             src=RMW + 'RMWebServices.java:235',
             when=['other:unsupported by Hadoop 3.4.3 RMWebServices (live 404 on 2026-10-03)'],
             note='Same as rm.resource-profiles: RMWSConsts has no such path. CONTRACT CHANGE REQUEST.'))
R.append(RES('rm.containers', 'rm', 'GET', '/ws/v1/cluster/containers/{containerId}', contract='containers/{containerId}', allow=True,
             produces=PROD, response=resp(None, None, 'unknown - not registered by this build', ctype=PROD[0]),
             src=RMW + 'RMWebServices.java:235',
             when=['other:unsupported by Hadoop 3.4.3 (no @Path; use rm.app.attempt.container)'],
             note='The only container endpoint in 3.4.3 is apps/{appid}/appattempts/{appattemptid}/containers/{containerid} (RMWSConsts.GET_CONTAINER). CONTRACT CHANGE REQUEST: mark as absent.'))
PARAM_LINE = {
    'rm.app.state.update': {'appid': 1260}, 'rm.app.priority.update': {'appid': 1635},
    'rm.app.queue.update': {'appid': 1743}, 'rm.app.timeout.update': {'appid': 2606},
    'rm.node.resource': {'nodeId': 541}, 'rm.node.labels.replace': {'nodeId': 1380},
    'rm.container.signal': {'containerid': 2988, 'command': 2989},
}
for rid, method, path, params, ro in [
    ('rm.app.state.update', 'PUT', '/ws/v1/cluster/apps/{appid}/state', [('appid', 'path')], False),
    ('rm.app.priority.update', 'PUT', '/ws/v1/cluster/apps/{appid}/priority', [('appid', 'path')], False),
    ('rm.app.queue.update', 'PUT', '/ws/v1/cluster/apps/{appid}/queue', [('appid', 'path')], False),
    ('rm.app.timeout.update', 'PUT', '/ws/v1/cluster/apps/{appid}/timeout', [('appid', 'path')], False),
    ('rm.node.resource', 'POST', '/ws/v1/cluster/nodes/{nodeId}/resource', [('nodeId', 'path')], False),
    ('rm.label-mappings', 'POST', '/ws/v1/cluster/replace-node-to-labels', [], False),
    ('rm.node.labels.replace', 'POST', '/ws/v1/cluster/nodes/{nodeId}/replace-labels', [('nodeId', 'path')], False),
    ('rm.node-labels.add', 'POST', '/ws/v1/cluster/add-node-labels', [], False),
    ('rm.node-labels.remove', 'POST', '/ws/v1/cluster/remove-node-labels', [], False),
    ('rm.app.new-application', 'POST', '/ws/v1/cluster/apps/new-application', [], False),
    ('rm.apps.submit', 'POST', '/ws/v1/cluster/apps', [], False),
    ('rm.delegation-token', 'POST', '/ws/v1/cluster/delegation-token', [], False),
    ('rm.delegation-token.expiration', 'POST', '/ws/v1/cluster/delegation-token/expiration', [], False),
    ('rm.delegation-token.cancel', 'DELETE', '/ws/v1/cluster/delegation-token', [], False),
    ('rm.container.signal', 'POST', '/ws/v1/cluster/containers/{containerid}/signal/{command}', [('containerid', 'path'), ('command', 'path')], False),
    ('rm.reservation.new', 'POST', '/ws/v1/cluster/reservation/new-reservation', [], False),
    ('rm.reservation.submit', 'POST', '/ws/v1/cluster/reservation/submit', [], False),
    ('rm.reservation.update', 'POST', '/ws/v1/cluster/reservation/update', [], False),
    ('rm.reservation.delete', 'POST', '/ws/v1/cluster/reservation/delete', [], False),
    ('rm.reservation.list', 'GET', '/ws/v1/cluster/reservation/list', [], True),
]:
    R.append(RES(rid, 'rm', method, path, contract=None, allow=False, ro=ro,
                 params=[P(n, w, 'string', True, [], 'path parameter',
                           RWS + ':%d' % PARAM_LINE.get(rid, {}).get(n, 235)) for n, w in params],
                 produces=PROD, response=resp(None, None, 'see RMWebServices', ctype=PROD[0]),
                 src=RWS + ':235',
                 note=('WRITE endpoint - listed for completeness, excluded from the read-only product.'
                       if not ro else 'Read-only, but reservation/timeline data is out of product scope (PLAN.md §1).')))

# objects that are direct resource responses inherit their context mode:
# WRAPPED -> wrapped; UNWRAPPED -> unwrapped (native types); anything else returned directly falls back to Jersey's
# default provider -> root-unwrapped + stringified scalars. Objects only ever used as nested values stay 'nested'.
ROOT_OBJECTS = {r['response']['object'] for r in R if r.get('response') and r['response'].get('object')}
for oname, obj in objects.items():
    if oname in WRAPPED:
        obj['jsonMode'] = 'wrapped'
    elif oname in UNWRAPPED:
        obj['jsonMode'] = 'unwrapped'
    elif oname in ROOT_OBJECTS:
        obj['jsonMode'] = 'unwrapped-stringified'
    else:
        obj['jsonMode'] = 'nested'

# --------------------------------------------------------------------------- derived ids needed by the product UI (declared once, repo-wide)
derived = [
    {'id': 'queue.derived.freeGuaranteedPct', 'entity': 'queue', 'type': 'float', 'format': 'float-1dp',
     'from': ['queue.absoluteCapacity', 'queue.absoluteUsedCapacity'],
     'derivation': 'absoluteCapacity - absoluteUsedCapacity, clamped at >= 0 (root queue: capacity - usedCapacity)',
     'source': RWS + ':415', 'restGap': True,
     'note': 'Product-side computation (no REST key); declared here because both the legacy scheduler page bar and the SPA need it.'},
    {'id': 'queue.derived.burstRoomPct', 'entity': 'queue', 'type': 'float', 'format': 'float-1dp',
     'from': ['queue.absoluteMaxCapacity', 'queue.absoluteUsedCapacity'],
     'derivation': 'absoluteMaxCapacity - absoluteUsedCapacity, clamped at >= 0 (root queue: maxCapacity - usedCapacity)',
     'source': RWS + ':415', 'restGap': True},
    {'id': 'queue.derived.fairShareFreeMb', 'entity': 'queue', 'type': 'long', 'format': 'mb',
     'from': ['queue.fairResources.memory', 'queue.usedResources.memory'],
     'derivation': 'fairResources.memory - usedResources.memory', 'source': RMW + 'dao/FairSchedulerQueueInfo.java:70', 'restGap': True,
     'when': ['scheduler=fair']},
    {'id': 'queue.derived.usedOfFairPct', 'entity': 'queue', 'type': 'float', 'format': 'float-1dp',
     'from': ['queue.usedResources.memory', 'queue.fairResources.memory'],
     'derivation': 'usedResources.memory / fairResources.memory * 100', 'source': RMW + 'dao/FairSchedulerQueueInfo.java:70', 'restGap': True,
     'when': ['scheduler=fair']},
    {'id': 'queue.derived.usedOfMinPct', 'entity': 'queue', 'type': 'float', 'format': 'float-1dp',
     'from': ['queue.usedResources.memory', 'queue.minResources.memory'],
     'derivation': 'usedResources.memory / minResources.memory * 100', 'source': RMW + 'dao/FairSchedulerQueueInfo.java:63', 'restGap': True,
     'when': ['scheduler=fair']},
    {'id': 'queue.derived.headroomMb', 'entity': 'queue', 'type': 'long', 'format': 'mb',
     'from': ['queue.maxEffectiveCapacity.memory', 'queue.resourcesUsed.memory', 'queue.maxResources.memory', 'queue.usedResources.memory'],
     'derivation': 'capacity: maxEffectiveCapacity.memory - resourcesUsed.memory ; fair: maxResources.memory - usedResources.memory',
     'source': RMW + 'dao/CapacitySchedulerQueueInfo.java:45', 'restGap': True},
]
data['derived'] = derived

hdr = ("# GENERATED by parity/inventory/tools/gen_rest_rm.py - edit the script, not this file.\n"
       "# ResourceManager REST (/ws/v1/cluster/*) for Hadoop 3.4.3: DAO shapes from parsed Java sources, wrapping/typing\n"
       "# rules live-verified against the running RM (see the module docstring). Paths relative to .cluster/src-extract/.\n")
p = dump('rest-rm.yaml', data, hdr)
print(p)
print(len(objects), 'objects', sum(len(o['fields']) for o in objects.values()), 'fields',
      len(entities), 'entities', len(R), 'resources', len(derived), 'derived')
