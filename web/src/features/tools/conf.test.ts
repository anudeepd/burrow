/**
 * Unit tests for the configuration helpers, run against the REAL captured RM configuration
 * (`fixtures/rm/tools/conf.json`, 205 KB / 1 709 properties) through the production schema.
 *
 * Counts are asserted as exact numbers on purpose: the capture is frozen, so any drift means either the helper or the
 * schema changed meaning.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfResponseSchema } from "~/api/schemas";
import {
  confMatches,
  confRowVersion,
  isOverridden,
  isRedacted,
  lineCount,
  NO_VIEW,
  REDACTED,
  resourceFacets,
  resourceKind,
  resourceName,
  summarizeConf,
  usedIn,
} from "./conf";

// The fixtures live outside the web/ root, so they are read from disk rather than imported as assets.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/rm/tools");
const readFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const parsed = ConfResponseSchema.parse(readFixture("conf.json"));
const properties = parsed.properties;
const byKey = new Map(properties.map((p) => [p.key, p]));

describe("the captured RM configuration", () => {
  it("parses all 1 709 properties with the production schema", () => {
    expect(properties).toHaveLength(1709);
    expect(byKey.size).toBe(1709);
  });

  it("classifies resources and counts them (77 overridden, 2 final, 2 redacted, 9 sources)", () => {
    expect(summarizeConf(properties)).toEqual({ total: 1709, overridden: 77, final: 2, redacted: 2, sources: 9 });
  });

  it("lists the distinct resources most-populated first", () => {
    const facets = resourceFacets(properties);
    expect(facets).toHaveLength(9);
    expect(facets.slice(0, 4).map((f) => [f.value, f.count])).toEqual([
      ["hdfs-default.xml", 535],
      ["yarn-default.xml", 482],
      ["core-default.xml", 351],
      ["mapred-default.xml", 182],
    ]);
    expect(facets.reduce((sum, f) => sum + f.count, 0)).toBe(1709);
    expect(facets.find((f) => f.value === "programmatically")).toEqual({ value: "programmatically", count: 11, kind: "programmatic" });
  });

  it("marks exactly the site-file and programmatic properties as overridden", () => {
    const overridden = properties.filter(isOverridden);
    expect(overridden).toHaveLength(77);
    expect(overridden.every((p) => /-site\.xml$/.test(resourceName(p)) || p.resource === "programmatically")).toBe(true);
    // an overridden key really is a *site* value, a default one really is not
    expect(isOverridden(byKey.get("yarn.nodemanager.resource.memory-mb")!)).toBe(true);
    expect(isOverridden(byKey.get("yarn.nodemanager.local-dirs")!)).toBe(false);
  });

  it("finds the two <final> properties and the two redacted ones", () => {
    expect(properties.filter((p) => p.isFinal).map((p) => p.key)).toEqual([
      "mapreduce.job.end-notification.max.attempts",
      "mapreduce.job.end-notification.max.retry.interval",
    ]);
    const redacted = properties.filter(isRedacted);
    expect(redacted.map((p) => p.value)).toEqual([REDACTED, REDACTED]);
    expect(redacted.map((p) => p.key)).toEqual(["fs.adl.oauth2.access.token.provider.type", "hadoop.security.sensitive-config-keys"]);
  });

  it("keeps multi-line values byte-for-byte", () => {
    const multiline = byKey.get("fs.s3a.aws.credentials.provider");
    expect(multiline).toBeDefined();
    expect(lineCount(multiline!.value)).toBe(6);
    expect(multiline!.value?.startsWith("\n")).toBe(true);
  });
});

describe("input handling", () => {
  it("accepts ConfServlet's single-property shape (?name=<key>)", () => {
    const one = ConfResponseSchema.parse(readFixture("conf-one.json"));
    expect(one.properties).toHaveLength(1);
    expect(one.properties[0]?.key).toBe("yarn.resourcemanager.webapp.address");
    expect(one.properties[0]?.resource).toBe("yarn-site.xml");
  });

  it("reads an empty dump as no properties and rejects rubbish", () => {
    // Hadoop omits an empty collection entirely, so `{}` is a valid (empty) dump — the page then shows its empty state.
    expect(ConfResponseSchema.parse({}).properties).toEqual([]);
    expect(() => ConfResponseSchema.parse({ properties: [{ key: "only-a-key" }] })).toThrow();
    expect(() => ConfResponseSchema.parse({ properties: "nope" })).toThrow();
  });

  it("rejects an unknown property key in strict mode (the P1 no-key-left-behind gate)", () => {
    expect(() =>
      ConfResponseSchema.parse({ properties: [{ key: "a", value: "b", isFinal: false, resource: "yarn-site.xml", surprise: 1 }] }),
    ).toThrow();
  });

  it("accepts a missing resource and a null value without inventing one", () => {
    const r = ConfResponseSchema.parse({ properties: [{ key: "k", value: null, isFinal: "true" }] });
    expect(r.properties[0]).toEqual({ key: "k", value: null, isFinal: true, resource: undefined });
    expect(resourceName(r.properties[0]!)).toBe("Unknown");
    expect(resourceKind(r.properties[0]!.resource)).toBe("unknown");
    expect(isOverridden(r.properties[0]!)).toBe(false);
    expect(isRedacted(r.properties[0]!)).toBe(false);
    expect(confRowVersion(r.properties[0]!)).toBe("true:");
  });
});

describe("filtering", () => {
  it("matches the key or the value, case-insensitively", () => {
    expect(properties.filter((p) => confMatches(p, { q: "YARN.RESOURCEMANAGER.WEBAPP.ADDRESS" })).map((p) => p.key)).toEqual([
      "yarn.resourcemanager.webapp.address",
    ]);
    expect(properties.filter((p) => confMatches(p, { q: "mapreduce_shuffle" })).map((p) => p.key)).toEqual([
      "yarn.nodemanager.aux-services",
      "yarn.nodemanager.aux-services.mapreduce_shuffle.class",
    ]);
    // a value-only match: the RM's own class name appears in no key
    expect(properties.filter((p) => confMatches(p, { q: "CapacityScheduler" })).map((p) => p.key)).toEqual([
      "yarn.resourcemanager.scheduler.class",
    ]);
  });

  it("filters by overridden, final and resource together", () => {
    expect(properties.filter((p) => confMatches(p, { overridden: true }))).toHaveLength(77);
    expect(properties.filter((p) => confMatches(p, { final: true }))).toHaveLength(2);
    expect(properties.filter((p) => confMatches(p, { resource: "yarn-site.xml" }))).toHaveLength(40);
    expect(properties.filter((p) => confMatches(p, { resource: "yarn-site.xml", overridden: true }))).toHaveLength(40);
    expect(properties.filter((p) => confMatches(p, { resource: "Unknown" }))).toHaveLength(0);
    expect(properties.filter((p) => confMatches(p, { overridden: true, final: true }))).toHaveLength(0);
  });

  it("treats a blank or whitespace query as no filter", () => {
    expect(properties.filter((p) => confMatches(p, { q: "   " }))).toHaveLength(1709);
  });
});

describe("resource kinds", () => {
  it.each([
    ["yarn-site.xml", "site"],
    ["core-site.xml", "site"],
    ["yarn-default.xml", "default"],
    ["hdfs-rbf-default.xml", "default"],
    ["programmatically", "programmatic"],
    ["Unknown", "unknown"],
    ["", "unknown"],
    [undefined, "unknown"],
    ["weird.txt", "unknown"],
  ] as const)("%s → %s", (resource, kind) => {
    expect(resourceKind(resource)).toBe(kind);
  });
});

describe("used-in-the-UI map", () => {
  it("maps only real captured keys, to existing views", () => {
    const cases: [string, string | null][] = [
      ["yarn.resourcemanager.scheduler.class", "/scheduler"],
      ["yarn.scheduler.maximum-allocation-mb", "/scheduler"],
      ["yarn.scheduler.capacity.queue-mappings-override.enable", "/scheduler"],
      ["yarn.nodemanager.resource.memory-mb", "/nodes"],
      ["yarn.nodemanager.aux-services", "/nodes"],
      ["yarn.log-aggregation-enable", "/apps"],
      ["yarn.log.server.url", "/apps"],
      ["yarn.resourcemanager.webapp.address", null],
      ["yarn.resourcemanager.address", null],
      ["yarn.nodemanager.local-dirs", "/nodes"],
      ["dfs.block.invalidate.limit", null],
      ["fs.defaultFS", null],
      ["hadoop.security.sensitive-config-keys", null],
    ];
    for (const [key, to] of cases) {
      expect(byKey.has(key), `${key} must exist in the captured dump`).toBe(true);
      expect(usedIn(key)?.to ?? null, key).toBe(to);
    }
  });

  it("documents every claimed no-view key with a reason", () => {
    for (const [key, why] of Object.entries(NO_VIEW)) {
      expect(byKey.has(key), `${key} must exist in the captured dump`).toBe(true);
      expect(why.length).toBeGreaterThan(10);
      expect(usedIn(key)).toBeNull();
    }
  });

  it("explains the chip for a mapped key", () => {
    expect(usedIn("yarn.scheduler.maximum-allocation-mb")).toEqual({
      to: "/scheduler",
      label: "Scheduler",
      why: "queue capacities, allocation limits and application counts",
    });
  });
});
