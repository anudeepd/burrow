/**
 * Container detail — the legacy `/cluster/container/{id}` page.
 *
 * Legacy rows (ContainerBlock.render): Container State · Exit Status · Node · Priority · Started · Elapsed · Resource ·
 * Logs · Diagnostics. RM REST's `ContainerInfo` carries all of them except the combined `Resource` string, which is
 * rebuilt from `allocatedMB`/`allocatedVCores` (plus `allocatedResources` when the RM's mapped-notation payload
 * includes it).
 */
import { Link } from "@tanstack/react-router";
import type { Container } from "~/api/schemas";
import { fmtDuration } from "~/lib/format";
import { Datum, Entity } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { LogLink } from "./LogLink";
import { CopyButton, Field, FieldShell, Section } from "./Field";
import { containerResourceText, elapsedMs, nodeHostPort } from "../model";

export function ContainerDetail({
  appId,
  container,
  attemptId,
  now,
}: {
  appId: string;
  container: Container;
  attemptId: string;
  now: number;
}) {
  const elapsed = container.finishedTime > 0 ? container.elapsedTime : elapsedMs(container.startedTime, container.finishedTime, now);
  const resourceText = containerResourceText(container);
  const mappedResources = Object.entries(container.allocatedResources ?? {});
  return (
    <Entity id={container.containerId} className="flex min-w-0 flex-col gap-4">
      <Section
        title={<>Container {container.containerId}</>}
        actions={<CopyButton text={container.containerId} label="Copy container id" />}
      >
        <dl className="grid min-w-0 grid-cols-1 xl:grid-cols-2 xl:gap-x-8">
          <FieldShell label="Container State:" valueClassName="flex items-center gap-2">
            <StatusPill
              domain="container.state"
              state={container.containerState}
              field="container.containerState"
              raw={container.containerState}
            />
          </FieldShell>
          <Field
            label="Exit Status:"
            field="container.containerExitStatus"
            raw={container.containerExitStatus}
            fmt="int"
            hint="YARN exit codes: 0 succeeded; -100 aborted; -101 disk failure; -102 preempted; -103 virtual-memory limit; -104 physical-memory limit; -1000 no valid exit status yet. Other values may be the process exit code."
          >
            <span className="tabular-nums">{container.containerExitStatus}</span>
          </Field>
          <Field label="Node:" field="container.nodeHttpAddress" raw={container.nodeHttpAddress} valueClassName="font-mono">
            {container.nodeHttpAddress ? (
              <a
                href={container.nodeHttpAddress}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all text-live underline-offset-2 hover:underline"
              >
                {container.nodeHttpAddress}
              </a>
            ) : (
              "N/A"
            )}
          </Field>
          <Field label="Node ID:" field="container.nodeId" raw={container.nodeId} valueClassName="font-mono text-small" />
          <Field
            label="Assigned Node ID:"
            field="container.assignedNodeId"
            raw={container.assignedNodeId}
            valueClassName="font-mono text-small"
          />
          <Field label="Priority:" field="container.priority" raw={container.priority} fmt="int" />
          <Field label="Started:" field="container.startedTime" raw={container.startedTime} fmt="epoch" />
          <Field label="Finished:" field="container.finishedTime" raw={container.finishedTime} fmt="epoch" />
          <Field
            label="Elapsed:"
            field="container.elapsedTime"
            raw={elapsed}
            fmt="ms"
            hint="Time since the container started; updates while the container is running."
          >
            {fmtDuration(elapsed)}
          </Field>
          <FieldShell label="Resource:" hint="Memory and virtual CPU cores allocated to this container.">
            <Datum field="container.derived.resourceText" raw={resourceText} className="tabular-nums">
              {resourceText}
            </Datum>
            <Datum field="container.allocatedMB" raw={container.allocatedMB} fmt="mb" as="span" className="sr-only" />
            <Datum field="container.allocatedVCores" raw={container.allocatedVCores} fmt="int" as="span" className="sr-only" />
          </FieldShell>
          <Field label="Logs:" field="container.logUrl" raw={container.logUrl}>
            <span className="flex flex-wrap items-center gap-2">
              <LogLink appId={appId} containerId={container.containerId} node={nodeHostPort(container)} user={undefined} />
              {container.logUrl && (
                <a
                  href={container.logUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="break-all text-small text-ink-3 underline-offset-2 hover:underline"
                >
                  NodeManager log URL (raw)
                </a>
              )}
            </span>
          </Field>
          <Field label="Exposed Ports:" field="container.exposedPorts" raw={container.exposedPorts} valueClassName="font-mono text-small">
            {container.exposedPorts || "{}"}
          </Field>
          <Field label="Attempt:" field="container.containerId" raw={container.containerId} valueClassName="font-mono">
            <Link
              to="/apps/$appId/attempts/$attemptId"
              params={{ appId, attemptId }}
              className="text-live underline-offset-2 hover:underline"
            >
              {attemptId}
            </Link>
          </Field>
        </dl>
        {mappedResources.length > 0 && (
          <div className="mt-1">
            <p className="min-w-0 text-small text-ink-4 break-words">
              Allocated resources (RM mapped notation):{" "}
              <Datum field="container.allocatedResources" raw={container.allocatedResources} className="font-mono text-small text-ink-2">
                {mappedResources.map(([name, value]) => `${name}=${value}`).join(", ")}
              </Datum>
            </p>
          </div>
        )}
      </Section>

      <Section title="Diagnostics" actions={<CopyButton text={container.diagnosticsInfo ?? ""} label="Copy diagnostics" />}>
        {container.diagnosticsInfo ? (
          <Datum
            as="pre"
            field="container.diagnosticsInfo"
            raw={container.diagnosticsInfo}
            data-burrow="container-diagnostics"
            className="burrow-scroll max-h-96 overflow-auto rounded-md border border-seam-soft bg-well p-2.5 font-mono text-micro leading-relaxed whitespace-pre-wrap text-ink-2"
          >
            {container.diagnosticsInfo}
          </Datum>
        ) : (
          <div data-burrow="no-container-diagnostics">
            <Datum field="container.diagnosticsInfo" raw={container.diagnosticsInfo ?? null} className="text-body text-ink-3">
              None
            </Datum>
            <p className="mt-1 text-small text-ink-3">
              The RM reported no diagnostics for this container. Launch and kill diagnostics are written by the NodeManager into the
              container's
              <code className="mx-1 font-mono">prelaunch.err</code>/<code className="mx-1 font-mono">stderr</code> logs, which need the log
              routes.
            </p>
          </div>
        )}
      </Section>
    </Entity>
  );
}
