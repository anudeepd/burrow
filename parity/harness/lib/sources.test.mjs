import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUpstream } from "./sources.mjs";

describe("recorded upstream selection", () => {
  it("replays the requested capture index without overwriting it from sibling indexes", async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "burrow-replay-"));
    const upstreamDir = path.join(fixtureDir, "scenario", "upstream");
    fs.mkdirSync(upstreamDir, { recursive: true });
    const url = "http://rm:8088/ws/v1/cluster/metrics";

    for (const [index, marker] of [
      ["index.json", "main"],
      ["index-wire-direct.json", "direct"],
      ["index-wire-ours.json", "ours"],
    ]) {
      const file = `${marker}.json`;
      fs.writeFileSync(path.join(upstreamDir, file), JSON.stringify({ marker }));
      fs.writeFileSync(
        path.join(upstreamDir, index),
        JSON.stringify({ entries: [{ url, status: 200, headers: {}, file }] }),
      );
    }

    try {
      for (const [label, expected] of [[undefined, "main"], ["wire-direct", "direct"], ["wire-ours", "ours"]]) {
        const source = await createUpstream({ mode: "replay", fixtureDir, scenarioId: "scenario", label });
        expect((await source.get(url)).json).toEqual({ marker: expected });
      }
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
