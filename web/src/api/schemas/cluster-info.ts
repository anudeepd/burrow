import { z } from "zod";
import { num, obj } from "./_base";

/** RM `ClusterInfo` — `GET /ws/v1/cluster/info`. Field access (JAXB FIELD), so names are the Java field names. */
export const ClusterInfoSchema = obj({
  id: num, // cluster timestamp
  startedOn: num, // epoch ms
  state: z.string(), // STATE: NOTINITED|INITED|STARTED|STOPPED
  haState: z.string(), // HAServiceState: INITIALIZING|ACTIVE|STANDBY|STOPPING
  rmStateStoreName: z.string(),
  resourceManagerVersion: z.string(),
  resourceManagerBuildVersion: z.string(),
  resourceManagerVersionBuiltOn: z.string(),
  hadoopVersion: z.string(),
  hadoopBuildVersion: z.string(),
  hadoopVersionBuiltOn: z.string(),
  haZooKeeperConnectionState: z.string().optional(),
  subClusterId: z.string().optional(), // federation only
});
export type ClusterInfo = z.infer<typeof ClusterInfoSchema>;

export const ClusterInfoResponseSchema = obj({ clusterInfo: ClusterInfoSchema });
export type ClusterInfoResponse = z.infer<typeof ClusterInfoResponseSchema>;
export const selectClusterInfo = (r: ClusterInfoResponse): ClusterInfo => r.clusterInfo;
