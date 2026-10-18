type SessionKind = "overview" | "apps" | "spark-detail";

type Options = {
  target: string;
  users: number;
  rampSeconds: number;
  durationSeconds: number;
  requestTimeoutMs: number;
  allowPublicTarget: boolean;
  scenariosFile: string | URL;
  outputFile?: string;
};

type Scenario = {
  name?: string;
  appId?: string;
  applicationType?: string;
  state?: string;
};

type RequestSample = {
  latencyMs: number;
  bytes: number;
  status: number | "error";
  cache: string;
};

type RequestStats = {
  count: number;
  failures: number;
  bytes: number;
  statuses: Record<string, number>;
  cache: Record<string, number>;
  upstream: Record<string, number>;
  latencies: number[];
};

type SessionPlan = {
  kind: SessionKind;
  initialPaths: string[];
  slowPaths: string[];
  topics: string[];
};

const DEFAULT_USERS = 1_000;
const DEFAULT_RAMP_SECONDS = 30;
const DEFAULT_DURATION_SECONDS = 120;
const REFRESH_MS = 3_000;
const SSE_SAFETY_MS = 30_000;
const SSE_RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 20_000];
const SLOW_REFRESH_MS = REFRESH_MS * 4;
const COMMON_SLOW_PATHS = ["/api/meta", "/api/yarn/info"];

const ACTIVE_STATES = "NEW,NEW_SAVING,SUBMITTED,ACCEPTED,RUNNING";
const ACTIVE_APPS_QUERY = new URLSearchParams({
  deSelects: "resourceRequests",
  states: ACTIVE_STATES,
}).toString();
const ALL_APPS_QUERY = "deSelects=resourceRequests";

const OVERVIEW_TOPICS = ["yarn/metrics", `yarn/apps?${ACTIVE_APPS_QUERY}`, "yarn/nodes", "yarn/scheduler", "yarn/scheduler-overview"];
const APPS_TOPIC = `yarn/apps?${ALL_APPS_QUERY}`;

const usage = `Usage:
  bun run load:test -- --target http://127.0.0.1:8787 [options]

Options:
  --users N                 Concurrent virtual sessions (default ${DEFAULT_USERS}, max 5000)
  --ramp-seconds N          Spread session startup over N seconds (default ${DEFAULT_RAMP_SECONDS})
  --duration-seconds N      Hold the full session count for N seconds (default ${DEFAULT_DURATION_SECONDS})
  --scenario-file PATH      Scenario JSON used to choose live/finished Spark app IDs
  --request-timeout-ms N    Per-request timeout (default 15000)
  --output PATH             Write the JSON report to PATH as well as stdout
  --allow-public-target     Permit targets outside localhost/private IP ranges
  --help                    Show this help

The default mixed profile is 70% Overview, 20% Applications list, 10% Spark app detail.
The load:test package command raises Bun Fetch's default 256 concurrent-request limit.
Each session loads the shell and its API resources, keeps one SSE stream open, follows invalidations,
uses the app's 3 s refresh cadence as an SSE-down fallback, and polls the 30 s SSE safety interval.
`;

function parseArgs(argv: string[]): Options | null {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const options: Options = {
    target: "",
    users: DEFAULT_USERS,
    rampSeconds: DEFAULT_RAMP_SECONDS,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    requestTimeoutMs: 15_000,
    allowPublicTarget: false,
    scenariosFile: new URL("../../.cluster/scenarios.json", import.meta.url),
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = (): string => {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--help":
        console.log(usage);
        return null;
      case "--target":
        options.target = value();
        break;
      case "--users":
        options.users = Number(value());
        break;
      case "--ramp-seconds":
        options.rampSeconds = Number(value());
        break;
      case "--duration-seconds":
        options.durationSeconds = Number(value());
        break;
      case "--request-timeout-ms":
        options.requestTimeoutMs = Number(value());
        break;
      case "--scenario-file":
        options.scenariosFile = value();
        break;
      case "--output":
        options.outputFile = value();
        break;
      case "--allow-public-target":
        options.allowPublicTarget = true;
        break;
      default:
        throw new Error(`unknown option ${arg}\n\n${usage}`);
    }
  }

  if (!options.target) throw new Error(`--target is required\n\n${usage}`);
  if (!Number.isInteger(options.users) || options.users < 1 || options.users > 5_000) {
    throw new Error("--users must be an integer between 1 and 5000");
  }
  if (!Number.isFinite(options.rampSeconds) || options.rampSeconds < 0 || options.rampSeconds > 3_600) {
    throw new Error("--ramp-seconds must be between 0 and 3600");
  }
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds < 1 || options.durationSeconds > 3_600) {
    throw new Error("--duration-seconds must be between 1 and 3600");
  }
  if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 100 || options.requestTimeoutMs > 120_000) {
    throw new Error("--request-timeout-ms must be an integer between 100 and 120000");
  }
  return options;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;

  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const a = octets[0];
  const b = octets[1];
  if (a === undefined || b === undefined) return false;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function targetBase(target: string, allowPublicTarget: boolean): URL {
  const url = new URL(target);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--target must use http or https");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("--target must not contain credentials, a query, or a fragment");
  if (!allowPublicTarget && !isPrivateHost(url.hostname)) {
    throw new Error("Refusing to generate load against a public target; pass --allow-public-target to opt in");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function requestUrl(base: URL, path: string): string {
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

function isScenario(value: unknown): value is Scenario {
  if (value === null || typeof value !== "object") return false;
  return (
    (!("name" in value) || typeof value.name === "string") &&
    (!("appId" in value) || typeof value.appId === "string") &&
    (!("applicationType" in value) || typeof value.applicationType === "string") &&
    (!("state" in value) || typeof value.state === "string")
  );
}

function isSparkScenario(scenario: Scenario): scenario is Scenario & { appId: string } {
  return (
    scenario.applicationType === "SPARK" &&
    (scenario.state === "RUNNING" || scenario.state === "FINISHED") &&
    scenario.name !== "client_mode" &&
    typeof scenario.appId === "string"
  );
}

async function loadSparkAppIds(file: string | URL): Promise<string[]> {
  const source = Bun.file(file);
  if (!(await source.exists())) {
    throw new Error(`scenario file not found: ${String(file)}; seed the cluster scenarios first or pass --scenario-file`);
  }
  const document: unknown = await source.json();
  if (!document || typeof document !== "object" || !("scenarios" in document) || !Array.isArray(document.scenarios)) {
    throw new Error(`scenario file has no scenarios array: ${String(file)}`);
  }
  const appIds = document.scenarios
    .filter(isScenario)
    .filter(isSparkScenario)
    .map((scenario) => scenario.appId);
  const unique = [...new Set(appIds)];
  if (unique.length === 0) throw new Error("scenario file contains no RUNNING or FINISHED cluster-mode Spark apps");
  return unique;
}

function kindFor(userId: number): SessionKind {
  const bucket = userId % 10;
  if (bucket < 7) return "overview";
  if (bucket < 9) return "apps";
  return "spark-detail";
}

function sessionPlan(kind: SessionKind, appId?: string): SessionPlan {
  const initialPaths = ["/", ...COMMON_SLOW_PATHS];
  if (kind === "overview") {
    const paths = OVERVIEW_TOPICS.map((topic) => `/api/${topic}`);
    return { kind, initialPaths: [...initialPaths, ...paths], slowPaths: COMMON_SLOW_PATHS, topics: OVERVIEW_TOPICS };
  }
  if (kind === "apps") {
    const path = `/api/yarn/apps?${ALL_APPS_QUERY}`;
    return { kind, initialPaths: [...initialPaths, path], slowPaths: COMMON_SLOW_PATHS, topics: [APPS_TOPIC] };
  }
  if (!appId) throw new Error("Spark detail session requires an app ID");

  const paths = [
    `/api/yarn/apps/${encodeURIComponent(appId)}`,
    `/api/yarn/apps/${encodeURIComponent(appId)}/appattempts`,
    `/api/spark/${encodeURIComponent(appId)}/source`,
    `/api/spark/${encodeURIComponent(appId)}/application`,
    `/api/spark/${encodeURIComponent(appId)}/jobs`,
    `/api/spark/${encodeURIComponent(appId)}/stages`,
  ];
  const topics = [`yarn/apps/${appId}`, `yarn/apps/${appId}/appattempts`, `spark/${appId}/jobs`, `spark/${appId}/stages`];
  return {
    kind,
    initialPaths: [...initialPaths, ...paths],
    slowPaths: [...COMMON_SLOW_PATHS, `/api/spark/${encodeURIComponent(appId)}/source`],
    topics,
  };
}

function emptyStats(): RequestStats {
  return { count: 0, failures: 0, bytes: 0, statuses: {}, cache: {}, upstream: {}, latencies: [] };
}

function percentile(samples: number[], fraction: number): number | null {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((a, b) => a - b);
  const sample = ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
  return sample === undefined ? null : Math.round(sample * 100) / 100;
}

function summarizeStats(stats: RequestStats) {
  return {
    requests: stats.count,
    failures: stats.failures,
    bytes: stats.bytes,
    statuses: stats.statuses,
    cache: stats.cache,
    upstream: stats.upstream,
    latencyMs: {
      p50: percentile(stats.latencies, 0.5),
      p95: percentile(stats.latencies, 0.95),
      p99: percentile(stats.latencies, 0.99),
      max: stats.latencies.length === 0 ? null : Math.round(stats.latencies.reduce((max, sample) => Math.max(max, sample), 0) * 100) / 100,
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  if (!options) return;
  const base = targetBase(options.target, options.allowPublicTarget);
  const appIds = await loadSparkAppIds(options.scenariosFile);
  const endAt = Date.now() + (options.rampSeconds + options.durationSeconds) * 1_000;
  const byPath = new Map<string, RequestStats>();
  const sessionCounts: Record<SessionKind, number> = { overview: 0, apps: 0, "spark-detail": 0 };
  const sse = {
    opened: 0,
    hello: 0,
    failed: 0,
    disconnects: 0,
    heartbeats: 0,
    invalidations: 0,
    active: 0,
    peakActive: 0,
    healthySessionsAtEnd: 0,
    bytes: 0,
  };
  let httpFailures = 0;
  let runningRequests = 0;
  let peakRequests = 0;
  let stopping = false;

  const statsFor = (path: string): RequestStats => {
    const label = path.split("?")[0] || "/";
    let stats = byPath.get(label);
    if (!stats) {
      stats = emptyStats();
      byPath.set(label, stats);
    }
    return stats;
  };

  const get = async (path: string, signal: AbortSignal): Promise<void> => {
    const stats = statsFor(path);
    const started = performance.now();
    runningRequests += 1;
    peakRequests = Math.max(peakRequests, runningRequests);
    try {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs)]);
      const response = await fetch(requestUrl(base, path), {
        headers: { accept: path === "/" ? "text/html,*/*" : "application/json" },
        signal: combined,
      });
      const body = await response.arrayBuffer();
      const cache = response.headers.get("x-burrow-cache") ?? "none";
      const upstream = response.headers.get("x-burrow-upstream");
      if (upstream && path !== "/api/meta" && (cache === "miss" || cache === "bypass")) {
        stats.upstream[upstream] = (stats.upstream[upstream] ?? 0) + 1;
      }
      const sample: RequestSample = {
        latencyMs: performance.now() - started,
        bytes: body.byteLength,
        status: response.status,
        cache,
      };
      stats.count += 1;
      stats.bytes += sample.bytes;
      stats.latencies.push(sample.latencyMs);
      stats.statuses[String(sample.status)] = (stats.statuses[String(sample.status)] ?? 0) + 1;
      stats.cache[sample.cache] = (stats.cache[sample.cache] ?? 0) + 1;
      if (!response.ok) {
        stats.failures += 1;
        httpFailures += 1;
      }
    } catch (error) {
      if (signal.aborted && (stopping || Date.now() >= endAt)) return;
      stats.count += 1;
      stats.failures += 1;
      stats.latencies.push(performance.now() - started);
      stats.statuses.error = (stats.statuses.error ?? 0) + 1;
      httpFailures += 1;
      console.error(`[load] ${path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      runningRequests -= 1;
    }
  };

  const pendingRequests = new Set<Promise<void>>();

  const stream = async (
    plan: SessionPlan,
    controller: AbortController,
    onOpen: (open: boolean) => void,
    onInvalidate: (topic: string) => void,
  ): Promise<void> => {
    const topicQuery = plan.topics.map(encodeURIComponent).join(",");
    const path = `/api/events?topics=${topicQuery}`;
    let reconnectAttempt = 0;

    while (!stopping && !controller.signal.aborted && Date.now() < endAt) {
      try {
        const response = await fetch(requestUrl(base, path), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !contentType.includes("text/event-stream") || !response.body) {
          sse.failed += 1;
          await response.body?.cancel().catch(() => {});
          if (stopping || controller.signal.aborted || Date.now() >= endAt) break;
          await Bun.sleep(SSE_RECONNECT_MS[Math.min(reconnectAttempt, SSE_RECONNECT_MS.length - 1)] ?? 20_000);
          reconnectAttempt += 1;
          continue;
        }

        sse.opened += 1;
        sse.active += 1;
        sse.peakActive = Math.max(sse.peakActive, sse.active);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        onOpen(false);

        try {
          while (!stopping && !controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            sse.bytes += value.byteLength;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const lines = frame.split("\n");
              const event =
                lines
                  .find((line) => line.startsWith("event:"))
                  ?.slice(6)
                  .trim() ?? "message";
              const data = lines
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("\n");
              if (frame.startsWith(": heartbeat")) {
                sse.heartbeats += 1;
              } else if (event === "hello") {
                sse.hello += 1;
                reconnectAttempt = 0;
                onOpen(true);
              } else if (event === "invalidate") {
                sse.invalidations += 1;
                try {
                  const parsed: unknown = JSON.parse(data);
                  if (parsed && typeof parsed === "object" && "topic" in parsed && typeof parsed.topic === "string") {
                    onInvalidate(parsed.topic);
                  }
                } catch {
                  // An invalid frame is counted as traffic; the browser ignores it and its safety poll recovers.
                }
              }
              boundary = buffer.indexOf("\n\n");
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          sse.active -= 1;
          if (!stopping && !controller.signal.aborted) {
            sse.disconnects += 1;
            onOpen(false);
          }
        }
      } catch (error) {
        if (!stopping && !controller.signal.aborted) {
          sse.failed += 1;
          onOpen(false);
          console.error(`[load] SSE: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (stopping || controller.signal.aborted || Date.now() >= endAt) break;
      await Bun.sleep(SSE_RECONNECT_MS[Math.min(reconnectAttempt, SSE_RECONNECT_MS.length - 1)] ?? 20_000);
      reconnectAttempt += 1;
    }
  };

  const runSession = async (userId: number, startedAt: number): Promise<void> => {
    const arrival = startedAt + (options.rampSeconds === 0 ? 0 : Math.floor((userId / options.users) * options.rampSeconds * 1_000));
    if (arrival > Date.now()) await Bun.sleep(arrival - Date.now());
    if (Date.now() >= endAt) return;

    const kind = kindFor(userId);
    sessionCounts[kind] += 1;
    const appId = kind === "spark-detail" ? appIds[Math.floor(userId / 10) % appIds.length] : undefined;
    const plan = sessionPlan(kind, appId);
    const controller = new AbortController();
    // Match TanStack Query's per-tab in-flight query deduplication.
    const inFlightRequests = new Map<string, Promise<void>>();
    const request = (path: string): Promise<void> => {
      const existing = inFlightRequests.get(path);
      if (existing) return existing;

      const promise = get(path, controller.signal);
      inFlightRequests.set(path, promise);
      pendingRequests.add(promise);
      void promise.finally(() => {
        if (inFlightRequests.get(path) === promise) inFlightRequests.delete(path);
        pendingRequests.delete(promise);
      });
      return promise;
    };
    const scheduleGet = (path: string): void => {
      if (stopping || Date.now() >= endAt) return;
      void request(path);
    };
    const lastRefetch = new Map<string, number>();
    let sseOpen = false;
    let nextLivePoll = Date.now() + REFRESH_MS;
    let nextSlowPoll = Date.now() + SLOW_REFRESH_MS;
    const livePaths = plan.topics.map((topic) => `/api/${topic}`);
    const liveTopics = new Set(plan.topics);

    const refetchTopic = (topic: string): void => {
      if (!liveTopics.has(topic)) return;
      const now = Date.now();
      const previous = lastRefetch.get(topic) ?? 0;
      if (now - previous < REFRESH_MS) return;
      lastRefetch.set(topic, now);
      scheduleGet(`/api/${topic}`);
    };

    const initial = Promise.all(plan.initialPaths.map(request));
    const streamTask = stream(
      plan,
      controller,
      (open) => {
        if (open === sseOpen) return;
        sseOpen = open;
        nextLivePoll = Date.now() + (sseOpen ? SSE_SAFETY_MS : REFRESH_MS);
      },
      refetchTopic,
    );

    while (!stopping && Date.now() < endAt) {
      const now = Date.now();
      if (now >= nextLivePoll) {
        for (const path of livePaths) scheduleGet(path);
        nextLivePoll = now + (sseOpen ? SSE_SAFETY_MS : REFRESH_MS);
      }
      if (now >= nextSlowPoll) {
        for (const path of plan.slowPaths) scheduleGet(path);
        nextSlowPoll = now + SLOW_REFRESH_MS;
      }
      const nextDue = Math.min(nextLivePoll, nextSlowPoll, endAt);
      await Bun.sleep(Math.max(1, Math.min(1_000, nextDue - Date.now())));
    }

    if (sseOpen) sse.healthySessionsAtEnd += 1;
    controller.abort();
    await initial;
    await streamTask;
  };

  const startedAt = Date.now();
  const totalMs = (options.rampSeconds + options.durationSeconds) * 1_000;
  const profile: Record<SessionKind, number> = { overview: 0, apps: 0, "spark-detail": 0 };
  for (let userId = 0; userId < options.users; userId += 1) profile[kindFor(userId)] += 1;

  console.log(
    `[load] target=${base.origin}${base.pathname} users=${options.users} ramp=${options.rampSeconds}s hold=${options.durationSeconds}s ` +
      `profiles=${JSON.stringify(profile)} sparkApps=${appIds.length}`,
  );
  const sessions = Array.from({ length: options.users }, (_, userId) => runSession(userId, startedAt));
  await Bun.sleep(totalMs);
  stopping = true;
  await Promise.all(sessions);
  await Promise.all([...pendingRequests]);

  const elapsedSeconds = (Date.now() - startedAt) / 1_000;
  const report = {
    target: `${base.origin}${base.pathname}`,
    loadGenerator: {
      bunVersion: Bun.version,
      maxHttpRequests: Bun.env.BUN_CONFIG_MAX_HTTP_REQUESTS ?? "256 (Bun default)",
    },
    users: options.users,
    rampSeconds: options.rampSeconds,
    holdSeconds: options.durationSeconds,
    elapsedSeconds: Math.round(elapsedSeconds * 100) / 100,
    sessionProfiles: sessionCounts,
    requests: Object.fromEntries([...byPath.entries()].map(([path, stats]) => [path, summarizeStats(stats)])),
    totals: {
      requests: [...byPath.values()].reduce((sum, stats) => sum + stats.count, 0),
      httpFailures,
      bytes: [...byPath.values()].reduce((sum, stats) => sum + stats.bytes, 0),
      peakInFlightRequests: peakRequests,
      apiReportedUpstreamFetches: [...byPath.values()].reduce(
        (sum, stats) => sum + Object.values(stats.upstream).reduce((pathSum, count) => pathSum + count, 0),
        0,
      ),
    },
    sse: {
      connectionsOpened: sse.opened,
      helloFrames: sse.hello,
      failedConnections: sse.failed,
      unexpectedDisconnects: sse.disconnects,
      healthySessionsAtEnd: sse.healthySessionsAtEnd,
      peakActive: sse.peakActive,
      heartbeats: sse.heartbeats,
      invalidations: sse.invalidations,
      bytes: sse.bytes,
    },
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  console.log(json);
  if (options.outputFile) await Bun.write(options.outputFile, json);

  if (
    httpFailures > 0 ||
    sse.failed > 0 ||
    sse.disconnects > 0 ||
    sse.hello < options.users ||
    sse.peakActive < options.users ||
    sse.healthySessionsAtEnd < options.users
  ) {
    throw new Error("load profile failed; inspect the HTTP and SSE counters above");
  }
}

main().catch((error: unknown) => {
  console.error(`[load] ${error instanceof Error ? error.message : String(error)}`);
  throw error;
});
