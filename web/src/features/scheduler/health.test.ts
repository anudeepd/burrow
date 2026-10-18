/**
 * Unit tests for the QueueMetrics JMX → aggregate-counter mapping behind the scheduler Health tab.
 *
 * The RM's root-queue QueueMetrics bean is the only source for the three legacy aggregate counters (the stock page reads
 * them from the live scheduler object, which REST does not expose). The mapping must read the exact bean keys and degrade
 * to null when a key is missing — never to a fabricated 0.
 */
import { describe, expect, it } from "vitest";
import { aggregateCounts } from "./HealthTables";

const BEAN = {
  name: "Hadoop:service=ResourceManager,name=QueueMetrics,q0=root",
  AggregateContainersAllocated: 110,
  AggregateContainersReleased: 107,
  AggregateContainersPreempted: 0,
};

describe("aggregateCounts", () => {
  it("reads the three aggregate counters and the bean name from the QueueMetrics bean", () => {
    expect(aggregateCounts(BEAN)).toEqual({
      allocated: 110,
      released: 107,
      preempted: 0,
      source: "Hadoop:service=ResourceManager,name=QueueMetrics,q0=root",
    });
  });

  it("keeps an explicit zero (preemptions) as 0, not null", () => {
    expect(aggregateCounts(BEAN).preempted).toBe(0);
  });

  it("returns null for a key the bean does not carry (no invented zero)", () => {
    const partial = { name: "QueueMetrics,q0=root", AggregateContainersAllocated: 25 };
    expect(aggregateCounts(partial)).toEqual({
      allocated: 25,
      released: null,
      preempted: null,
      source: "QueueMetrics,q0=root",
    });
  });

  it("returns all-null when the JMX response carried no bean", () => {
    expect(aggregateCounts(undefined)).toEqual({ allocated: null, released: null, preempted: null, source: null });
  });

  it("ignores a non-numeric attribute instead of coercing it", () => {
    expect(aggregateCounts({ name: "b", AggregateContainersAllocated: "110" }).allocated).toBeNull();
  });
});
