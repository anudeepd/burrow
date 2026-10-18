/**
 * URL-state codec tests: the viewer's shareable state must round-trip exactly, and a bare `?tail` must not silently
 * turn follow on when the URL says `follow=0`. The JSON-typed cases are the ones that actually bit: TanStack Router
 * parses `?follow=1` to the NUMBER 1 and `?q=404` to the number 404, so a string-only schema made a pasted link fail
 * to render entirely.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TAIL_BYTES, followEnabled, logsSearchSchema, tailBytes, timestampMode } from "./search";

describe("tailBytes", () => {
  it("maps a bare flag to the default window", () => {
    expect(tailBytes(1)).toBe(DEFAULT_TAIL_BYTES);
  });
  it("takes a literal byte count and rejects nonsense", () => {
    expect(tailBytes(65536)).toBe(65536);
    expect(tailBytes(0)).toBeNull();
    expect(tailBytes(-5)).toBeNull();
    expect(tailBytes(undefined)).toBeNull();
  });
});

describe("followEnabled", () => {
  it("is off by default, on when asked", () => {
    expect(followEnabled(logsSearchSchema.parse({}))).toBe(false);
    expect(followEnabled(logsSearchSchema.parse({ follow: "1" }))).toBe(true);
  });
  it("is implied by a tail window", () => {
    expect(followEnabled(logsSearchSchema.parse({ tail: "1" }))).toBe(true);
  });
  it("can be explicitly disabled even with a tail", () => {
    expect(followEnabled(logsSearchSchema.parse({ tail: "1", follow: "0" }))).toBe(false);
  });
});

describe("timestampMode", () => {
  it("defaults to absolute", () => {
    expect(timestampMode(logsSearchSchema.parse({}))).toBe("absolute");
    expect(timestampMode(logsSearchSchema.parse({ ts: "relative" }))).toBe("relative");
  });
});

describe("JSON-typed values", () => {
  it("accepts numeric/boolean flag spellings", () => {
    expect(followEnabled(logsSearchSchema.parse({ follow: 1 }))).toBe(true);
    expect(followEnabled(logsSearchSchema.parse({ follow: 0, tail: 1 }))).toBe(false);
    expect(followEnabled(logsSearchSchema.parse({ tail: 1 }))).toBe(true);
    expect(logsSearchSchema.parse({ re: true }).re).toBe(true);
    expect(logsSearchSchema.parse({ wrap: 1 }).wrap).toBe(true);
  });
  it("accepts numeric tail counts and coerces numeric text params", () => {
    expect(tailBytes(logsSearchSchema.parse({ tail: 262144 }).tail)).toBe(262144);
    expect(logsSearchSchema.parse({ q: 404 }).q).toBe("404");
    expect(logsSearchSchema.parse({ container: 1 }).container).toBe("1");
    expect(logsSearchSchema.parse({ filter: 1 }).filter).toBe("1");
  });
  it("does not throw on a malformed enum", () => {
    expect(timestampMode(logsSearchSchema.parse({ ts: "sideways" }))).toBe("absolute");
  });
});
