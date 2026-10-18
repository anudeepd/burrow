/**
 * FIFO scheduler view — the legacy `DefaultSchedulerPage` "FifoScheduler Queue" block. FIFO has a single queue and no
 * tree. `capacity`/`usedCapacity` are fractions 0..1 in this shape (unlike the capacity scheduler's percentages).
 *
 * The legacy heading is `'<queueName>' Queue Status`; 3.4.3 does not serialize the FIFO queue name (`qName` is
 * @XmlTransient), so the heading says so instead of inventing one.
 */
import type { FifoSchedulerInfo } from "~/api/schemas";
import { Datum, Entity, datumAttrs } from "~/ui/datum";
import { ProgressBar } from "~/ui/progress-bar";
import { fmtInt, fmtMB, fmtPct } from "~/lib/format";
import { Card, KV, KVRow, Section, StateNote } from "./Chrome";
import { countText, pressureTone } from "./format";

export function FifoQueueStatus({ info }: { info: FifoSchedulerInfo }) {
  const used = Number.isFinite(info.usedCapacity) ? info.usedCapacity * 100 : null;
  const pressure = Number.isFinite(info.capacity) && info.capacity > 0 && used != null ? (used / (info.capacity * 100)) * 100 : null;
  const tone = pressureTone(pressure);
  return (
    <Entity id="_">
      <Section
        title="FifoScheduler Queue"
        hint="The FIFO scheduler has one queue: containers are allocated in submission order. Capacity and used capacity are fractions in this REST shape."
      >
        <Card className="flex flex-col gap-3">
          <div>
            <h3 className="text-lead">
              <span className="text-ink-4">queue name</span>{" "}
              <span className="font-mono text-body text-ink-3">not serialized by Hadoop 3.4.3</span> <span className="text-ink-4">·</span>{" "}
              Queue Status
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ProgressBar
              percent={used ?? 0}
              tone={tone}
              live
              label={`Used capacity ${fmtPct(used)}`}
              valueText={`${fmtPct(used)} used of ${fmtPct(info.capacity * 100)}`}
              className="burrow-thread--headroom min-w-40 flex-1"
              datum={datumAttrs("scheduler.usedCapacity", info.usedCapacity, "pct")}
            />
            <span className="text-body tnum">
              <Datum field="scheduler.usedCapacity" raw={info.usedCapacity} fmt="pct" className="font-medium">
                {used == null ? "—" : fmtPct(used)}
              </Datum>
              <span className="text-ink-4"> used of </span>
              <Datum field="scheduler.capacity" raw={info.capacity} fmt="pct">
                {fmtPct(info.capacity * 100)}
              </Datum>
            </span>
          </div>
          <KV columns={2}>
            <KVRow label="Queue State" field="scheduler.qstate" raw={info.qstate}>
              {info.qstate ?? "—"}
            </KVRow>
            <KVRow
              label="Minimum Queue Memory Capacity"
              field="scheduler.minQueueMemoryCapacity"
              raw={info.minQueueMemoryCapacity}
              fmt="mb"
            >
              {fmtMB(info.minQueueMemoryCapacity)}
            </KVRow>
            <KVRow
              label="Maximum Queue Memory Capacity"
              field="scheduler.maxQueueMemoryCapacity"
              raw={info.maxQueueMemoryCapacity}
              fmt="mb"
            >
              {fmtMB(info.maxQueueMemoryCapacity)}
            </KVRow>
            <KVRow label="Number of Nodes" field="scheduler.numNodes" raw={info.numNodes} fmt="int">
              {fmtInt(info.numNodes)}
            </KVRow>
            <KVRow label="Used Node Capacity" field="scheduler.usedNodeCapacity" raw={info.usedNodeCapacity} fmt="mb">
              {fmtMB(info.usedNodeCapacity)}
            </KVRow>
            <KVRow label="Available Node Capacity" field="scheduler.availNodeCapacity" raw={info.availNodeCapacity} fmt="mb">
              {fmtMB(info.availNodeCapacity)}
            </KVRow>
            <KVRow label="Total Node Capacity" field="scheduler.totalNodeCapacity" raw={info.totalNodeCapacity} fmt="mb">
              {fmtMB(info.totalNodeCapacity)}
            </KVRow>
            <KVRow label="Number of Node Containers" field="scheduler.numContainers" raw={info.numContainers} fmt="int">
              {countText(info.numContainers)}
            </KVRow>
          </KV>
        </Card>
        <StateNote title="No queue tree under FIFO">
          The FIFO scheduler has no nested queues, so there is nothing to show for queue freeness beyond this single queue. Capacity and
          Fair schedulers get the hierarchical freeness view.
        </StateNote>
      </Section>
    </Entity>
  );
}
