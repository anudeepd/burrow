/**
 * In-memory fake YARN cluster: nodes, queues, applications and their evolution over time.
 * Pure data + rules; JSON shapes live in rm.ts / scheduler.ts.
 */
import { Rng, seedOf, pad } from "./util.ts";

export const CLUSTER_TS = 1767000000000;
export const FIXED_NOW = 1767225600000; // 2026-01-01T00:00:00Z, used when MOCK_FROZEN=1
export const RM_HOST = "rm1.mock.local:8088";
export const JHS = "jhs.mock.local:19888";
export const SHS = "shs.mock.local:18080";

export type AppState = "NEW" | "NEW_SAVING" | "SUBMITTED" | "ACCEPTED" | "RUNNING" | "FINISHED" | "FAILED" | "KILLED";
export type FinalStatus = "UNDEFINED" | "SUCCEEDED" | "FAILED" | "KILLED";
export type NodeState = "RUNNING" | "UNHEALTHY" | "DECOMMISSIONING" | "DECOMMISSIONED" | "LOST" | "REBOOTED" | "SHUTDOWN" | "NEW";

export interface MockNode {
  idx: number;
  host: string;
  port: number;
  httpPort: number;
  rack: string;
  state: NodeState;
  labels: string[];
  totalMb: number;
  totalVc: number;
  healthReport: string;
  lastHealthAge: number; // ms before `now`
  version: string;
  usedMb: number;
  usedVc: number;
  containers: number;
  /** in the scheduler (RUNNING + DECOMMISSIONING); unhealthy/lost nodes are not */
  schedulable: boolean;
}

export interface MockAttempt {
  id: number;
  startTime: number;
  finishedTime: number;
  state: string; // RMAppAttemptState
  nodeIdx: number; // -1: no master container
}

export interface MockApp {
  num: number;
  id: string;
  user: string;
  name: string;
  queue: string; // full leaf path
  state: AppState;
  finalStatus: FinalStatus;
  progress: number; // 0..100
  type: string;
  tags: string[];
  priority: number;
  startedTime: number;
  launchTime: number;
  finishedTime: number;
  diag: string;
  /** current allocation */
  containers: number;
  cmb: number;
  cvc: number;
  reservedMb: number;
  reservedVc: number;
  /** allocation the app wants once it runs */
  planContainers: number;
  label: string; // node-label expression partition ("" = default)
  unmanaged: boolean;
  noTracking: boolean;
  logAgg: string;
  attempts: MockAttempt[];
  lifetimeSec: number; // -1 = unlimited
  memSec: number;
  vcSec: number;
  preemptedMb: number;
  preemptedAm: number;
  preemptedNonAm: number;
  /** rng stream for values that should stay stable across requests */
  seed: number;
}

export const LEAF_QUEUES = ["root.prod.etl", "root.prod.reports", "root.dev.alice", "root.dev.bob", "root.default"] as const;
export const USERS = ["alice", "bob", "etl", "svc-ml", "hdfs"] as const;
const USER_QUEUE: Record<string, string> = {
  alice: "root.dev.alice",
  bob: "root.dev.bob",
  etl: "root.prod.etl",
  "svc-ml": "root.prod.reports",
  hdfs: "root.default",
};
const TYPES = ["SPARK", "MAPREDUCE", "TEZ", "yarn-service", "DISTRIBUTED_SHELL"] as const;
const TAG_POOL = ["nightly", "prod", "adhoc", "ml", "etl", "backfill", "team-data", "priority", "oozie:abc123", "cost-center-42"];

interface Tpl {
  state: AppState;
  final?: FinalStatus;
  type: string;
  user: string;
  queue?: string;
  name: string;
  tags?: string[];
  prio?: number;
  ageMin: number;
  durMin?: number;
  progress?: number;
  cont?: number;
  cmb?: number;
  cvc?: number;
  diag?: string;
  label?: string;
  attempts?: "twoFailed" | "failedThenRunning";
  unmanaged?: boolean;
  noTracking?: boolean;
  reservedMb?: number;
  lifetimeSec?: number;
}

const LONG_NAME =
  "com.example.analytics.pipelines.sessionization.SessionizationDriver --input hdfs://nameservice1/warehouse/events/dt=2026-01-01/hour=* --output hdfs://nameservice1/warehouse/sessions --window 30m --late-arrival-tolerance 2h --partitions 4096";

const TEMPLATES: Tpl[] = [
  {
    state: "FINISHED",
    final: "SUCCEEDED",
    type: "MAPREDUCE",
    user: "alice",
    name: "word count — Q4 corpus (full text, 3 shards)",
    ageMin: 180,
    durMin: 17,
    tags: ["adhoc"],
  },
  {
    state: "FINISHED",
    final: "SUCCEEDED",
    type: "SPARK",
    user: "etl",
    name: "daily-aggregates",
    ageMin: 160,
    durMin: 42,
    tags: ["nightly", "prod"],
    prio: 3,
  },
  {
    state: "FINISHED",
    final: "FAILED",
    type: "SPARK",
    user: "etl",
    name: "sessionize-clickstream",
    ageMin: 150,
    durMin: 6,
    tags: ["nightly"],
    diag: "User class threw exception: java.lang.IllegalStateException: partition 17 missing\n\tat com.example.Sessionize$.run(Sessionize.scala:88)\n\tat com.example.Sessionize.main(Sessionize.scala)",
  },
  {
    state: "FINISHED",
    final: "KILLED",
    type: "MAPREDUCE",
    user: "bob",
    name: "terasort 1TB",
    ageMin: 140,
    durMin: 3,
    diag: "Application killed by user bob.",
  },
  {
    state: "FAILED",
    final: "FAILED",
    type: "TEZ",
    user: "svc-ml",
    name: "hive query: INSERT OVERWRITE TABLE features",
    ageMin: 130,
    durMin: 9,
    attempts: "twoFailed",
    diag: "Application application_X failed 2 times due to AM Container for appattempt_X exited with  exitCode: 143\nFailing this attempt.Diagnostics: [2026-01-01 00:10:00.000]Container killed on request. Exit code is 143\nFor more detailed output, check the application tracking page: http://rm1.mock.local:8088/cluster/app/application_X Then click on links to logs of each attempt.\n. Failing the application.",
  },
  {
    state: "KILLED",
    final: "KILLED",
    type: "DISTRIBUTED_SHELL",
    user: "alice",
    name: "distributed-shell smoke test",
    ageMin: 125,
    durMin: 1,
    diag: "Application killed by user alice.",
  },
  {
    state: "FINISHED",
    final: "SUCCEEDED",
    type: "TEZ",
    user: "hdfs",
    name: "HIVE-0a1b2c3d-metastore-compaction",
    ageMin: 120,
    durMin: 11,
    queue: "root.default",
  },
  {
    state: "FINISHED",
    final: "SUCCEEDED",
    type: "yarn-service",
    user: "svc-ml",
    name: "model-serving-canary",
    ageMin: 115,
    durMin: 25,
    tags: ["ml"],
  },
  {
    state: "FINISHED",
    final: "SUCCEEDED",
    type: "SPARK",
    user: "alice",
    name: "データ変換 – nightly ünïcode 🚀 ж",
    ageMin: 110,
    durMin: 14,
    noTracking: true,
  },
  {
    state: "FINISHED",
    final: "FAILED",
    type: "MAPREDUCE",
    user: "bob",
    name: "grep-search-join",
    ageMin: 100,
    durMin: 5,
    diag: "Task failed task_X_m_000003\nJob failed as tasks failed. failedMaps:1 failedReduces:0 killedMaps:0 killedReduces: 0",
  },
  {
    state: "KILLED",
    final: "KILLED",
    type: "SPARK",
    user: "etl",
    name: "adhoc-notebook-session",
    ageMin: 95,
    durMin: 33,
    diag: "Application killed by user etl.",
  },
  {
    state: "FINISHED",
    final: "SUCCEEDED",
    type: "SPARK",
    user: "alice",
    name: "feature-engineering v2",
    ageMin: 90,
    durMin: 28,
    tags: ["ml", "team-data", "adhoc"],
    prio: 1,
  },
  { state: "NEW", type: "SPARK", user: "bob", name: "just-submitted", ageMin: 0.02, queue: "root.default" },
  { state: "NEW_SAVING", type: "MAPREDUCE", user: "alice", name: "saving-state", ageMin: 0.03 },
  { state: "SUBMITTED", type: "TEZ", user: "svc-ml", name: "submitted-awaiting-accept", ageMin: 0.1 },
  {
    state: "ACCEPTED",
    type: "SPARK",
    user: "etl",
    name: "pending-big-join",
    ageMin: 6,
    cont: 24,
    cmb: 4096,
    cvc: 2,
    tags: ["prod"],
    diag: "[Mon Jan 01 00:00:00 +0000 2026] Application is added to the scheduler and is not yet activated. Queue's AM resource limit exceeded.  Details : AM Partition = <DEFAULT_PARTITION>; AM Resource Request = <memory:2048, max memory:16384, vCores:1, max vCores:8>; Queue Resource Limit for AM = <memory:19660, vCores:1>; User AM Resource Limit of the queue = <memory:19660, vCores:1>; Queue AM Resource Usage = <memory:18432, vCores:9>;",
  },
  {
    state: "ACCEPTED",
    type: "MAPREDUCE",
    user: "bob",
    name: "pending-sort",
    ageMin: 4,
    cont: 6,
    cmb: 2048,
    cvc: 1,
    diag: "[Mon Jan 01 00:00:00 +0000 2026] Application is Activated, waiting for resources to be assigned for AM.  Details : AM Partition = <DEFAULT_PARTITION>; Partition Resource = <memory:196608, vCores:96>; Queue's Absolute capacity = 15.0 % ; Queue's Absolute used capacity = 0.0 % ; Queue's Absolute max capacity = 15.0 % ;",
  },
  { state: "ACCEPTED", type: "TEZ", user: "svc-ml", name: "pending-hive-join", ageMin: 2, cont: 4, cmb: 2048, cvc: 1 },
  {
    state: "RUNNING",
    type: "SPARK",
    user: "etl",
    name: "ingest-stream-batch",
    ageMin: 55,
    progress: 45,
    cont: 24,
    cmb: 2048,
    cvc: 1,
    tags: ["prod", "etl"],
    prio: 5,
  },
  {
    state: "RUNNING",
    type: "SPARK",
    user: "alice",
    name: "notebook: exploring sales",
    ageMin: 38,
    progress: 12,
    cont: 8,
    cmb: 2048,
    cvc: 1,
  },
  { state: "RUNNING", type: "MAPREDUCE", user: "bob", name: "terasort 100GB", ageMin: 21, progress: 63.5, cont: 10, cmb: 1536, cvc: 1 },
  {
    state: "RUNNING",
    type: "TEZ",
    user: "svc-ml",
    name: "gpu-embedding-train",
    ageMin: 70,
    progress: 31,
    cont: 6,
    cmb: 4096,
    cvc: 2,
    label: "gpu",
    queue: "root.prod.reports",
    tags: ["ml"],
  },
  {
    state: "RUNNING",
    type: "yarn-service",
    user: "svc-ml",
    name: "model-serving",
    ageMin: 1440,
    progress: 0,
    cont: 5,
    cmb: 4096,
    cvc: 2,
    reservedMb: 4096,
    tags: ["ml", "prod"],
    lifetimeSec: 604800,
  },
  {
    state: "RUNNING",
    type: "DISTRIBUTED_SHELL",
    user: "alice",
    name: "dshell-retrying",
    ageMin: 9,
    progress: 50,
    cont: 3,
    cmb: 1024,
    cvc: 1,
    attempts: "failedThenRunning",
  },
  { state: "RUNNING", type: "SPARK", user: "etl", name: "almost-done-report", ageMin: 47, progress: 99, cont: 4, cmb: 2048, cvc: 1 },
  {
    state: "RUNNING",
    type: "SPARK",
    user: "hdfs",
    name: LONG_NAME,
    ageMin: 15,
    progress: 27,
    cont: 6,
    cmb: 2048,
    cvc: 1,
    tags: TAG_POOL.slice(0, 7),
  },
  {
    state: "RUNNING",
    type: "MAPREDUCE",
    user: "etl",
    name: "unmanaged-am-test",
    ageMin: 5,
    progress: 0,
    cont: 1,
    cmb: 1536,
    cvc: 1,
    unmanaged: true,
    noTracking: true,
  },
  { state: "RUNNING", type: "SPARK", user: "bob", name: "interactive-shell", ageMin: 3, progress: 12, cont: 2, cmb: 2048, cvc: 1 },
];

export const TEMPLATE_COUNT = TEMPLATES.length;

function makeNodes(): MockNode[] {
  const spec: Array<Partial<MockNode> & { host: string; rack: string; state: NodeState; totalMb: number; totalVc: number }> = [
    { host: "node-r1-01.mock.local", rack: "/rack1", state: "RUNNING", labels: ["gpu"], totalMb: 65536, totalVc: 32 },
    { host: "node-r1-02.mock.local", rack: "/rack1", state: "RUNNING", labels: [], totalMb: 131072, totalVc: 64 },
    { host: "node-r2-01.mock.local", rack: "/rack2", state: "RUNNING", labels: ["highmem"], totalMb: 196608, totalVc: 48 },
    {
      host: "node-r2-02.mock.local",
      rack: "/rack2",
      state: "UNHEALTHY",
      labels: [],
      totalMb: 131072,
      totalVc: 64,
      healthReport:
        "1/1 local-dirs usable space is below configured utilization percentage/no more usable space [ /data/yarn/local : used space above threshold of 90.0% ] ; 1/1 log-dirs are bad: /data/yarn/logs",
    },
    { host: "node-r2-03.mock.local", rack: "/rack2", state: "DECOMMISSIONING", labels: [], totalMb: 65536, totalVc: 32 },
  ];
  return spec.map((s, idx) => ({
    idx,
    port: 45454,
    httpPort: 8042,
    healthReport: "",
    lastHealthAge: 2000 + idx * 1700,
    version: "3.4.3",
    usedMb: 0,
    usedVc: 0,
    containers: 0,
    schedulable: s.state === "RUNNING" || s.state === "DECOMMISSIONING",
    ...s,
    labels: s.labels ?? [],
  })) as MockNode[];
}

export interface ClusterOptions {
  seed: number;
  apps: number;
  frozen: boolean;
  allowNewApps?: boolean;
}

export class MockCluster {
  readonly opts: ClusterOptions;
  readonly nodes: MockNode[] = makeNodes();
  /** newest last; index === num - firstNum */
  readonly apps: MockApp[] = [];
  readonly byId = new Map<string, MockApp>();
  now: number;
  version = 1;
  tickCount = 0;
  startedOn: number;
  private nextNum = 1;
  private rng: Rng;
  /** apps that can still change state; avoids O(N) scans on each tick */
  private live = new Set<MockApp>();

  constructor(opts: ClusterOptions) {
    this.opts = opts;
    this.now = opts.frozen ? FIXED_NOW : Date.now();
    this.startedOn = CLUSTER_TS;
    this.rng = new Rng(seedOf(opts.seed, 0xc1a5));
    this.populate();
    this.recomputeUsage();
  }

  // ------------------------------------------------------------------ population

  private populate() {
    const n = this.opts.apps;
    const nTpl = Math.min(n, TEMPLATES.length);
    const nRandom = n - nTpl;
    // `nRandom` older random apps first, then the hand-built templates (newest ids). With the default 28 apps ids 1..28 are the templates.
    const base = this.now;
    for (let i = 0; i < nRandom; i++) {
      const r = new Rng(seedOf(this.opts.seed, i, 7));
      const num = this.nextNum++;
      const ageMs = 3 * 3600_000 + (nRandom - i) * Math.max(2000, Math.floor((14 * 86400_000) / nRandom)) + r.int(0, 5000);
      const user = r.pick(USERS);
      const roll = r.float();
      let state: AppState = "FINISHED";
      let final: FinalStatus = "SUCCEEDED";
      if (roll < 0.04) {
        state = "FAILED";
        final = "FAILED";
      } else if (roll < 0.07) {
        state = "KILLED";
        final = "KILLED";
      } else if (roll < 0.12) {
        final = r.chance(0.7) ? "FAILED" : "KILLED";
      }
      const type = r.pick(TYPES);
      const durMs = r.int(20_000, 2 * 3600_000);
      const startedTime = base - ageMs;
      const app = this.baseApp(
        num,
        user,
        `${type.toLowerCase()}-job-${pad(num, 5)}${r.chance(0.1) ? " (unicode: é)" : ""}`,
        USER_QUEUE[user]!,
        type,
        startedTime,
        r,
      );
      app.state = state;
      app.finalStatus = final;
      app.finishedTime = startedTime + durMs;
      app.launchTime = startedTime + r.int(300, 4000);
      app.progress = 100;
      app.tags = r.chance(0.3) ? [r.pick(TAG_POOL)] : [];
      app.priority = r.chance(0.1) ? r.int(1, 5) : 0;
      app.diag =
        final === "SUCCEEDED" ? "" : final === "KILLED" ? `Application killed by user ${user}.` : "Application failed due to a task error";
      app.memSec = r.int(2_000, 5_000_000);
      app.vcSec = Math.floor(app.memSec / 1100);
      app.logAgg = r.pick(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED", "DISABLED", "NOT_START"]);
      app.attempts = [
        {
          id: 1,
          startTime: startedTime + 600,
          finishedTime: app.finishedTime,
          state: state === "FAILED" ? "FAILED" : state === "KILLED" ? "KILLED" : "FINISHED",
          nodeIdx: r.pick([1, 2, 4]),
        },
      ];
      this.addApp(app);
    }
    for (let t = 0; t < nTpl; t++) {
      // fewer apps than templates: take an evenly spread subset so every state stays represented
      const tpl = TEMPLATES[Math.floor((t * TEMPLATES.length) / nTpl)]!;
      const num = this.nextNum++;
      const r = new Rng(seedOf(this.opts.seed, num, 11));
      const startedTime = base - Math.round(tpl.ageMin * 60_000);
      const queue = tpl.queue ?? USER_QUEUE[tpl.user]!;
      const app = this.baseApp(num, tpl.user, tpl.name, queue, tpl.type, startedTime, r);
      app.state = tpl.state;
      app.finalStatus = tpl.final ?? "UNDEFINED";
      app.tags = tpl.tags ?? [];
      app.priority = tpl.prio ?? 0;
      app.unmanaged = tpl.unmanaged ?? false;
      app.noTracking = tpl.noTracking ?? false;
      app.label = tpl.label ?? "";
      app.diag = (tpl.diag ?? "")
        .replaceAll("application_X", app.id)
        .replaceAll("appattempt_X", `appattempt_${CLUSTER_TS}_${pad(num, 4)}_000002`)
        .replaceAll("task_X", `task_${CLUSTER_TS}_${pad(num, 4)}`);
      app.lifetimeSec = tpl.lifetimeSec ?? -1;
      this.applyTemplateState(app, tpl, r);
      this.addApp(app);
    }
    // random apps may also include some in-flight ones for large N
    if (nRandom > 100) {
      const extra = Math.min(12, Math.floor(nRandom / 200));
      for (let k = 0; k < extra; k++) {
        const app = this.apps[nRandom - 1 - k * 7]!;
        this.live.delete(app);
        this.makeRunning(app, new Rng(seedOf(this.opts.seed, app.num, 13)));
        this.live.add(app);
      }
    }
  }

  private baseApp(num: number, user: string, name: string, queue: string, type: string, startedTime: number, r: Rng): MockApp {
    return {
      num,
      id: `application_${CLUSTER_TS}_${pad(num, 4)}`,
      user,
      name,
      queue,
      state: "NEW",
      finalStatus: "UNDEFINED",
      progress: 0,
      type,
      tags: [],
      priority: 0,
      startedTime,
      launchTime: 0,
      finishedTime: 0,
      diag: "",
      containers: 0,
      cmb: 2048,
      cvc: 1,
      reservedMb: 0,
      reservedVc: 0,
      planContainers: r.int(2, 6),
      label: "",
      unmanaged: false,
      noTracking: false,
      logAgg: "DISABLED",
      attempts: [],
      lifetimeSec: -1,
      memSec: 0,
      vcSec: 0,
      preemptedMb: 0,
      preemptedAm: 0,
      preemptedNonAm: 0,
      seed: seedOf(num, 0x5eed),
    };
  }

  private applyTemplateState(app: MockApp, tpl: Tpl, r: Rng) {
    const s = app.startedTime;
    app.planContainers = tpl.cont ?? app.planContainers;
    app.cmb = tpl.cmb ?? 2048;
    app.cvc = tpl.cvc ?? 1;
    switch (app.state) {
      case "NEW":
      case "NEW_SAVING":
      case "SUBMITTED":
        break;
      case "ACCEPTED":
        app.attempts = [{ id: 1, startTime: s + 400, finishedTime: 0, state: "SCHEDULED", nodeIdx: -1 }];
        break;
      case "RUNNING":
        this.makeRunning(app, r, tpl);
        break;
      default: {
        const dur = Math.round((tpl.durMin ?? 5) * 60_000);
        app.finishedTime = s + dur;
        app.launchTime = s + 1800;
        app.progress = app.state === "FINISHED" && app.finalStatus === "SUCCEEDED" ? 100 : app.state === "FINISHED" ? 100 : r.int(10, 80);
        app.memSec = r.int(20_000, 3_000_000);
        app.vcSec = Math.floor(app.memSec / 1100);
        app.logAgg = app.finalStatus === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
        if (tpl.attempts === "twoFailed") {
          app.attempts = [
            { id: 1, startTime: s + 500, finishedTime: s + dur / 2, state: "FAILED", nodeIdx: 1 },
            { id: 2, startTime: s + dur / 2 + 800, finishedTime: s + dur, state: "FAILED", nodeIdx: 4 },
          ];
        } else {
          app.attempts = [
            {
              id: 1,
              startTime: s + 500,
              finishedTime: s + dur,
              state: app.state === "KILLED" ? "KILLED" : app.state === "FAILED" ? "FAILED" : "FINISHED",
              nodeIdx: r.pick([1, 2, 4]),
            },
          ];
        }
      }
    }
    if (app.state === "ACCEPTED") app.launchTime = 0;
  }

  /** Move an app into RUNNING with its planned allocation. */
  private makeRunning(app: MockApp, r: Rng, tpl?: Tpl) {
    const s = app.startedTime;
    app.state = "RUNNING";
    app.finalStatus = "UNDEFINED";
    app.finishedTime = 0;
    app.launchTime = app.unmanaged ? 0 : s + 1500;
    app.progress = tpl?.progress ?? 1;
    app.containers = tpl?.cont ?? Math.max(1, Math.min(app.planContainers, 8));
    if (!tpl) {
      app.cmb = r.pick([1024, 1536, 2048]);
      app.cvc = 1;
    }
    app.reservedMb = tpl?.reservedMb ?? 0;
    app.reservedVc = app.reservedMb > 0 ? (tpl?.cvc ?? 1) : 0;
    app.diag = tpl?.diag ?? "";
    const elapsedS = Math.max(1, (this.now - s) / 1000);
    app.memSec = Math.round(app.containers * app.cmb * elapsedS * 0.9);
    app.vcSec = Math.round(app.containers * app.cvc * elapsedS * 0.9);
    app.logAgg = "NOT_START";
    const amNode = app.label === "gpu" ? 0 : app.num % 2 === 0 ? 1 : 4;
    if (tpl?.attempts === "failedThenRunning") {
      app.attempts = [
        { id: 1, startTime: s + 500, finishedTime: s + 150_000, state: "FAILED", nodeIdx: 1 },
        { id: 2, startTime: s + 152_000, finishedTime: 0, state: "RUNNING", nodeIdx: 4 },
      ];
      app.diag = `Attempt recovered after RM restart. Application application_${CLUSTER_TS}_${pad(app.num, 4)} attempt 1 failed: AM Container exited with exitCode: -100 (Container released on a *lost* node)`;
    } else {
      app.attempts = [{ id: 1, startTime: s + 700, finishedTime: 0, state: "RUNNING", nodeIdx: app.unmanaged ? -1 : amNode }];
    }
    if (app.type === "yarn-service") app.progress = 0;
  }

  private addApp(app: MockApp) {
    this.apps.push(app);
    this.byId.set(app.id, app);
    if (
      app.state === "NEW" ||
      app.state === "NEW_SAVING" ||
      app.state === "SUBMITTED" ||
      app.state === "ACCEPTED" ||
      app.state === "RUNNING"
    ) {
      this.live.add(app);
    }
  }

  // ------------------------------------------------------------------ queries

  get firstNum(): number {
    return this.apps[0]?.num ?? 1;
  }

  liveApps(): Iterable<MockApp> {
    return this.live;
  }

  getApp(id: string): MockApp | undefined {
    return this.byId.get(id);
  }

  elapsed(app: MockApp): number {
    return Math.max(0, (app.finishedTime || this.now) - app.startedTime);
  }

  defaultNodes(): MockNode[] {
    return this.nodes.filter((n) => n.schedulable && n.labels.length === 0);
  }

  // ------------------------------------------------------------------ evolution

  /** Advance one simulated second. Returns true if anything changed. */
  tick(): boolean {
    this.tickCount++;
    this.now = this.opts.frozen ? this.now + 1000 : Date.now();
    const r = this.rng;
    const running: MockApp[] = [];
    const pending: MockApp[] = [];
    for (const a of this.live) {
      if (a.state === "RUNNING") running.push(a);
      else pending.push(a);
    }
    // 1. new -> ... -> accepted
    for (const a of pending) {
      if (a.state === "NEW" && r.chance(0.6)) a.state = "NEW_SAVING";
      else if (a.state === "NEW_SAVING" && r.chance(0.6)) a.state = "SUBMITTED";
      else if (a.state === "SUBMITTED" && r.chance(0.6)) {
        a.state = "ACCEPTED";
        a.attempts = [{ id: 1, startTime: this.now, finishedTime: 0, state: "SCHEDULED", nodeIdx: -1 }];
      }
    }
    // 2. accepted -> running when resources are free
    const free = this.freeDefaultMb();
    let remaining = free;
    for (const a of pending) {
      if (a.state !== "ACCEPTED" || !r.chance(0.2)) continue;
      const need = a.label ? 0 : a.cmb * Math.min(a.planContainers, 8);
      if (need > remaining) continue;
      remaining -= need;
      this.makeRunning(a, r);
      a.startedTime = Math.min(a.startedTime, this.now - 1000);
      a.launchTime = this.now;
      a.attempts[0]!.startTime = this.now;
      a.attempts[0]!.state = "RUNNING";
      a.attempts[0]!.nodeIdx = a.num % 2 === 0 ? 1 : 4;
      a.diag = "";
      running.push(a);
    }
    // 3. running apps advance
    for (const a of running) {
      if (a.state !== "RUNNING") continue;
      if (a.type !== "yarn-service" && a.progress < 99 && !a.unmanaged)
        a.progress = Math.min(99, Math.round((a.progress + r.float() * 2.2) * 10) / 10);
      const delta = r.int(-1, 1);
      const cap = Math.max(a.planContainers, 2) * 3;
      const grown = Math.max(1, Math.min(cap, a.containers + delta));
      if (grown > a.containers && a.label === "" && a.cmb * (grown - a.containers) > remaining) continue;
      if (a.label === "") remaining -= a.cmb * (grown - a.containers);
      a.containers = grown;
      a.memSec += a.containers * a.cmb;
      a.vcSec += a.containers * a.cvc;
      if (a.reservedMb && r.chance(0.2)) a.reservedMb = 0;
      else if (!a.reservedMb && a.type === "yarn-service" && r.chance(0.1)) {
        a.reservedMb = 4096;
        a.reservedVc = a.cvc;
      }
    }
    // 4. a running app occasionally finishes (never starve the UI of running apps)
    const stillRunning = [...this.live].filter((a) => a.state === "RUNNING");
    if (stillRunning.length > 4 && r.chance(0.08)) {
      const a = r.pick(stillRunning.filter((x) => x.type !== "yarn-service"));
      if (a) this.finish(a, r);
    }
    // 5. occasionally a new application is submitted
    if (this.opts.allowNewApps !== false && r.chance(0.07) && this.live.size < 40) this.submitNew(r);
    this.recomputeUsage();
    this.version++;
    return true;
  }

  private finish(a: MockApp, r: Rng) {
    const roll = r.float();
    a.finishedTime = this.now;
    const att = a.attempts[a.attempts.length - 1];
    if (roll < 0.1) {
      a.state = "FAILED";
      a.finalStatus = "FAILED";
      a.diag = "Application failed: AM Container exited with exitCode: 1";
      if (att) att.state = "FAILED";
    } else if (roll < 0.17) {
      a.state = "KILLED";
      a.finalStatus = "KILLED";
      a.diag = `Application killed by user ${a.user}.`;
      if (att) att.state = "KILLED";
    } else {
      a.state = "FINISHED";
      a.finalStatus = roll < 0.22 ? "FAILED" : "SUCCEEDED";
      if (a.finalStatus === "FAILED") a.diag = "Final app status: FAILED, exitCode: 15";
      if (att) att.state = "FINISHED";
    }
    if (att) att.finishedTime = this.now;
    a.progress = a.state === "FINISHED" ? 100 : a.progress;
    a.containers = 0;
    a.reservedMb = 0;
    a.reservedVc = 0;
    a.logAgg = "NOT_START";
    this.live.delete(a);
  }

  submitNew(r: Rng) {
    const num = this.nextNum++;
    const user = r.pick(USERS);
    const type = r.pick(TYPES);
    const app = this.baseApp(num, user, `${type.toLowerCase()}-live-${pad(num, 5)}`, USER_QUEUE[user]!, type, this.now, r);
    app.cmb = r.pick([1024, 2048, 4096]);
    app.planContainers = r.int(2, 8);
    app.tags = r.chance(0.4) ? [r.pick(TAG_POOL)] : [];
    this.addApp(app);
  }

  // ------------------------------------------------------------------ aggregates

  /** per-version aggregate cache */
  agg = {
    running: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    killed: 0,
    submitted: 0,
    allocMb: 0,
    allocVc: 0,
    reservedMb: 0,
    reservedVc: 0,
    containers: 0,
    pendingMb: 0,
    pendingVc: 0,
    pendingContainers: 0,
    gpuMb: 0,
    gpuVc: 0,
  };

  private freeDefaultMb(): number {
    const total = this.defaultNodes().reduce((s, n) => s + n.totalMb, 0);
    let used = 0;
    for (const a of this.live) if (a.state === "RUNNING" && !a.label) used += a.containers * a.cmb + a.reservedMb;
    return Math.max(0, Math.floor(total * 0.85) - used);
  }

  /** Recompute aggregates and distribute usage over the nodes (called after every change). */
  recomputeUsage() {
    const g = this.agg;
    g.running = g.pending = g.completed = g.failed = g.killed = 0;
    g.allocMb =
      g.allocVc =
      g.reservedMb =
      g.reservedVc =
      g.containers =
      g.pendingMb =
      g.pendingVc =
      g.pendingContainers =
      g.gpuMb =
      g.gpuVc =
        0;
    g.submitted = this.apps.length;
    // finished counters over all apps are cached incrementally-ish: O(N) but trivial for 20k
    for (const a of this.apps) {
      switch (a.state) {
        case "RUNNING":
          g.running++;
          break;
        case "ACCEPTED":
          g.pending++;
          break;
        case "FINISHED":
          g.completed++;
          break;
        case "FAILED":
          g.failed++;
          break;
        case "KILLED":
          g.killed++;
          break;
      }
    }
    const byLabel = new Map<string, { mb: number; vc: number; n: number }>();
    for (const a of this.live) {
      if (a.state === "ACCEPTED") {
        g.pendingMb += a.cmb * a.planContainers;
        g.pendingVc += a.cvc * a.planContainers;
        g.pendingContainers += a.planContainers;
      }
      if (a.state !== "RUNNING") continue;
      const u = byLabel.get(a.label) ?? { mb: 0, vc: 0, n: 0 };
      u.mb += a.containers * a.cmb;
      u.vc += a.containers * a.cvc;
      u.n += a.containers;
      byLabel.set(a.label, u);
      if (a.label === "") {
        g.allocMb += a.containers * a.cmb;
        g.allocVc += a.containers * a.cvc;
        g.containers += a.containers;
        g.reservedMb += a.reservedMb;
        g.reservedVc += a.reservedVc;
      } else {
        g.gpuMb += a.containers * a.cmb;
        g.gpuVc += a.containers * a.cvc;
      }
    }
    // per-node usage: split each partition's usage across its schedulable nodes by capacity
    for (const n of this.nodes) {
      n.usedMb = n.usedVc = n.containers = 0;
    }
    for (const [label, u] of byLabel) {
      const members = this.nodes.filter((n) => n.schedulable && (label === "" ? n.labels.length === 0 : n.labels.includes(label)));
      const totalCap = members.reduce((s, n) => s + n.totalMb, 0);
      if (totalCap === 0) continue;
      let mbLeft = u.mb;
      let vcLeft = u.vc;
      let ctLeft = u.n;
      members.forEach((n, i) => {
        const last = i === members.length - 1;
        const share = n.totalMb / totalCap;
        const mb = last ? mbLeft : Math.round(u.mb * share);
        const vc = last ? vcLeft : Math.round(u.vc * share);
        const ct = last ? ctLeft : Math.round(u.n * share);
        n.usedMb = Math.min(mb, n.totalMb);
        n.usedVc = Math.min(vc, n.totalVc);
        n.containers = ct;
        mbLeft -= mb;
        vcLeft -= vc;
        ctLeft -= ct;
      });
    }
  }
}
