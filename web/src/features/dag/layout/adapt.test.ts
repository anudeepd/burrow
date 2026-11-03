import { describe, expect, it } from "vitest";
import { toRenderGraph } from "./adapt";
import type { Dag, SqlPlanExecution } from "../types";

describe("toRenderGraph", () => {
  it("adapts both Spark DAGs and SQL plans", () => {
    const dag: Dag = { kind: "stage", granularity: "stage", stages: [], edges: [] };
    const sql: SqlPlanExecution = { id: 1, status: "COMPLETED", description: "scan", nodes: [], edges: [] };

    expect(toRenderGraph(dag).kind).toBe("job");
    expect(toRenderGraph(sql).kind).toBe("sql");
  });
});
