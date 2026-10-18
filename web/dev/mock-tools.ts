/**
 * Dev-mock handlers for the four daemon "Tools" pages (FE-NodesTools slice): `rm/conf`, `rm/jmx`, `rm/stacks`, `rm/logs`.
 *
 * Recorded responses under `fixtures/rm/tools/` back `/conf`, `/jmx`, and `/stacks`. `/logs` uses a deterministic,
 * sanitized sample instead of the ignored machine-local ResourceManager log, so development and CI see the same bytes.
 * JSON goes through the production schemas. The two behaviors static files cannot provide are implemented like the
 * daemons: `?name=` on `/conf` and byte ranges on `/logs/{file}`.
 *
 * Paths arrive with `/api/` stripped (see `dev/mock-api.ts`). Return `null` to fall through.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import confFixture from "../../fixtures/rm/tools/conf.json";
import jmxFixture from "../../fixtures/rm/tools/jmx.json";
import logsListing from "../../fixtures/rm/tools/logs.json";
import { ConfResponseSchema, JmxResponseSchema, type ConfProperty } from "../src/api/schemas";

const fixturePath = (name: string) => fileURLToPath(new URL(`../../fixtures/rm/tools/${name}`, import.meta.url));

const readFixtureText = (name: string): string => {
  try {
    return readFileSync(fixturePath(name), "utf8");
  } catch {
    return "";
  }
};

const RM_LOG_BYTES = 348_349;
const RM_LOG_SUFFIX =
  "2026-10-13 20:00:14,000 INFO org.apache.hadoop.yarn.server.resourcemanager.MockScheduler: Release request cache is cleaned up\n";

/** A tracked, sanitized daemon-log substitute with the captured listing's byte length. */
function sampleResourceManagerLog(): string {
  const header = `${[
    "2026-10-13 20:00:14,000 INFO org.apache.hadoop.yarn.server.resourcemanager.ResourceManager: STARTUP_MSG: version = 3.4.3",
    "2026-10-13 20:00:14,001 INFO org.apache.hadoop.yarn.server.resourcemanager.ResourceManager: STARTUP_MSG: build = https://hadoop.apache.org/",
    "2026-10-13 20:00:14,002 INFO org.apache.hadoop.yarn.server.resourcemanager.ResourceManager: STARTUP_MSG: java = 17",
  ].join("\n")}\n`;
  const line = "2026-10-13 20:00:15,000 INFO org.apache.hadoop.yarn.server.resourcemanager.MockFixture: Example ResourceManager event\n";
  const paddingBytes = RM_LOG_BYTES - header.length - RM_LOG_SUFFIX.length;
  const wholeLines = Math.floor(paddingBytes / line.length);
  const filler = line.repeat(wholeLines) + " ".repeat(paddingBytes - wholeLines * line.length);
  return header + filler + RM_LOG_SUFFIX;
}

const LOG_FILES: Record<string, string> = {
  "resourcemanager.log": sampleResourceManagerLog(),
  "rm.out": readFixtureText("logs/rm.out"),
};

const STACKS_TEXT = readFixtureText("stacks.txt");

const CONF = ConfResponseSchema.parse(confFixture);
const JMX = JmxResponseSchema.parse(jmxFixture);

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "x-burrow-api": "1", "x-burrow-cache": "hit" };
const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8", "x-burrow-api": "1", "x-burrow-cache": "hit" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const notFound = (message: string, hint?: string) => json({ error: { code: "not_found", message, ...(hint ? { hint } : {}) } }, 404);

/** `GET /conf?format=json[&name=key]` — ConfServlet: with `name` it answers a single `{"property":…}`. */
function confResponse(url: URL): Response {
  const name = url.searchParams.get("name");
  if (!name) return json(confFixture);
  const property: ConfProperty | undefined = CONF.properties.find((p) => p.key === name);
  if (!property) return notFound(`Property ${name} not found`, "The RM dumps only the properties it actually loaded.");
  return json({ property });
}

/** `GET /jmx?qry=Hadoop:*` — JMXJsonServlet accepts `*` patterns on the bean name. */
function jmxResponse(url: URL): Response {
  const qry = url.searchParams.get("qry");
  if (!qry) return json(jmxFixture);
  const pattern = `^${qry
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")}$`;
  const re = new RegExp(pattern);
  const beans = JMX.beans.filter((b) => re.test(b.name));
  if (beans.length === 0) {
    return json({ beans: [{ name: qry, modelerType: qry, result: "ERROR", message: `No MBean matching ${qry}` }] });
  }
  return json({ beans });
}

/** `GET /logs/{file}?offset=&length=&tail=` — byte window of the file (Jetty default servlet + the backend's `tail`). */
function logRange(url: URL, file: string): Response {
  const text = LOG_FILES[file];
  if (text === undefined) return notFound(`log file ${file} not found`, "Only the RM's own logs are readable here.");
  const bytes = new TextEncoder().encode(text);
  const size = bytes.length;
  const tail = Number(url.searchParams.get("tail") ?? NaN);
  let start = Number(url.searchParams.get("offset") ?? 0);
  let length = Number(url.searchParams.get("length") ?? NaN);
  if (Number.isFinite(tail) && tail > 0) {
    start = Math.max(0, size - tail);
    length = size - start;
  }
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(length) || length <= 0) length = Math.min(128 * 1024, size - start);
  start = Math.min(start, size);
  const end = Math.min(size, start + length);
  // Jetty answers a byte Range with 206 + content-range (verified against the live RM by BackendCore2), so the mock does too.
  return new Response(bytes.subarray(start, end), {
    status: start === 0 && end === size ? 200 : 206,
    headers: {
      ...TEXT_HEADERS,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end === start ? start : end - 1}/${size}`,
      "x-burrow-log-size": String(size),
      "x-burrow-log-start": String(start),
      "x-burrow-log-end": String(end),
      "x-burrow-log-source": "rm",
    },
  });
}

export async function handleTools(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\//, "");
  const seg = path.split("/");

  if (path === "rm/conf") return confResponse(url);
  if (path === "rm/jmx") return jmxResponse(url);
  if (path === "rm/stacks") return new Response(STACKS_TEXT, { status: 200, headers: TEXT_HEADERS });
  if (path === "rm/logs") return json(logsListing);
  if (seg[0] === "rm" && seg[1] === "logs" && seg.length === 3) {
    return logRange(url, decodeURIComponent(seg[2] ?? ""));
  }
  return null;
}
