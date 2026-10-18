/**
 * Unit tests for the thread-dump parser, over the REAL captured `RM /stacks` payload (167 KB, 230 threads).
 *
 * The exact counts are the contract: the legacy UI shows the same 230 threads and the same state histogram, so a parser
 * regression must fail here, not silently in the browser. Edge cases (missing Stack section, no frames, odd whitespace,
 * lock sections, truncated input) use small synthetic snippets — the captured dump has no BLOCKED thread and no
 * "Locked ownable synchronizers" section, so those paths can only be exercised synthetically.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dumpToText, frameText, parseStackFrame, parseThreadDump, searchThreads, stateHistogram, threadToText } from "./stacks";

// The fixture lives outside the web root (`fixtures/` at the repo root) and Vite's fs.allow denies `?raw` there, so it is
// read like `dev/mock-tools.ts` does: from disk, at test time.
const stacksFixture = readFileSync(resolve(process.cwd(), "../fixtures/rm/tools/stacks.txt"), "utf8");

const dump = parseThreadDump(stacksFixture);

describe("real RM thread dump", () => {
  it("reads the header", () => {
    expect(dump.process).toBe("");
    expect(dump.active).toBe(230);
  });

  it("finds exactly 230 threads with unique ids", () => {
    expect(dump.threads).toHaveLength(230);
    expect(new Set(dump.threads.map((t) => t.id)).size).toBe(230);
    expect(dump.threads[0]).toMatchObject({ id: 2, name: "Reference Handler", state: "RUNNABLE", blocked: 3, waited: 0 });
  });

  it("reproduces the true state histogram (TIMED_WAITING 186, RUNNABLE 26, WAITING 18)", () => {
    const hist = stateHistogram(dump.threads);
    expect(hist).toEqual([
      { state: "TIMED_WAITING", count: 186 },
      { state: "RUNNABLE", count: 26 },
      { state: "WAITING", count: 18 },
    ]);
    expect(dump.threads.every((t) => t.state !== "")).toBe(true);
  });

  it("parses frames with class, method, file and line", () => {
    const ref = dump.threads[0];
    expect(ref?.frames).toHaveLength(3);
    expect(ref?.frames[0]).toEqual({
      className: "java.lang.ref.Reference",
      method: "waitForReferencePendingList",
      native: true,
      module: "java.base@17.0.20.1",
      raw: "java.base@17.0.20.1/java.lang.ref.Reference.waitForReferencePendingList(Native Method)",
    });
    expect(ref?.frames[1]).toMatchObject({
      className: "java.lang.ref.Reference",
      method: "processPendingReferences",
      file: "Reference.java",
      line: 253,
      native: false,
    });
    expect(ref?.frames.every((f) => f.module === "java.base@17.0.20.1")).toBe(true);
  });

  it("keeps `app` frames and threads with no frames", () => {
    const jetty = dump.threads.find((t) => t.frames.some((f) => f.module === "app"));
    expect(jetty).toBeDefined();
    const empty = dump.threads.find((t) => t.frames.length === 0);
    expect(empty).toMatchObject({ id: 4, name: "Signal Dispatcher", state: "RUNNABLE" });
  });

  it("keeps the 18 locks the JVM reported in `Waiting on`", () => {
    expect(dump.threads.filter((t) => t.waitingOn).length).toBe(18);
    expect(dump.threads.find((t) => t.id === 3)?.waitingOn).toBe("java.lang.ref.ReferenceQueue$Lock@73af089d");
    expect(dump.threads.every((t) => t.locks.length === 0)).toBe(true);
  });

  it("sums blocked and waited counts", () => {
    const blocked = dump.threads.reduce((a, t) => a + t.blocked, 0);
    const waited = dump.threads.reduce((a, t) => a + t.waited, 0);
    expect(blocked).toBeGreaterThan(0);
    expect(waited).toBeGreaterThan(blocked);
  });

  it("round-trips a thread block through threadToText", () => {
    const thread = dump.threads[1];
    expect(thread).toBeDefined();
    const text = threadToText(thread as NonNullable<typeof thread>);
    expect(text.split("\n")[0]).toBe("Thread 3 (Finalizer):");
    expect(text).toContain("  Waiting on java.lang.ref.ReferenceQueue$Lock@73af089d");
    expect(text).toContain("    java.base@17.0.20.1/java.lang.Object.wait(Native Method)");
    expect(parseThreadDump(text).threads[0]?.waitingOn).toBe(thread?.waitingOn);
  });

  it("dumpToText reproduces a parseable dump with the same thread count", () => {
    expect(parseThreadDump(dumpToText(dump)).threads).toHaveLength(230);
  });
});

describe("edge cases", () => {
  it("tolerates a missing Stack section and no frames", () => {
    const text = [
      "Process Thread Dump: rm",
      "1 active threads",
      "Thread 7 (idle):",
      "  State: WAITING",
      "  Blocked count: 0",
      "  Waited count: 0",
    ].join("\n");
    const parsed = parseThreadDump(text);
    expect(parsed.process).toBe("rm");
    expect(parsed.active).toBe(1);
    expect(parsed.threads[0]).toMatchObject({ id: 7, name: "idle", state: "WAITING", frames: [] });
  });

  it("ignores extra blank lines and leading/trailing whitespace", () => {
    const text = [
      "",
      "  Process Thread Dump:   test rm  ",
      "",
      "  2 active threads",
      "",
      "Thread 1 (main):",
      "  State: RUNNABLE",
      "  Blocked count: 1",
      "  Waited count: 2",
      "  Stack:",
      "",
      "    app//org.example.Main.main(Main.java:12)",
      "",
      "",
      "Thread 9 (worker):",
      "  State: BLOCKED",
      "  Blocked count: 5",
      "  Waited count: 0",
      "  Waiting on java.util.concurrent.locks.ReentrantLock$NonfairSync@abc",
      "  Stack:",
      "    app//org.example.Worker.run(Worker.java:99)",
      "  Locked ownable synchronizers:",
      "    - None",
      "",
    ].join("\n");
    const parsed = parseThreadDump(text);
    expect(parsed.process).toBe("test rm");
    expect(parsed.active).toBe(2);
    expect(parsed.threads).toHaveLength(2);
    expect(parsed.threads[0]).toMatchObject({ id: 1, state: "RUNNABLE", blocked: 1, waited: 2 });
    expect(parsed.threads[0]?.frames).toHaveLength(1);
    expect(parsed.threads[1]).toMatchObject({
      id: 9,
      state: "BLOCKED",
      waitingOn: "java.util.concurrent.locks.ReentrantLock$NonfairSync@abc",
      locks: [],
    });
  });

  it("collects Locked ownable synchronizers and drops `- None`", () => {
    const text = [
      "2 active threads",
      "Thread 1 (a):",
      "  State: RUNNABLE",
      "  Locked ownable synchronizers:",
      "    - None",
      "Thread 2 (b):",
      "  State: RUNNABLE",
      "  Locked ownable synchronizers:",
      "    - <0x00000007c0a0a0a0> (a java.lang.Object)",
      "    - <0x00000007c0a0a0b0> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)",
    ].join("\n");
    const parsed = parseThreadDump(text);
    expect(parsed.threads[0]?.locks).toEqual([]);
    expect(parsed.threads[1]?.locks).toEqual([
      "<0x00000007c0a0a0a0> (a java.lang.Object)",
      "<0x00000007c0a0a0b0> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)",
    ]);
    expect(threadToText(parsed.threads[1] as NonNullable<(typeof parsed.threads)[1]>)).toContain("  Locked ownable synchronizers:");
  });

  it("returns nothing for empty or junk input", () => {
    expect(parseThreadDump("")).toEqual({ process: "", active: null, threads: [] });
    expect(parseThreadDump("total garbage\nwith no threads").threads).toEqual([]);
  });

  it("parses the frame shapes the JVM actually prints", () => {
    expect(parseStackFrame("    java.base@17.0.20.1/java.lang.Thread.run(Thread.java:840)")).toMatchObject({
      className: "java.lang.Thread",
      method: "run",
      file: "Thread.java",
      line: 840,
    });
    expect(parseStackFrame("    app//org.example.Foo.lambda$run$0(Foo.java:1)")).toMatchObject({
      module: "app",
      className: "org.example.Foo",
      method: "lambda$run$0",
    });
    expect(parseStackFrame("    com.example.Anything.<init>(Unknown Source)")).toMatchObject({
      className: "com.example.Anything",
      method: "<init>",
      file: "Unknown Source",
      native: false,
    });
    expect(parseStackFrame("    com.example.Native.frob(Native Method)").native).toBe(true);
    expect(parseStackFrame("    no-dots-here(Weird)")).toMatchObject({ className: "no-dots-here", method: "" });
  });

  it("renders frames back to their canonical text", () => {
    expect(frameText(parseStackFrame("    java.base@17.0.20.1/java.lang.Object.wait(Native Method)"))).toBe(
      "java.base@17.0.20.1/java.lang.Object.wait(Native Method)",
    );
    expect(frameText(parseStackFrame("    app//org.example.Main.main(Main.java:12)"))).toBe("app/org.example.Main.main(Main.java:12)");
  });
});

describe("search", () => {
  it("matches the thread name and returns every thread for an empty query", () => {
    expect(searchThreads(dump.threads, "")).toHaveLength(230);
    const hits = searchThreads(dump.threads, "Reference Handler");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.thread.id).toBe(2);
    expect(hits[0]?.frames).toEqual([]);
  });

  it("matches frames and reports their indices", () => {
    const hits = searchThreads(dump.threads, "CallQueueManager");
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.frames.length).toBeGreaterThan(0);
      for (const i of hit.frames)
        expect(frameText(hit.thread.frames[i] as NonNullable<(typeof hit.thread.frames)[number]>)).toContain("CallQueueManager");
    }
  });

  it("matches thread ids and is case-insensitive", () => {
    expect(searchThreads(dump.threads, "2").some((h) => h.thread.id === 2)).toBe(true);
    expect(searchThreads(dump.threads, "reference handler")).toHaveLength(1);
  });
});
