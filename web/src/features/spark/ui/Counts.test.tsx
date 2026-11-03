import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Entity } from "~/ui/datum";
import { ByteRecCell, CountsCell, TaskProgress } from "./Counts";

const wrap = (children: React.ReactNode) => <Entity id="spark-counts">{children}</Entity>;

describe("Spark count widgets", () => {
  it("renders partial byte and record pairs as well as unavailable pairs", () => {
    const { container } = render(
      wrap(
        <>
          <ByteRecCell bytes={null} records={null} bytesField="bytes" recordsField="records" />
          <ByteRecCell bytes={null} records={12} bytesField="bytes" recordsField="records" />
          <ByteRecCell bytes={4096} records={null} bytesField="bytes" recordsField="records" />
          <ByteRecCell bytes={4096} records={12} bytesField="bytes" recordsField="records" recordsUnit="bytes" />
        </>,
      ),
    );

    expect(container.textContent).toContain("—");
    expect(container.textContent).toContain("12");
    expect(container.textContent).toContain("4 KiB");
    expect(container.textContent).toContain("12 B");
  });

  it("shows empty, missing, zero and nonzero counts with progress fallback", () => {
    const { container } = render(
      wrap(
        <>
          <CountsCell counts={[]} />
          <CountsCell
            counts={[
              { field: "missing", raw: undefined, tone: "idle", label: "Missing" },
              { field: "zero", raw: 0, tone: "wait", label: "Zero" },
              { field: "done", raw: 3, tone: "ok", label: "Done" },
            ]}
          />
          <TaskProgress complete={0} active={0} failed={0} total={0} field="numCompleteTasks" label="Empty stage" />
          <TaskProgress complete={1} active={0} failed={0} total={1} field="numCompleteTasks" label="Finished stage" />
        </>,
      ),
    );

    expect(container.textContent).toContain("—030");
    expect(container.textContent).toContain("0/0");
  });
});
