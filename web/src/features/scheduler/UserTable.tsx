/**
 * Per-queue users (Capacity leaf queues only). Entity per row is `queueuser` with key `<queuePath>#<username>` (per the
 * inventory owner), so repeated field ids across rows are never ambiguous.
 *
 * Resource columns render readable memory and vCore units. Raw REST values remain attached to the composite datum and its
 * memory / vCore leaves for the inventory/parity contract.
 */
import { Link } from "@tanstack/react-router";
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { DataTable } from "~/ui/data-table/data-table";
import type { ColDef } from "~/ui/data-table/features";
import { Datum } from "~/ui/datum";
import { type CustomResource, customResources, resourceInfoText } from "~/features/overview/derive";
import type { ResourceInfo, UserInfo } from "~/api/schemas";
import { fmtMB } from "~/lib/format";
import type { CapacityRaw } from "./model";
import { countText, fmtVcores, resourceValueText, userWeightText } from "./format";

/** A resource as the legacy page prints it (`customs` = non memory/vcores types, as `Resource.toString` walks them). */
export interface ResourceView {
  memory: number;
  vCores: number;
  customs: CustomResource[];
}

const viewOf = (r: ResourceInfo): ResourceView => ({ memory: r.memory, vCores: r.vCores, customs: customResources(r) });

/** `Resources.multiply(resource, by)`: every resource value is `(long)(value * by)`. */
export function scaleResource(r: ResourceInfo, by: number): ResourceView {
  const v = viewOf(r);
  return {
    memory: Math.trunc(v.memory * by),
    vCores: Math.trunc(v.vCores * by),
    customs: v.customs.map((c) => ({ ...c, value: Math.trunc(c.value * by) })),
  };
}

const NONE: ResourceInfo = { memory: 0, vCores: 0 };

export interface UserRow {
  user: UserInfo;
  queuePath: string;
  /** node-label partition the row was built for ("" = default) */
  partition: string;
  /** "Used Resource": the selected partition's `used`, falling back to aggregate `resourcesUsed` if unavailable */
  used: ResourceInfo | null;
  /** "User Limit Resource": `userResourceLimit` */
  userLimit: ResourceInfo | null;
  /** "Used AM Resource": `AMResourceUsed`, `Resources.none()` when the RM omits it */
  amUsed: ResourceInfo;
  /**
   * "Max AM Resource" (CapacitySchedulerPage.UserBlock): the QUEUE's partition `userAmLimit` (fallback `amLimit`), multiplied
   * by the user's weight when that is not 1.0. It is not the user's own `resources.resourceUsagesByPartition[].userAmLimit`.
   */
  maxAm: ResourceView | null;
}

export function userRows(queuePath: string, raw: CapacityRaw | undefined, partition = ""): UserRow[] {
  const queuePart = raw?.resources?.resourceUsagesByPartition?.find((p) => (p.partitionName ?? "") === partition);
  const queueAmLimit = queuePart?.userAmLimit ?? queuePart?.amLimit ?? null;
  return (raw?.users?.user ?? []).map((user) => {
    const weight = user.userWeight;
    const maxAm = queueAmLimit == null ? null : weight != null && weight !== 1 ? scaleResource(queueAmLimit, weight) : viewOf(queueAmLimit);
    // resourcesUsed aggregates every node-label partition; the stock UI's user table is scoped to one partition.
    const userPartitions = user.resources?.resourceUsagesByPartition;
    const selectedPartition = userPartitions?.find((p) => (p.partitionName ?? "") === partition);
    let used: ResourceInfo | null;
    if (userPartitions?.length) {
      used = selectedPartition?.used ?? NONE;
    } else if (partition === "") {
      used = user.resourcesUsed ?? null;
    } else {
      used = NONE;
    }
    return {
      user,
      queuePath,
      partition,
      used,
      userLimit: user.userResourceLimit ?? null,
      amUsed: user.AMResourceUsed ?? NONE,
      maxAm,
    };
  });
}

const RESOURCE_CLASS = "text-small whitespace-nowrap text-ink-2 tnum";

/**
 * Memory and vCores render with operator-friendly units. The composite datum keeps the upstream value, and leaf primitives
 * remain separately stamped for the inventory/parity contract.
 */
function ResourceValue({
  field,
  raw,
  res,
  leaf,
}: {
  field: string;
  raw: unknown;
  res: ResourceView | null;
  leaf?: { memory: string; vCores: string };
}) {
  if (!res) {
    return (
      <Datum field={field} raw={raw} className={RESOURCE_CLASS}>
        —
      </Datum>
    );
  }
  if (!leaf || res.customs.length) {
    return (
      <Datum field={field} raw={raw} className={RESOURCE_CLASS}>
        {resourceValueText(res.memory, res.vCores, res.customs)}
      </Datum>
    );
  }
  return (
    <Datum field={field} raw={raw} className={RESOURCE_CLASS}>
      <Datum field={leaf.memory} raw={res.memory} fmt="mb">
        {fmtMB(res.memory)}
      </Datum>
      {" · "}
      <Datum field={leaf.vCores} raw={res.vCores} fmt="int">
        {fmtVcores(res.vCores)}
      </Datum>
    </Datum>
  );
}

const PART_USED = "queueuser.resources.resourceUsagesByPartition.used";

function usedCell(row: UserRow) {
  const def = row.partition === "";
  return (
    <ResourceValue
      field="queueuser.resourcesUsed"
      raw={row.used}
      res={row.used ? viewOf(row.used) : null}
      leaf={
        def
          ? { memory: "queueuser.resourcesUsed.memory", vCores: "queueuser.resourcesUsed.vCores" }
          : { memory: `${PART_USED}.memory`, vCores: `${PART_USED}.vCores` }
      }
    />
  );
}

const BASE_COLS: ColDef<UserRow>[] = [
  {
    id: "username",
    meta: { label: "User Name", pinned: true },
    size: 160,
    cell: ({ row }) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <Datum field="queueuser.username" raw={row.original.user.username} className="truncate font-medium">
          {row.original.user.username}
        </Datum>
        {/* Legacy renders isActive as the row's background tint only; always tag it so a false row is
            still observable (CapacitySchedulerPage.java:290-291, inventory legacy.rm.scheduler.capacity.users.highlight). */}
        {row.original.user.isActive && (
          <Datum field="queueuser.isActive" raw={true} className="rounded-xs bg-wait/20 px-1 text-micro text-wait">
            active
          </Datum>
        )}
        {!row.original.user.isActive && <Datum field="queueuser.isActive" raw={false} className="hidden" />}
      </span>
    ),
  },
  {
    id: "userLimit",
    meta: { label: "User Limit Resource", hint: "userResourceLimit — the resources this user may hold" },
    size: 210,
    cell: ({ row }) => (
      <ResourceValue
        field="queueuser.userResourceLimit"
        raw={row.original.userLimit}
        res={row.original.userLimit ? viewOf(row.original.userLimit) : null}
        leaf={{ memory: "queueuser.userResourceLimit.memory", vCores: "queueuser.userResourceLimit.vCores" }}
      />
    ),
  },
  {
    id: "weight",
    meta: { label: "Weight", align: "end", hint: "userWeight" },
    size: 100,
    cell: ({ row }) => (
      <Datum field="queueuser.userWeight" raw={row.original.user.userWeight} className="tnum">
        {userWeightText(row.original.user.userWeight)}
      </Datum>
    ),
  },
  {
    id: "used",
    meta: { label: "Used Resource", hint: "resourcesUsed (or the partition-specific resources.resourceUsagesByPartition[].used)" },
    size: 210,
    cell: ({ row }) => usedCell(row.original),
  },
  {
    id: "maxAm",
    meta: {
      label: "Max AM Resource",
      hint: "The queue's per-user AM limit for this partition (resources.resourceUsagesByPartition[].userAmLimit, falling back to amLimit), multiplied by the user weight when the weight is not 1.",
    },
    size: 210,
    cell: ({ row }) => {
      const res = row.original.maxAm;
      const text = res ? resourceInfoText(res.memory, res.vCores, res.customs) : null;
      return <ResourceValue field="queueuser.derived.maxAmResource" raw={text} res={res} />;
    },
  },
  {
    id: "usedAm",
    meta: { label: "Used AM Resource", hint: "AMResourceUsed" },
    size: 210,
    cell: ({ row }) => (
      <ResourceValue
        field="queueuser.AMResourceUsed"
        raw={row.original.amUsed}
        res={viewOf(row.original.amUsed)}
        leaf={{ memory: "queueuser.AMResourceUsed.memory", vCores: "queueuser.AMResourceUsed.vCores" }}
      />
    ),
  },
  {
    id: "activeApps",
    meta: { label: "Schedulable Apps", align: "end", hint: "numActiveApplications" },
    size: 140,
    cell: ({ row }) => (
      <Datum field="queueuser.numActiveApplications" raw={row.original.user.numActiveApplications} fmt="int" className="tnum">
        {countText(row.original.user.numActiveApplications)}
      </Datum>
    ),
  },
  {
    id: "pendingApps",
    meta: { label: "Non-Schedulable Apps", align: "end", hint: "numPendingApplications" },
    size: 168,
    cell: ({ row }) => (
      <Datum field="queueuser.numPendingApplications" raw={row.original.user.numPendingApplications} fmt="int" className="tnum">
        {countText(row.original.user.numPendingApplications)}
      </Datum>
    ),
  },
];

/** The cross-queue listing leads with the queue each row belongs to (a plain link: the row's entity is the user, not the queue). */
const QUEUE_COL: ColDef<UserRow> = {
  id: "queue",
  meta: { label: "Queue", hint: "the leaf queue this user has applications in" },
  size: 170,
  cell: ({ row }) => (
    <Link
      to="/scheduler/$queue"
      params={{ queue: row.original.queuePath }}
      className="truncate font-mono text-small text-live hover:underline"
    >
      {row.original.queuePath}
    </Link>
  ),
};

const COLS_WITH_QUEUE: ColDef<UserRow>[] = [QUEUE_COL, ...BASE_COLS];

export function UserTable({
  rows,
  loading,
  sorting,
  onSortingChange,
  columnVisibility,
  onColumnVisibilityChange,
  className,
  showQueue = false,
  stableViewport = false,
}: {
  rows: UserRow[];
  loading?: boolean;
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  columnVisibility: ColumnVisibilityState;
  onColumnVisibilityChange: (v: ColumnVisibilityState) => void;
  className?: string;
  /** add a leading Queue column (rows from several queues) */
  showQueue?: boolean;
  /** Keep live-refreshing user lists bounded once they exceed a few visible rows. */
  stableViewport?: boolean;
}) {
  return (
    <div className={className}>
      <DataTable
        data={rows}
        columns={showQueue ? COLS_WITH_QUEUE : BASE_COLS}
        getRowId={(r) => `${r.queuePath}#${r.user.username}`}
        entityKey={(r) => `${r.queuePath}#${r.user.username}`}
        label="Queue users"
        storageKey={showQueue ? "scheduler-all-users" : "scheduler-users"}
        sorting={sorting}
        onSortingChange={onSortingChange}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={onColumnVisibilityChange}
        defaultVisibility={{}}
        loading={loading}
        empty={
          <div className="px-4 py-10 text-center text-body text-ink-3">
            No user has submitted to this queue yet.
            <p className="mt-1 text-small text-ink-4">The RM lists a user here once the queue has an application from them.</p>
          </div>
        }
        exportName="queue-users"
        totalCount={rows.length}
        className="h-[min(40dvh,420px)]"
        stableViewport={stableViewport}
      />
    </div>
  );
}
