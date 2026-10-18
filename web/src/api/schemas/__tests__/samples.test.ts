import { describe, expect, it } from "vitest";
import {
  AppActivitiesSchema,
  AppAttemptDetailResponseSchema,
  AppAttemptsResponseSchema,
  AppPriorityResponseSchema,
  AppQueueResponseSchema,
  AppResponseSchema,
  AppsResponseSchema,
  AppStateResponseSchema,
  AppStatisticsResponseSchema,
  AppTimeoutResponseSchema,
  AppTimeoutsResponseSchema,
  ApiErrorEnvelopeSchema,
  ClusterInfoResponseSchema,
  ClusterMetricsResponseSchema,
  ClusterUserInfoSchema,
  ConfResponseSchema,
  ContainerResponseSchema,
  ContainersResponseSchema,
  JmxResponseSchema,
  LabelMappingsResponseSchema,
  MetaSchema,
  NodeLabelsResponseSchema,
  NodeResponseSchema,
  NodesResponseSchema,
  NodeToLabelsResponseSchema,
  RemoteExceptionSchema,
  RmLogsListingSchema,
  SchedulerActivitiesSchema,
  SchedulerConfSchema,
  SchedulerResponseSchema,
  selectApps,
  selectAppStatistics,
  selectNodeLabels,
} from "~/api/schemas";
import appJson from "~/api/schemas/samples/app.json";
import appActivities from "~/api/schemas/samples/app-activities.json";
import appAttemptDetail from "~/api/schemas/samples/app-attempt-detail.json";
import appAttempts from "~/api/schemas/samples/app-attempts.json";
import appPriority from "~/api/schemas/samples/app-priority.json";
import appQueue from "~/api/schemas/samples/app-queue.json";
import appState from "~/api/schemas/samples/app-state.json";
import appTimeout from "~/api/schemas/samples/app-timeout.json";
import appTimeouts from "~/api/schemas/samples/app-timeouts.json";
import apps from "~/api/schemas/samples/apps.json";
import appsEmpty from "~/api/schemas/samples/apps-empty.json";
import appstatistics from "~/api/schemas/samples/appstatistics.json";
import clusterInfo from "~/api/schemas/samples/cluster-info.json";
import clusterMetrics from "~/api/schemas/samples/cluster-metrics.json";
import conf from "~/api/schemas/samples/conf.json";
import container from "~/api/schemas/samples/container.json";
import containers from "~/api/schemas/samples/containers.json";
import error from "~/api/schemas/samples/error.json";
import jmx from "~/api/schemas/samples/jmx.json";
import labelMappings from "~/api/schemas/samples/label-mappings.json";
import meta from "~/api/schemas/samples/meta.json";
import node from "~/api/schemas/samples/node.json";
import nodeLabels from "~/api/schemas/samples/node-labels.json";
import nodeToLabels from "~/api/schemas/samples/node-to-labels.json";
import nodes from "~/api/schemas/samples/nodes.json";
import nodesEmpty from "~/api/schemas/samples/nodes-empty.json";
import remoteException from "~/api/schemas/samples/remote-exception.json";
import rmlogs from "~/api/schemas/samples/rm-logs.json";
import schedulerActivities from "~/api/schemas/samples/scheduler-activities.json";
import schedulerCapacity from "~/api/schemas/samples/scheduler-capacity.json";
import schedulerConf from "~/api/schemas/samples/scheduler-conf.json";
import schedulerFair from "~/api/schemas/samples/scheduler-fair.json";
import schedulerFifo from "~/api/schemas/samples/scheduler-fifo.json";
import userInfo from "~/api/schemas/samples/user-info.json";
import type { z } from "zod";

/**
 * Every captured upstream sample must parse in STRICT mode (`vitest.setup.ts` sets `__BURROW_STRICT_SCHEMAS__`), which is the
 * P1 gate in miniature: an upstream key the schema does not know about fails here instead of being silently preserved.
 */
const CASES: { file: string; schema: z.ZodType; sample: unknown }[] = [
  { file: "app.json", schema: AppResponseSchema, sample: appJson },
  { file: "apps.json", schema: AppsResponseSchema, sample: apps },
  { file: "apps-empty.json", schema: AppsResponseSchema, sample: appsEmpty },
  { file: "app-attempts.json", schema: AppAttemptsResponseSchema, sample: appAttempts },
  { file: "app-attempt-detail.json", schema: AppAttemptDetailResponseSchema, sample: appAttemptDetail },
  { file: "app-state.json", schema: AppStateResponseSchema, sample: appState },
  { file: "app-priority.json", schema: AppPriorityResponseSchema, sample: appPriority },
  { file: "app-queue.json", schema: AppQueueResponseSchema, sample: appQueue },
  { file: "app-timeout.json", schema: AppTimeoutResponseSchema, sample: appTimeout },
  { file: "app-timeouts.json", schema: AppTimeoutsResponseSchema, sample: appTimeouts },
  { file: "appstatistics.json", schema: AppStatisticsResponseSchema, sample: appstatistics },
  { file: "app-activities.json", schema: AppActivitiesSchema, sample: appActivities },
  { file: "cluster-info.json", schema: ClusterInfoResponseSchema, sample: clusterInfo },
  { file: "cluster-metrics.json", schema: ClusterMetricsResponseSchema, sample: clusterMetrics },
  { file: "conf.json", schema: ConfResponseSchema, sample: conf },
  { file: "container.json", schema: ContainerResponseSchema, sample: container },
  { file: "containers.json", schema: ContainersResponseSchema, sample: containers },
  { file: "jmx.json", schema: JmxResponseSchema, sample: jmx },
  { file: "label-mappings.json", schema: LabelMappingsResponseSchema, sample: labelMappings },
  { file: "meta.json", schema: MetaSchema, sample: meta },
  { file: "node.json", schema: NodeResponseSchema, sample: node },
  { file: "nodes.json", schema: NodesResponseSchema, sample: nodes },
  { file: "nodes-empty.json", schema: NodesResponseSchema, sample: nodesEmpty },
  { file: "node-labels.json", schema: NodeLabelsResponseSchema, sample: nodeLabels },
  { file: "node-to-labels.json", schema: NodeToLabelsResponseSchema, sample: nodeToLabels },
  { file: "rm-logs.json", schema: RmLogsListingSchema, sample: rmlogs },
  { file: "scheduler-activities.json", schema: SchedulerActivitiesSchema, sample: schedulerActivities },
  { file: "scheduler-capacity.json", schema: SchedulerResponseSchema, sample: schedulerCapacity },
  { file: "scheduler-fair.json", schema: SchedulerResponseSchema, sample: schedulerFair },
  { file: "scheduler-fifo.json", schema: SchedulerResponseSchema, sample: schedulerFifo },
  { file: "scheduler-conf.json", schema: SchedulerConfSchema, sample: schedulerConf },
  { file: "user-info.json", schema: ClusterUserInfoSchema, sample: userInfo },
  { file: "error.json", schema: ApiErrorEnvelopeSchema, sample: error },
  { file: "remote-exception.json", schema: RemoteExceptionSchema, sample: remoteException },
];

describe("upstream schemas (strict)", () => {
  for (const { file, schema, sample } of CASES) {
    it(`parses ${file}`, () => {
      const result = schema.safeParse(sample);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("\n  ");
        throw new Error(`${file} failed strict validation:\n  ${issues}`);
      }
      expect(result.success).toBe(true);
    });
  }

  it("rejects an unknown key in strict mode", () => {
    const result = AppsResponseSchema.safeParse({ apps: { app: [{ id: "application_1_1", notARealField: 1 }] } });
    expect(result.success).toBe(false);
  });

  it("normalises Hadoop's null/single-object collections", () => {
    expect(selectApps(AppsResponseSchema.parse({ apps: null }))).toEqual([]);
    const one = AppsResponseSchema.parse(apps);
    expect(selectApps(one).length).toBeGreaterThan(0);
    expect(selectNodeLabels(NodeLabelsResponseSchema.parse(nodeLabels)).length).toBeGreaterThan(0);
    expect(selectAppStatistics(AppStatisticsResponseSchema.parse(appstatistics)).length).toBeGreaterThan(0);
  });
});
