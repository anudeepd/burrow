/**
 * The 24 columns of the legacy RM `#apps` table, verbatim and in source order, from
 * `.cluster/src-extract/hadoop-yarn-server-resourcemanager/.../RMAppsBlock.java` (COLUMNS, lines 56-81) with the value
 * expressions from the same file (98-224) and the client-side renderers from
 * `.cluster/src-extract/hadoop-yarn-common/webapps/static/yarn.dt.plugins.js` (99-134).
 *
 * Column ids ARE the legacy CSS selectors (`.id`, `.IDlaunchtime`, …) minus the dot, so the URL's `sort`/`cols` tokens
 * map 1:1 onto the inventory's field ids. Labels use readable spacing and consistent vCores capitalization.
 *
 * Every cell renders through `<Datum>`: `data-yv` is the raw upstream value (`-1`, `0`, epoch ms, "UNASSIGNED"), never
 * the formatted text, and `data-yfmt` tells the parity harness which normaliser to use. Where the legacy table showed
 * "N/A" for a sentinel value, the sentinel stays in `data-yv` and only the visible text changes.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { q } from "~/api/queries";
import { adaptive } from "~/api/refetch";
import { type App, selectAppAttempts } from "~/api/schemas";
import { trackingHref, trackingUiText } from "~/features/overview/derive";
import type { Fmt } from "~/lib/format";
import { useUpstreamBases } from "~/lib/upstream-url";
import { useParity } from "~/state/parity";
import { datumAttrs, Datum } from "~/ui/datum";
import type { ColDef } from "~/ui/data-table/features";
import { ProgressBar } from "~/ui/progress-bar";
import { StatusPill } from "~/ui/status";
import { Tooltip } from "~/ui/tooltip";
import { blacklistedNodesCount } from "./view";

/** Values the legacy table printed as `N/A` because the RM reports a sentinel. */
const isSentinel = (v: number | undefined): boolean => v === -1 || v === undefined || Number.isNaN(v);

function NumCell({ field, value, fmt = "int", na = false }: { field: string; value: number | undefined; fmt?: Fmt; na?: boolean }) {
  return (
    <Datum field={field} raw={value} fmt={fmt} className={na ? "text-ink-4" : undefined}>
      {na ? "N/A" : undefined}
    </Datum>
  );
}

function EpochCell({ field, value }: { field: string; value: number | undefined }) {
  return <Datum field={field} raw={value} fmt="epoch" />;
}

const isCompleted = (app: App): boolean => app.state === "FINISHED" || app.state === "FAILED" || app.state === "KILLED";

/** The legacy GPU rule: a completed app that used no GPU shows "N/A"; otherwise the raw number (even -1). */
function gpuCell(app: App, field: string, value: number | undefined) {
  const na = isCompleted(app) && (value ?? 0) <= 0;
  return <NumCell field={field} value={value} na={na} />;
}

/**
 * Legacy "Blacklisted Nodes" cell. The list endpoint has no such key (legacy reads the in-JVM attempt object), so the
 * count comes from the app's `appattempts` resource — fetched only for rows that are actually mounted (the table
 * virtualizes; parity mode mounts them all) and refreshed slowly, never on the live-poll cadence of the list itself.
 * `data-yn` marks "no value": no attempt yet (legacy `N/A`), still loading, or the attempts request failed.
 */
function BlacklistedCell({ appId }: { appId: string }) {
  const parity = useParity();
  const query = q.appAttempts(appId);
  const attempts = useQuery({
    ...query,
    ...adaptive("slow", query.meta ?? {}),
    staleTime: parity ? Number.POSITIVE_INFINITY : 60_000,
  });
  const count = attempts.data ? blacklistedNodesCount(selectAppAttempts(attempts.data)) : undefined;
  return (
    <Datum
      field="app.derived.blacklistedNodesCount"
      raw={count}
      fmt="int"
      className={count === undefined ? "text-ink-4" : undefined}
      title={count === undefined && attempts.isError ? "Could not read this application's attempts" : undefined}
    >
      {count === undefined ? (attempts.isLoading ? "…" : "N/A") : undefined}
    </Datum>
  );
}

/**
 * Legacy "Tracking UI" cell (`RMAppsBlock.java:207-213`). The label follows the state (`trackingUiText`); the anchor
 * points at the REST `trackingUrl` when present, else the RM's own `/proxy/<appId>/` for a live app whose payload omits
 * it (the RM advertises that URL for ACCEPTED apps the REST list does not carry). `data-yv` on the anchor is the URL
 * actually used, so the harness compares the link target the legacy page embedded.
 */
function TrackingUiCell({ app }: { app: App }) {
  const bases = useUpstreamBases();
  const label = trackingUiText(app);
  const url = trackingHref(app, bases.rm);
  return (
    <Datum field="app.trackingUI" raw={app.trackingUI} as="span" className="truncate">
      <Datum field="app.derived.trackingUiText" raw={label} fmt="text" as="span" className="truncate">
        {url ? (
          <Tooltip label={url}>
            <a
              {...datumAttrs("app.trackingUrl", url)}
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate text-live outline-offset-2 hover:underline"
              /* the row activates the app; without this the list also navigates away while the tracking tab opens */
              onClick={(e) => e.stopPropagation()}
            >
              {label}
            </a>
          </Tooltip>
        ) : (
          <Datum
            field="app.trackingUrl"
            raw={app.trackingUrl}
            as="span"
            className="truncate text-ink-4"
            title="No tracking URL has been assigned yet"
          >
            {label}
          </Datum>
        )}
      </Datum>
    </Datum>
  );
}

export const APPS_COLUMNS: ColDef<App>[] = [
  {
    id: "id",
    accessorKey: "id",
    sortFn: "text",
    size: 240,
    meta: { label: "ID", pinned: true, hint: "Application id — opens the application page" },
    cell: ({ row }) => (
      <Datum field="app.id" raw={row.original.id} as="span" className="min-w-0">
        <Link
          to="/apps/$appId"
          params={{ appId: row.original.id }}
          className="burrow-touch-link block truncate font-mono text-small text-live outline-offset-2 hover:underline"
        >
          {row.original.id}
        </Link>
      </Datum>
    ),
  },
  {
    id: "user",
    accessorKey: "user",
    sortFn: "text",
    size: 96,
    meta: { label: "User", hint: "User who submitted the application" },
    cell: ({ row }) => <Datum field="app.user" raw={row.original.user} className="truncate" />,
  },
  {
    id: "name",
    accessorKey: "name",
    sortFn: "text",
    size: 220,
    meta: { label: "Name", hint: "Application name" },
    cell: ({ row }) => <Datum field="app.name" raw={row.original.name} className="truncate" title={row.original.name} />,
  },
  {
    id: "type",
    accessorKey: "applicationType",
    sortFn: "text",
    size: 130,
    meta: { label: "Application Type", hint: "e.g. SPARK, MAPREDUCE" },
    cell: ({ row }) => <Datum field="app.applicationType" raw={row.original.applicationType} className="truncate" />,
  },
  {
    id: "apptag",
    accessorKey: "applicationTags",
    sortFn: "text",
    size: 140,
    meta: { label: "Application Tags", hint: "Comma-joined application tags" },
    cell: ({ row }) => (
      <Datum field="app.applicationTags" raw={row.original.applicationTags} className="truncate" title={row.original.applicationTags} />
    ),
  },
  {
    id: "queue",
    accessorKey: "queue",
    sortFn: "text",
    size: 120,
    meta: { label: "Queue", hint: "Scheduler queue path — opens the queue's scheduler page" },
    cell: ({ row }) => (
      <Datum field="app.queue" raw={row.original.queue} as="span" className="min-w-0">
        {/* same treatment as the app detail's Queue field: the value is a way into the scheduler, so it is a link */}
        <Link
          to="/scheduler/$queue"
          params={{ queue: row.original.queue }}
          className="block truncate font-mono text-small text-live outline-offset-2 hover:underline"
          /* the row itself activates the app: an inner link has to stop the click from bubbling (see the ID cell's
             sibling links and `nodes/columns.tsx`) */
          onClick={(e) => e.stopPropagation()}
        >
          {row.original.queue}
        </Link>
      </Datum>
    ),
  },
  {
    id: "priority",
    accessorKey: "priority",
    sortFn: "basic",
    size: 144,
    meta: { label: "Application Priority", hint: "0 means the queue default" },
    cell: ({ row }) => <Datum field="app.priority" raw={row.original.priority} fmt="int" />,
  },
  {
    id: "starttime",
    accessorKey: "startedTime",
    sortFn: "basic",
    size: 160,
    meta: { label: "Start time", hint: "When the application was submitted" },
    cell: ({ row }) => <EpochCell field="app.startedTime" value={row.original.startedTime} />,
  },
  {
    id: "IDlaunchtime",
    accessorKey: "launchTime",
    sortFn: "basic",
    size: 160,
    meta: { label: "Launch time", hint: "When the ApplicationMaster container was launched" },
    cell: ({ row }) => <EpochCell field="app.launchTime" value={row.original.launchTime} />,
  },
  {
    id: "finishtime",
    accessorKey: "finishedTime",
    sortFn: "basic",
    size: 160,
    meta: { label: "Finish time", hint: "When the application finished. A dash means it has not finished yet." },
    cell: ({ row }) => <EpochCell field="app.finishedTime" value={row.original.finishedTime} />,
  },
  {
    id: "state",
    accessorKey: "state",
    sortFn: "text",
    size: 110,
    meta: { label: "State", hint: "Current lifecycle state tracked by the ResourceManager, from submission through completion." },
    cell: ({ row }) => <StatusPill domain="app.state" state={row.original.state} field="app.state" size="sm" />,
  },
  {
    id: "finalstatus",
    accessorKey: "finalStatus",
    sortFn: "text",
    size: 110,
    meta: { label: "Final status", hint: "Final outcome reported by the ApplicationMaster. Undefined means no outcome has been reported." },
    cell: ({ row }) => <StatusPill domain="app.finalStatus" state={row.original.finalStatus} field="app.finalStatus" size="sm" />,
  },
  {
    id: "runningcontainer",
    accessorKey: "runningContainers",
    sortFn: "basic",
    size: 144,
    meta: { label: "Running Containers", hint: "-1 means the RM had no resource report (shown as N/A)" },
    cell: ({ row }) => (
      <NumCell field="app.runningContainers" value={row.original.runningContainers} na={isSentinel(row.original.runningContainers)} />
    ),
  },
  {
    id: "allocatedCpu",
    accessorKey: "allocatedVCores",
    sortFn: "basic",
    size: 156,
    meta: { label: "Allocated CPU vCores", hint: "-1 means no resource report (shown as N/A)" },
    cell: ({ row }) => (
      <NumCell field="app.allocatedVCores" value={row.original.allocatedVCores} na={isSentinel(row.original.allocatedVCores)} />
    ),
  },
  {
    id: "allocatedMemory",
    accessorKey: "allocatedMB",
    sortFn: "basic",
    size: 160,
    meta: { label: "Allocated Memory MB", hint: "-1 means no resource report (shown as N/A)" },
    cell: ({ row }) => <NumCell field="app.allocatedMB" value={row.original.allocatedMB} na={isSentinel(row.original.allocatedMB)} />,
  },
  {
    id: "allocatedGpu",
    accessorKey: "allocatedGpus",
    sortFn: "basic",
    size: 124,
    meta: { label: "Allocated GPUs", hint: "Only reported when the GPU resource type is configured" },
    cell: ({ row }) => gpuCell(row.original, "app.allocatedGpus", row.original.allocatedGpus),
  },
  {
    id: "reservedCpu",
    accessorKey: "reservedVCores",
    sortFn: "basic",
    size: 156,
    meta: { label: "Reserved CPU vCores", hint: "Resources reserved for this application" },
    cell: ({ row }) => (
      <NumCell field="app.reservedVCores" value={row.original.reservedVCores} na={isSentinel(row.original.reservedVCores)} />
    ),
  },
  {
    id: "reservedMemory",
    accessorKey: "reservedMB",
    sortFn: "basic",
    size: 156,
    meta: { label: "Reserved Memory MB", hint: "Memory reserved for this application" },
    cell: ({ row }) => <NumCell field="app.reservedMB" value={row.original.reservedMB} na={isSentinel(row.original.reservedMB)} />,
  },
  {
    id: "reservedGpu",
    accessorKey: "reservedGpus",
    sortFn: "basic",
    size: 124,
    meta: { label: "Reserved GPUs", hint: "Only reported when the GPU resource type is configured" },
    cell: ({ row }) => gpuCell(row.original, "app.reservedGpus", row.original.reservedGpus),
  },
  {
    id: "queuePercentage",
    accessorKey: "queueUsagePercentage",
    sortFn: "basic",
    size: 100,
    meta: { label: "% of Queue", hint: "Share of the queue's capacity used by this application" },
    cell: ({ row }) => <Datum field="app.queueUsagePercentage" raw={row.original.queueUsagePercentage} fmt="pct" />,
  },
  {
    id: "clusterPercentage",
    accessorKey: "clusterUsagePercentage",
    sortFn: "basic",
    size: 104,
    meta: { label: "% of Cluster", hint: "Share of the cluster's capacity used by this application" },
    cell: ({ row }) => <Datum field="app.clusterUsagePercentage" raw={row.original.clusterUsagePercentage} fmt="pct" />,
  },
  {
    id: "progress",
    accessorKey: "progress",
    sortFn: "basic",
    size: 140,
    meta: { label: "Progress", hint: "Application progress as reported by the ApplicationMaster" },
    cell: ({ row }) => {
      const p = row.original.progress;
      const live = row.original.state === "RUNNING";
      return (
        <span className="flex w-full items-center gap-2">
          <ProgressBar
            percent={p}
            live={live}
            tone={live ? "live" : "idle"}
            label={`Progress ${p.toFixed(1)}%`}
            datum={datumAttrs("app.progress", p, "pct")}
            className="min-w-8 flex-1"
          />
          <span aria-hidden="true" className="burrow-progress-value text-small text-ink-3">
            {p.toFixed(1)}%
          </span>
        </span>
      );
    },
  },
  {
    id: "ui",
    accessorKey: "trackingUI",
    sortFn: "text",
    size: 130,
    meta: { label: "Tracking UI", hint: "ApplicationMaster (running) or History (finished) — opens the tracking URL" },
    cell: ({ row }) => <TrackingUiCell app={row.original} />,
  },
  {
    id: "blacklisted",
    accessorKey: "id",
    enableSorting: false,
    size: 136,
    meta: {
      label: "Blacklisted Nodes",
      hint: "Number of nodes the current ApplicationMaster attempt blacklisted (from the application's appattempts); N/A when the app has no attempt yet",
    },
    cell: ({ row }) => <BlacklistedCell appId={row.original.id} />,
  },
];

/** Column ids in legacy order — the URL's `cols` token and the parity "every column" set. */
export const APPS_COLUMN_IDS: string[] = APPS_COLUMNS.map((c) => String(c.id));

/** Field ids this page renders, in legacy order — used by the parity spec to assert coverage. */
export const APPS_FIELD_IDS: string[] = [
  "app.id",
  "app.user",
  "app.name",
  "app.applicationType",
  "app.applicationTags",
  "app.queue",
  "app.priority",
  "app.startedTime",
  "app.launchTime",
  "app.finishedTime",
  "app.state",
  "app.finalStatus",
  "app.runningContainers",
  "app.allocatedVCores",
  "app.allocatedMB",
  "app.allocatedGpus",
  "app.reservedVCores",
  "app.reservedMB",
  "app.reservedGpus",
  "app.queueUsagePercentage",
  "app.clusterUsagePercentage",
  "app.progress",
  "app.trackingUI",
  "app.derived.blacklistedNodesCount",
];
