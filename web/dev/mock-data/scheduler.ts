/** Capacity Scheduler tree (root → prod{etl,reports}, dev{alice,bob}, default) as `GET /ws/v1/cluster/scheduler` shapes it. */
import type { MockApp, MockCluster } from "./cluster.ts";
import { CLUSTER_BOUNDS, LONG_MAX, resourceInfo, round } from "./util.ts";

interface QSpec {
  name: string;
  path: string;
  /** capacity / maxCapacity (% of parent) per partition */
  cap: Record<string, number>;
  max: Record<string, number>;
  children?: QSpec[];
  acl?: string;
}

const P = (def: number, gpu: number, highmem: number) => ({ "": def, gpu, highmem });
const M = (def: number) => ({ "": def, gpu: 100, highmem: 100 });

export const QUEUE_TREE: QSpec = {
  name: "root",
  path: "root",
  cap: P(100, 100, 100),
  max: M(100),
  children: [
    {
      name: "prod",
      path: "root.prod",
      cap: P(60, 70, 40),
      max: M(100),
      children: [
        { name: "etl", path: "root.prod.etl", cap: P(40, 30, 50), max: M(100), acl: "etl,hdfs" },
        { name: "reports", path: "root.prod.reports", cap: P(60, 70, 50), max: M(80), acl: "svc-ml,etl" },
      ],
    },
    {
      name: "dev",
      path: "root.dev",
      cap: P(30, 20, 50),
      max: M(50),
      children: [
        { name: "alice", path: "root.dev.alice", cap: P(50, 50, 50), max: M(100), acl: "alice" },
        { name: "bob", path: "root.dev.bob", cap: P(50, 50, 50), max: M(60), acl: "bob" },
      ],
    },
    { name: "default", path: "root.default", cap: P(10, 10, 10), max: M(100), acl: "*" },
  ],
};

const PARTITIONS = ["", "gpu", "highmem"] as const;

function find(spec: QSpec, path: string): QSpec | undefined {
  if (spec.path === path) return spec;
  for (const ch of spec.children ?? []) {
    const f = find(ch, path);
    if (f) return f;
  }
  return undefined;
}

function absOf(spec: QSpec, path: string, part: string, kind: "cap" | "max", acc = 1): number {
  const own = spec[kind][part]! / 100;
  const here = kind === "max" ? acc * own : acc * own;
  if (spec.path === path) return here;
  for (const ch of spec.children ?? []) {
    if (path === ch.path || path.startsWith(`${ch.path}.`)) return absOf(ch, path, part, kind, here);
  }
  return NaN;
}

export function queueAbsCapacityPct(path: string, part = ""): number {
  return round(absOf(QUEUE_TREE, path, part, "cap") * 100, 2);
}

function partitionTotals(c: MockCluster, part: string): { mb: number; vc: number } {
  let mb = 0;
  let vc = 0;
  for (const n of c.nodes) {
    if (!n.schedulable) continue;
    if (part === "" ? n.labels.length === 0 : n.labels.includes(part)) {
      mb += n.totalMb;
      vc += n.totalVc;
    }
  }
  return { mb, vc };
}

export function queueCapacityMb(c: MockCluster, path: string, part: string): number {
  const abs = absOf(QUEUE_TREE, path, part, "cap");
  return Number.isNaN(abs) ? 0 : Math.round(partitionTotals(c, part).mb * abs);
}

// ------------------------------------------------------------------ usage

interface Use {
  mb: number;
  vc: number;
  containers: number;
  reservedMb: number;
  reservedVc: number;
  pendingMb: number;
  pendingVc: number;
  pendingContainers: number;
  amMb: number;
  amVc: number;
  running: number;
  accepted: number;
}

const zero = (): Use => ({
  mb: 0,
  vc: 0,
  containers: 0,
  reservedMb: 0,
  reservedVc: 0,
  pendingMb: 0,
  pendingVc: 0,
  pendingContainers: 0,
  amMb: 0,
  amVc: 0,
  running: 0,
  accepted: 0,
});

interface Usage {
  /** key `${path}|${partition}` */
  byQueue: Map<string, Use>;
  /** key `${path}|${user}` */
  byUser: Map<string, { use: Use; part: Map<string, Use> }>;
}

function addUse(into: Use, a: MockApp) {
  if (a.state === "RUNNING") {
    into.mb += a.containers * a.cmb;
    into.vc += a.containers * a.cvc;
    into.containers += a.containers;
    into.reservedMb += a.reservedMb;
    into.reservedVc += a.reservedVc;
    into.amMb += a.unmanaged ? 0 : a.cmb;
    into.amVc += a.unmanaged ? 0 : a.cvc;
    into.running++;
    const miss = Math.max(0, a.planContainers - a.containers);
    into.pendingMb += miss * a.cmb;
    into.pendingVc += miss * a.cvc;
    into.pendingContainers += miss;
  } else if (a.state === "ACCEPTED") {
    into.accepted++;
    into.pendingMb += a.planContainers * a.cmb;
    into.pendingVc += a.planContainers * a.cvc;
    into.pendingContainers += a.planContainers;
  }
}

function collectUsage(c: MockCluster): Usage {
  const byQueue = new Map<string, Use>();
  const byUser = new Map<string, { use: Use; part: Map<string, Use> }>();
  for (const a of c.liveApps()) {
    if (a.state !== "RUNNING" && a.state !== "ACCEPTED") continue;
    const segs = a.queue.split(".");
    for (let i = 1; i <= segs.length; i++) {
      const path = segs.slice(0, i).join(".");
      const key = `${path}|${a.label}`;
      let u = byQueue.get(key);
      if (!u) {
        u = zero();
        byQueue.set(key, u);
      }
      addUse(u, a);
    }
    const uk = `${a.queue}|${a.user}`;
    let ue = byUser.get(uk);
    if (!ue) {
      ue = { use: zero(), part: new Map() };
      byUser.set(uk, ue);
    }
    addUse(ue.use, a);
  }
  return { byQueue, byUser };
}

// ------------------------------------------------------------------ JSON

const vec = (pct: number) => {
  const s = `${pct.toFixed(1)}%`;
  return {
    configuredCapacityVector: `[memory-mb=${s},vcores=${s}]`,
    capacityVectorEntries: [
      { resourceName: "memory-mb", resourceValue: s },
      { resourceName: "vcores", resourceValue: s },
    ],
  };
};

const acls = (administer: string) => ({
  queueAcl: [
    { accessType: "ADMINISTER_QUEUE", accessControlList: administer },
    { accessType: "APPLICATION_MAX_PRIORITY", accessControlList: "*" },
    { accessType: "SUBMIT_APP", accessControlList: administer },
  ],
});

function partitionCapacities(c: MockCluster, q: QSpec, usage: Usage, leaf: boolean) {
  return {
    queueCapacitiesByPartition: PARTITIONS.map((part) => {
      const abs = absOf(QUEUE_TREE, q.path, part, "cap");
      const absMax = absOf(QUEUE_TREE, q.path, part, "max");
      const tot = partitionTotals(c, part);
      const u = usage.byQueue.get(`${q.path}|${part}`) ?? zero();
      const capMb = tot.mb * abs;
      return {
        partitionName: part,
        queueCapacityVectorInfo: vec(q.cap[part]!),
        capacity: q.cap[part]!,
        usedCapacity: capMb > 0 ? round((u.mb / capMb) * 100, 2) : 0,
        maxCapacity: q.max[part]!,
        absoluteCapacity: round(abs * 100, 2),
        absoluteUsedCapacity: tot.mb > 0 ? round((u.mb / tot.mb) * 100, 2) : 0,
        absoluteMaxCapacity: round(absMax * 100, 2),
        maxAMLimitPercentage: leaf ? 10 : 0,
        weight: -1,
        normalizedWeight: 0,
        configuredMinResource: resourceInfo(0, 0, CLUSTER_BOUNDS),
        configuredMaxResource: resourceInfo(0, 0, CLUSTER_BOUNDS),
        effectiveMinResource: resourceInfo(Math.round(capMb), Math.round(tot.vc * abs)),
        effectiveMaxResource: resourceInfo(Math.round(tot.mb * absMax), Math.round(tot.vc * absMax)),
      };
    }),
  };
}

function partitionResources(c: MockCluster, q: QSpec, usage: Usage) {
  return {
    resourceUsagesByPartition: PARTITIONS.map((part) => {
      const u = usage.byQueue.get(`${q.path}|${part}`) ?? zero();
      const abs = absOf(QUEUE_TREE, q.path, part, "cap");
      const tot = partitionTotals(c, part);
      const amMb = Math.round(tot.mb * abs * 0.1);
      const amVc = Math.max(1, Math.round(tot.vc * abs * 0.1));
      return {
        partitionName: part,
        used: resourceInfo(u.mb, u.vc),
        reserved: resourceInfo(u.reservedMb, u.reservedVc),
        pending: resourceInfo(u.pendingMb, u.pendingVc),
        amUsed: resourceInfo(u.amMb, u.amVc),
        amLimit: resourceInfo(amMb, amVc),
        userAmLimit: resourceInfo(amMb, amVc),
      };
    }),
  };
}

function queueJson(c: MockCluster, q: QSpec, usage: Usage, root = false): Record<string, unknown> {
  const leaf = !q.children;
  const u = usage.byQueue.get(`${q.path}|`) ?? zero();
  const abs = absOf(QUEUE_TREE, q.path, "", "cap");
  const absMax = absOf(QUEUE_TREE, q.path, "", "max");
  const tot = partitionTotals(c, "");
  const capMb = tot.mb * abs;
  const usedCap = capMb > 0 ? round((u.mb / capMb) * 100, 2) : 0;
  // totals over all partitions (labelled usage included) for container counters
  let containers = 0;
  let reservedContainers = 0;
  let pendingContainers = 0;
  for (const part of PARTITIONS) {
    const x = usage.byQueue.get(`${q.path}|${part}`);
    if (x) {
      containers += x.containers;
      reservedContainers += x.reservedMb > 0 ? 1 : 0;
      pendingContainers += x.pendingContainers;
    }
  }
  const amMb = Math.round(tot.mb * abs * 0.1);
  const amVc = Math.max(1, Math.round(tot.vc * abs * 0.1));
  const out: Record<string, unknown> = {};
  if (root) out.type = "capacityScheduler";
  else if (leaf) out.type = "capacitySchedulerLeafQueueInfo";
  if (!root) out.queuePath = q.path;
  Object.assign(out, {
    capacity: q.cap[""]!,
    usedCapacity: usedCap,
    maxCapacity: q.max[""]!,
    ...(root
      ? {}
      : {
          absoluteCapacity: round(abs * 100, 2),
          absoluteMaxCapacity: round(absMax * 100, 2),
          absoluteUsedCapacity: tot.mb > 0 ? round((u.mb / tot.mb) * 100, 2) : 0,
        }),
    weight: -1,
    normalizedWeight: 0,
    ...(root ? { queueCapacityVectorInfo: vec(100) } : { numApplications: u.running + u.accepted }),
    ...(root ? { queueName: "root", queuePath: "root" } : {}),
    maxParallelApps: 2147483647,
    ...(root ? {} : { queueName: q.name }),
    isAbsoluteResource: false,
    ...(root ? {} : { state: "RUNNING" }),
  });
  if (!leaf) {
    out.queues = { queue: q.children!.map((ch) => queueJson(c, ch, usage)) };
  }
  if (!root) {
    Object.assign(out, {
      resourcesUsed: resourceInfo(u.mb, u.vc),
      hideReservationQueues: false,
      nodeLabels: ["*"],
      allocatedContainers: containers,
      reservedContainers,
      pendingContainers,
    });
  }
  out.capacities = partitionCapacities(c, q, usage, leaf);
  if (root) {
    out.health = health(c);
  } else {
    out.resources = partitionResources(c, q, usage);
    out.minEffectiveCapacity = resourceInfo(Math.round(capMb), Math.round(tot.vc * abs));
    out.maxEffectiveCapacity = resourceInfo(Math.round(tot.mb * absMax), Math.round(tot.vc * absMax));
  }
  out.maximumAllocation = resourceInfo(CLUSTER_BOUNDS.maxMb, CLUSTER_BOUNDS.maxVc);
  out.queueAcls = acls(q.acl ?? "*");
  out.queuePriority = 0;
  out.orderingPolicyInfo = leaf ? "fifo" : "utilization";
  if (!root) {
    out.autoCreateChildQueueEnabled = false;
    out.leafQueueTemplate = {};
  }
  Object.assign(out, {
    mode: "percentage",
    queueType: leaf ? "leaf" : "parent",
    creationMethod: "static",
    autoCreationEligibility: "off",
    autoQueueTemplateProperties: {},
    autoQueueParentTemplateProperties: {},
    autoQueueLeafTemplateProperties: {},
  });
  if (leaf) {
    const users: unknown[] = [];
    for (const [key, ue] of usage.byUser) {
      if (!key.startsWith(`${q.path}|`)) continue;
      const username = key.slice(q.path.length + 1);
      users.push({
        username,
        resourcesUsed: resourceInfo(ue.use.mb, ue.use.vc),
        numPendingApplications: ue.use.accepted,
        numActiveApplications: ue.use.running,
        AMResourceUsed: resourceInfo(ue.use.amMb, ue.use.amVc),
        userResourceLimit: resourceInfo(Math.round(capMb), Math.round(tot.vc * abs)),
        resources: {
          resourceUsagesByPartition: [
            {
              partitionName: "",
              used: resourceInfo(ue.use.mb, ue.use.vc),
              reserved: resourceInfo(ue.use.reservedMb, ue.use.reservedVc),
              pending: resourceInfo(ue.use.pendingMb, ue.use.pendingVc),
              amUsed: resourceInfo(ue.use.amMb, ue.use.amVc),
              amLimit: resourceInfo(amMb, amVc),
              userAmLimit: resourceInfo(amMb, amVc),
            },
          ],
        },
        userWeight: 1,
        isActive: ue.use.running + ue.use.accepted > 0,
      });
    }
    Object.assign(out, {
      numActiveApplications: u.running,
      numPendingApplications: u.accepted,
      numContainers: containers,
      maxApplications: Math.round(10000 * abs),
      maxApplicationsPerUser: Math.round(10000 * abs),
      userLimit: 100,
      users: users.length ? { user: users } : {},
      userLimitFactor: 1,
      configuredMaxAMResourceLimit: 0.1,
      AMResourceLimit: resourceInfo(amMb, amVc),
      usedAMResource: resourceInfo(u.amMb, u.amVc),
      userAMResourceLimit: resourceInfo(amMb, amVc),
      preemptionDisabled: false,
      intraQueuePreemptionDisabled: true,
      defaultPriority: 0,
      isAutoCreatedLeafQueue: false,
      maxApplicationLifetime: -1,
      defaultApplicationLifetime: -1,
    });
  }
  return out;
}

function health(c: MockCluster) {
  const node = c.nodes[1]!;
  const op = (operation: string) => ({
    operation,
    nodeId: `${node.host}:${node.port}`,
    containerId: "container_1767000000000_0019_01_000007",
    queue: "root.prod.etl",
  });
  return {
    lastrun: c.now - 400,
    operationsInfo: [
      op("last-allocation"),
      { ...op("last-release"), queue: "root.dev.alice" },
      { operation: "last-preemption", nodeId: "N/A", containerId: "N/A", queue: "N/A" },
      { ...op("last-reservation"), queue: "root.prod.reports" },
    ],
    lastRunDetails: [
      { operation: "releases", count: 0, resources: resourceInfo(0, 0) },
      { operation: "allocations", count: 2, resources: resourceInfo(4096, 2) },
      { operation: "reservations", count: 0, resources: resourceInfo(0, 0) },
    ],
  };
}

export function schedulerResponse(c: MockCluster) {
  const usage = collectUsage(c);
  return { scheduler: { schedulerInfo: queueJson(c, QUEUE_TREE, usage, true), subClusterId: "mock-yarn" } };
}

export function schedulerConfResponse() {
  const props: Array<{ name: string; value: string }> = [];
  const walk = (q: QSpec) => {
    const base = `yarn.scheduler.capacity.${q.path}`;
    if (q.children) props.push({ name: `${base}.queues`, value: q.children.map((x) => x.name).join(",") });
    if (q.path !== "root") {
      props.push({ name: `${base}.capacity`, value: String(q.cap[""]) });
      props.push({ name: `${base}.maximum-capacity`, value: String(q.max[""]) });
      if (!q.children) {
        props.push({ name: `${base}.user-limit-factor`, value: "1" });
        props.push({ name: `${base}.acl_submit_applications`, value: q.acl ?? "*" });
      }
    }
    props.push({ name: `${base}.accessible-node-labels`, value: "*" });
    for (const l of ["gpu", "highmem"]) props.push({ name: `${base}.accessible-node-labels.${l}.capacity`, value: String(q.cap[l]) });
    q.children?.forEach(walk);
  };
  props.push({ name: "yarn.scheduler.capacity.maximum-applications", value: "10000" });
  props.push({ name: "yarn.scheduler.capacity.maximum-am-resource-percent", value: "0.1" });
  props.push({
    name: "yarn.scheduler.capacity.resource-calculator",
    value: "org.apache.hadoop.yarn.util.resource.DefaultResourceCalculator",
  });
  walk(QUEUE_TREE);
  return { property: props, subClusterId: "mock-yarn" };
}

export { find as findQueue, LONG_MAX };
