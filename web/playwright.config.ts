import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (`bun run e2e`).
 *
 * Playwright builds the app and serves ONE origin with `BURROW_WEB_TARGET=dist`: the real production build plus the
 * mock API, which is what the Rust binary does (same-origin SPA + /api). Set `PW_BASE_URL` to point at a real burrow
 * (or an already-running `bun run dev:mock`) and Playwright will reuse it instead of starting its own.
 */
const PORT = Number(process.env.PW_PORT ?? 5273);
const BASE_URL = process.env.PW_BASE_URL ?? `http://127.0.0.1:${PORT}`;
// Keep the id when Playwright loads this config again in workers, and isolate simultaneous invocations.
const RUN_ID = process.env.PW_RUN_ID ?? String(process.pid);
process.env.PW_RUN_ID = RUN_ID;
const BUILD_DIR = resolve(process.env.PW_WEB_DIR ?? `.e2e-dist/${RUN_ID}`);
const DAG_FRAME_BUDGET = /300-node DAG with live progress updates stays inside the frame budget/;

export default defineConfig({
  testDir: "e2e",
  outputDir: process.env.PW_OUTPUT_DIR ?? `test-results/${RUN_ID}`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Fixture pages can mount thousands of rows or hundreds of SVG nodes. Keep local runs from exhausting Chromium
  // resources and distorting the frame-budget checks; callers can still override with PW_WORKERS or --workers.
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 2,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.02 },
  },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  snapshotDir: process.env.PW_SNAPSHOT_DIR ?? "e2e/__screenshots__",
  snapshotPathTemplate: "{snapshotDir}/{arg}{ext}",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    video: "off",
    bypassCSP: true,
    viewport: { width: 1440, height: 900 },
    timezoneId: "UTC",
    locale: "en-US",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /overview-hydration\.spec\.ts/,
      grepInvert: DAG_FRAME_BUDGET,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The 300-node frame sample is meaningful only without another large browser workload rendering at the same time.
      // Run it after the normal Chromium suite in its own single-worker project, rather than racing the 366-DAG corpus.
      name: "chromium-frame-budget",
      testMatch: /dag\/dag\.spec\.ts$/,
      grep: DAG_FRAME_BUDGET,
      dependencies: ["chromium"],
      workers: 1,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // This regression only reproduced in Firefox-family browsers. Keep the targeted test in Firefox without
      // running the whole suite there.
      name: "firefox",
      testMatch: /(?:overview-hydration|tools-scroll)\.spec\.ts/,
      dependencies: ["chromium-frame-budget"],
      use: { ...devices["Desktop Firefox"] },
    },
  ],
  webServer: process.env.PW_BASE_URL
    ? undefined
    : {
        command: "bun run build && bun run dev:mock",
        env: {
          BURROW_BUILD_DIR: BUILD_DIR,
          BURROW_WEB_ROOT: resolve(BUILD_DIR, "client"),
          BURROW_WEB_TARGET: "dist",
          MOCK_PORT: String(PORT),
          MOCK_FROZEN: process.env.CI ? "1" : "0",
          MOCK_NO_NEW_APPS: "1",
        },
        url: `${BASE_URL}/api/healthz`,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "pipe",
      },
});
