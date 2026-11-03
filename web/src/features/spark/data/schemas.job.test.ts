import { describe, expect, it } from "vitest";
import { executorKey, jobKey, rddKey, SparkJobSchema, SparkRddResponseSchema, sqlKey, stageKey, taskKey } from "./schemas";

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

describe("Spark entity keys", () => {
  it("stringifies numeric identifiers and uses attempt zero when absent", () => {
    expect(jobKey(12)).toBe("12");
    expect(stageKey("4", undefined)).toBe("4/0");
    expect(stageKey(4, 2)).toBe("4/2");
    expect(taskKey(8)).toBe("8");
    expect(executorKey("executor-1")).toBe("executor-1");
    expect(rddKey(3)).toBe("3");
    expect(sqlKey(5)).toBe("5");
  });
});

describe("Spark RDD response compatibility", () => {
  it("accepts the wrapped RDD form", () => {
    expect(SparkRddResponseSchema.parse({ rdd: { id: 7, name: "cached" } })).toMatchObject({ rdd: { id: 7, name: "cached" } });
  });
});
