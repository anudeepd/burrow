import { describe, expect, it } from "vitest";
import { SparkJobSchema } from "./schemas";

describe("SparkJobSchema", () => {
  it("normalizes job details that omit jobTags", () => {
    const result = SparkJobSchema.safeParse({
      jobId: 2,
      name: "insertInto at DL_Ada_Data_copy.java:150",
      submissionTime: "2026-10-11T14:47:53.453GMT",
      completionTime: "2026-10-11T14:47:57.627GMT",
      stageIds: [2],
      jobGroup: "application_1785381690311_148964",
      status: "SUCCEEDED",
      numTasks: 4,
      numActiveTasks: 0,
      numCompletedTasks: 4,
      numSkippedTasks: 0,
      numFailedTasks: 0,
      numKilledTasks: 0,
      numCompletedIndices: 4,
      numActiveStages: 0,
      numCompletedStages: 1,
      numSkippedStages: 0,
      numFailedStages: 0,
      killedTasksSummary: {},
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.jobTags).toEqual([]);
  });
});
